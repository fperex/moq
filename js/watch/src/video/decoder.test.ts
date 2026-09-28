import { afterEach, beforeEach, expect, jest, spyOn, test } from "bun:test";
import { Container } from "@moq/hang";
import * as Catalog from "@moq/hang/catalog";
import * as Moq from "@moq/net";
import { Time } from "@moq/net";
import { type Effect, Signal } from "@moq/signals";
import type { Broadcast } from "../broadcast";
import { Sync } from "../sync";
import { Decoder } from "./decoder";
import type { Source } from "./source";

// WebCodecs is not in bun, and none of this needs a real codec: both cases are about what happens
// to the *subscription* when the track stops producing pictures.

/** One `VideoDecoder` the code under test built, with the chunks it was handed. */
type Built = {
	chunks: string[];
	timestamps: number[];
	/** Emit a decoded picture, which is what keeps the tile out of the stalled state. */
	emit(timestamp: number): void;
	/** Raise a codec error, the way a decoder does when it cannot decode what it was fed. */
	fail(error: Error): void;
};

let built: Built[] = [];

const real = {
	VideoDecoder: globalThis.VideoDecoder,
	EncodedVideoChunk: globalThis.EncodedVideoChunk,
};

beforeEach(() => {
	built = [];

	// Only advance() moves decoder recovery deadlines.
	jest.useFakeTimers();

	class FakeVideoFrame {
		readonly displayWidth = 16;
		readonly displayHeight = 16;
		readonly timestamp: number;
		closed = false;

		constructor(timestamp: number) {
			this.timestamp = timestamp;
		}

		clone(): FakeVideoFrame {
			return new FakeVideoFrame(this.timestamp);
		}
		close(): void {
			this.closed = true;
		}
	}

	class FakeVideoDecoder {
		state = "unconfigured";
		readonly #entry: Built;

		constructor(init: { output: (frame: unknown) => void; error: (error: Error) => void }) {
			this.#entry = {
				chunks: [],
				timestamps: [],
				emit: (timestamp: number) => init.output(new FakeVideoFrame(timestamp)),
				fail: (error: Error) => init.error(error),
			};
			built.push(this.#entry);
		}

		configure(): void {
			this.state = "configured";
		}

		decode(chunk: { type: string; timestamp: number }): void {
			this.#entry.chunks.push(chunk.type);
			this.#entry.timestamps.push(chunk.timestamp);
		}

		close(): void {
			this.state = "closed";
		}

		static isConfigSupported(): Promise<{ supported: boolean }> {
			return Promise.resolve({ supported: true });
		}
	}

	class FakeEncodedVideoChunk {
		readonly type: string;
		readonly timestamp: number;
		readonly byteLength: number;

		constructor(init: { type: string; timestamp: number; data: Uint8Array }) {
			this.type = init.type;
			this.timestamp = init.timestamp;
			this.byteLength = init.data.byteLength;
		}
	}

	globalThis.VideoDecoder = FakeVideoDecoder as unknown as typeof VideoDecoder;
	globalThis.EncodedVideoChunk = FakeEncodedVideoChunk as unknown as typeof EncodedVideoChunk;
});

afterEach(() => {
	jest.useRealTimers();
	globalThis.VideoDecoder = real.VideoDecoder;
	globalThis.EncodedVideoChunk = real.EncodedVideoChunk;
});

// setImmediate, not setTimeout: bun's fake timers take over every setTimeout, including one captured
// before they were installed, but leave setImmediate alone, so this still yields a real turn.
const flush = () => new Promise((resolve) => setImmediate(resolve));

/** Move the fake clock forward in small steps, letting the signal graph and the plumbing react. */
async function advance(ms: number, step = 25): Promise<void> {
	for (let elapsed = 0; elapsed < ms; elapsed += step) {
		jest.advanceTimersByTime(Math.min(step, ms - elapsed));
		await flush();
	}
}

async function settle(rounds = 10): Promise<void> {
	for (let i = 0; i < rounds; i++) await flush();
}

const TRACK = "video";
const payload = (n: number) => new Uint8Array(n).fill(1);

const CMAF_CONFIG = (() => {
	const base = Catalog.VideoConfigSchema.parse({
		codec: "avc1.640028",
		container: { kind: "legacy" },
		description: "01640028",
		codedWidth: 16,
		codedHeight: 16,
	});
	const init = Container.Cmaf.createVideoInitSegment(base);
	return Catalog.VideoConfigSchema.parse({
		...base,
		container: { kind: "cmaf", init: btoa(String.fromCharCode(...init)) },
	});
})();

type TestContainer = "legacy" | "cmaf";

function testConfig(container: TestContainer): Catalog.VideoConfig {
	return container === "cmaf"
		? CMAF_CONFIG
		: Catalog.VideoConfigSchema.parse({ codec: "avc1.640028", container: { kind: "legacy" } });
}

function writeTestFrame(
	container: TestContainer,
	group: Moq.Group.Producer,
	timestamp: Time.Micro,
	keyframe: boolean,
	sequence: number,
): void {
	let data: Uint8Array;
	if (container === "cmaf") {
		data = Container.Cmaf.encodeDataSegment({
			kind: "video",
			data: payload(1),
			timestamp,
			duration: 33_000,
			keyframe,
			sequence,
		});
	} else {
		const header = Moq.Varint.encode(timestamp);
		data = new Uint8Array(header.length + 1);
		data.set(header);
		data[header.length] = 1;
	}
	group.writeFrame({ payload: data, timestamp: Time.Timestamp.now() });
}

function finishTestGroup(container: TestContainer, group: Moq.Group.Producer, end: Time.Micro): void {
	if (container === "legacy") {
		group.writeFrame({ payload: Moq.Varint.encode(end), timestamp: Time.Timestamp.now() });
	}
	group.close();
}

/**
 * Keep the newest decoder producing pictures until the returned function is called.
 *
 * A tile with a picture is not stalled, so the stall watchdog never arms and a rebuild can only
 * have come from the codec error under test. The timestamp never advances, so nothing waits on the
 * playhead: this is about the stall flag, not about pacing.
 */
function heartbeat(): () => void {
	let stop = false;
	void (async () => {
		while (!stop) {
			built.at(-1)?.emit(0);
			await flush();
		}
	})();
	return () => {
		stop = true;
	};
}

/**
 * A track the test serves directly, recording every subscription the decoder opens on it.
 *
 * A broadcast answers a subscription from the tracks the application inserted, and a repeat
 * subscription fans out from the same producer, so the count of `subscribe` calls is what a
 * per-subscription request used to report.
 */
class ServedTrack extends Moq.Track.Producer {
	#log: string[];
	#label: string;

	constructor(name: string, log: string[], label = "") {
		super(name);
		this.#log = log;
		this.#label = label;
	}

	override subscribe(options?: Moq.Track.Subscription): Moq.Track.Subscriber {
		this.#log.push(this.#label ? `${this.#label}:${this.name}` : this.name);
		return super.subscribe(options);
	}
}

/** A live broadcast, a `Decoder` reading it, and every subscription it has raised. */
function fixture(config = testConfig("legacy")) {
	const broadcast = new Moq.Broadcast.Producer();
	const consumer = broadcast.consume();
	const source = {
		in: { broadcast: new Signal({ relativeBroadcast: () => consumer } as unknown as Broadcast) },
		out: {
			track: new Signal<string | undefined>(TRACK),
			config: new Signal<Catalog.VideoConfig | undefined>(config),
			catalog: new Signal<Catalog.VideoConfig | undefined>(undefined),
		},
	} as unknown as Source;

	const sync = new Sync({ delay: Time.Milli(100) });
	const decoder = new Decoder({ source, sync });

	// Serve the track directly. A rebuilt subscription opens a second one on the same producer, and
	// a stranded one never opens anything, which is what `subscriptions` counts.
	const opened: string[] = [];
	const track = new ServedTrack(TRACK, opened).accept({});
	broadcast.insertTrack(track);
	const served = [new Container.Legacy.Producer(track, new Container.Legacy.Format("video"))];

	return {
		served,
		broadcast,
		rendition: source.out.track as Signal<string | undefined>,
		decoder,
		sync,
		track,
		/** The rendition the catalog is offering, which a publisher hiding its camera takes away. */
		config: source.out.config as Signal<Catalog.VideoConfig | undefined>,
		/** Wait until `count` subscriptions have been opened, or give up. */
		async subscriptions(count: number): Promise<number> {
			for (let i = 0; i < 400 && opened.length < count; i++) await flush();
			return opened.length;
		},
		/** Advance the fake clock until `count` codecs have been built, or give up after `within` ms of it. */
		async decoders(count: number, within = 10_000): Promise<number> {
			for (let elapsed = 0; elapsed < within && built.length < count; elapsed += 25) await advance(25);
			return built.length;
		},
		close(): void {
			decoder.close();
			sync.close();
			broadcast.close();
		},
	};
}

test("video advances to a buffered keyframe when the audio playhead reaches it", async () => {
	const fx = fixture();
	try {
		expect(await fx.subscriptions(1)).toBe(1);
		const write = (group: Moq.Group.Producer, timestamp: number) => {
			const header = Moq.Varint.encode(timestamp);
			const payload = new Uint8Array(header.length + 1);
			payload.set(header);
			payload[header.length] = 1;
			group.writeFrame({ payload, timestamp: Time.Timestamp.fromMicros(Time.Micro(timestamp)) });
		};
		const first = fx.track.appendGroup();
		write(first, 0);
		await settle();
		expect(built[0].chunks).toEqual(["key"]);
		fx.sync.track("audio").clock.set({ timestamp: Time.Micro(1_900_000), reference: Time.Milli.now(), rate: 0 });
		const next = fx.track.appendGroup();
		write(next, 2_000_000);
		await settle();
		expect(built[0].chunks).toEqual(["key"]);
		fx.sync.track("audio").clock.set({ timestamp: Time.Micro(2_000_000), reference: Time.Milli.now(), rate: 0 });
		await settle();
		expect(built[0].chunks).toEqual(["key", "key"]);
		expect(fx.sync.out.clock.peek()).toBe("audio");
		built[0].emit(2_000_000);
		await settle();
		expect(fx.decoder.out.timestamp.peek()).toBe(Time.Milli(2_000));
	} finally {
		fx.close();
	}
});

for (const container of ["legacy", "cmaf"] as const) {
	test(`${container} video never submits an older GOP after live media`, async () => {
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		const fx = fixture(testConfig(container));
		const live = new Moq.Group.Producer(10);
		const old = new Moq.Group.Producer(5);
		const forward = new Moq.Group.Producer(11);
		try {
			expect(await fx.subscriptions(1)).toBe(1);
			fx.sync.track("audio").clock.set({
				timestamp: Time.Micro(10_000_000),
				reference: Time.Milli.now(),
				rate: 0,
			});

			fx.track.writeGroup(live);
			writeTestFrame(container, live, Time.Micro(10_000_000), true, 0);
			writeTestFrame(container, live, Time.Micro(10_033_000), false, 1);
			await settle();

			// Warm-cache groups can arrive below the group already submitted to WebCodecs.
			fx.track.writeGroup(old);
			writeTestFrame(container, old, Time.Micro(5_000_000), true, 2);
			await settle();

			old.close();
			finishTestGroup(container, live, Time.Micro(10_066_000));

			fx.track.writeGroup(forward);
			writeTestFrame(container, forward, Time.Micro(10_066_000), true, 3);
			writeTestFrame(container, forward, Time.Micro(10_099_000), false, 4);
			forward.close();
			await settle();

			expect(built[0].timestamps).not.toContain(5_000_000);
			expect(built[0].timestamps.slice(-2)).toEqual([10_066_000, 10_099_000]);
			expect(built[0].chunks.slice(-2)).toEqual(["key", "delta"]);
		} finally {
			old.close();
			live.close();
			forward.close();
			fx.close();
			warn.mockRestore();
		}
	});
}

test("historical age loss does not erase the live GOP", async () => {
	const warn = spyOn(console, "warn").mockImplementation(() => {});
	const fx = fixture();
	const live = new Moq.Group.Producer(10);
	const old = new Moq.Group.Producer(5);
	const expired = new Moq.Group.Producer(4);
	try {
		expect(await fx.subscriptions(1)).toBe(1);
		fx.sync.track("audio").clock.set({
			timestamp: Time.Micro(10_000_000),
			reference: Time.Milli.now(),
			rate: 0,
		});

		fx.track.writeGroup(live);
		writeTestFrame("legacy", live, Time.Micro(10_000_000), true, 0);
		writeTestFrame("legacy", live, Time.Micro(10_033_000), false, 1);
		await settle();

		fx.track.writeGroup(old);
		writeTestFrame("legacy", old, Time.Micro(5_000_000), true, 2);
		await settle();
		fx.track.writeGroup(expired);
		writeTestFrame("legacy", expired, Time.Micro(4_000_000), true, 3);
		await settle();
		expired.close();
		old.close();

		writeTestFrame("legacy", live, Time.Micro(10_066_000), false, 4);
		writeTestFrame("legacy", live, Time.Micro(10_100_000), false, 5);
		await settle();

		expect(built[0].timestamps).toEqual([10_000_000, 10_033_000, 10_066_000, 10_100_000]);
		expect(built[0].chunks).toEqual(["key", "delta", "delta", "delta"]);
	} finally {
		expired.close();
		old.close();
		live.close();
		fx.close();
		warn.mockRestore();
	}
});

test("a declared marker still resets video when its group arrives behind live media", async () => {
	const fx = fixture();
	const live = new Moq.Group.Producer(10);
	const marker = new Moq.Group.Producer(6);
	const old = new Moq.Group.Producer(5);
	try {
		expect(await fx.subscriptions(1)).toBe(1);
		fx.track.writeGroup(live);
		writeTestFrame("legacy", live, Time.Micro(10_000_000), true, 0);
		writeTestFrame("legacy", live, Time.Micro(10_033_000), false, 1);
		await settle();
		expect(fx.sync.out.reference.peek()).toBeDefined();

		fx.track.writeGroup(marker);
		marker.writeFrame({ payload: Moq.Varint.encode(Time.Micro(5_033_000)), timestamp: Time.Timestamp.now() });
		await settle();
		fx.track.writeGroup(old);
		writeTestFrame("legacy", old, Time.Micro(5_000_000), true, 2);
		old.close();
		await settle();
		marker.close();
		await settle();

		expect(fx.sync.out.reference.peek()).toBeUndefined();
	} finally {
		old.close();
		live.close();
		marker.close();
		fx.close();
	}
});

test("a forward discontinuity waits for the next keyframe", async () => {
	type Next = NonNullable<Awaited<ReturnType<Container.Consumer["next"]>>>;
	const frame = (
		group: number,
		timestamp: number,
		keyframe: boolean,
		discontinuity: number,
		continuous: boolean,
	): Next => ({
		group,
		discontinuity,
		continuous,
		frame: { payload: payload(1), timestamp: Time.Micro(timestamp), keyframe },
	});
	const results: Next[] = [
		frame(10, 10_000_000, true, 0, false),
		frame(10, 10_033_000, false, 0, true),
		frame(11, 10_066_000, false, 1, false),
		frame(11, 10_099_000, true, 1, true),
		frame(11, 10_132_000, false, 1, true),
	];
	const read = spyOn(Container.Consumer.prototype, "next").mockImplementation(async () => results.shift());
	const fx = fixture();
	try {
		await settle();
		expect(built[0].timestamps).toEqual([10_000_000, 10_033_000, 10_099_000, 10_132_000]);
	} finally {
		fx.close();
		read.mockRestore();
	}
});

test("late backlog cannot replace the picture shown before clock catch-up", async () => {
	const fx = fixture();
	try {
		expect(await fx.subscriptions(1)).toBe(1);
		fx.served[0].encode(payload(16), Time.Micro(2_000_000), true);
		await settle();
		fx.sync.track("audio").clock.set({ timestamp: Time.Micro(1_000_000), reference: Time.Milli.now(), rate: 0 });
		await settle();
		built[0].emit(2_000_000);
		await settle();
		expect(fx.decoder.out.frame.peek()?.timestamp).toBe(2_000_000);
		built[0].emit(1_000_000);
		await settle();
		expect(fx.decoder.out.frame.peek()?.timestamp).toBe(2_000_000);
	} finally {
		fx.close();
	}
});

test("a codec error rebuilds the track instead of stranding the subscription", async () => {
	const warn = console.warn;
	console.warn = () => {};
	const fx = fixture();
	try {
		expect(await fx.subscriptions(1)).toBe(1);

		const beating = heartbeat();
		try {
			fx.served[0].encode(payload(16), Time.Micro(0), true);
			await settle();
			expect(built).toHaveLength(1);
			expect(built[0].chunks).toEqual(["key"]);
			expect(fx.decoder.out.stalled.peek()).toBe(false);

			// The codec gives up. This used to close the whole DecoderTrack effect, the subscription
			// with it, while `#active` kept pointing at the corpse: the relay saw the subscription
			// cancelled, never saw another, and the tile stalled for good while audio kept playing.
			built[0].fail(new Error("DataError"));

			// A replacement track, with its own subscription and its own codec, rather than a dead
			// one left in place. Within 2s: past RETRY, well short of the stall watchdog's
			// BUFFERING + RECOVER, so only the codec error can have caused it.
			expect(await fx.decoders(2, 2_000)).toBeGreaterThanOrEqual(2);

			fx.served[0].encode(payload(16), Time.Micro(1_000_000), true);
			await settle();
			expect(built.at(-1)?.chunks).toContain("key");
		} finally {
			beating();
		}
	} finally {
		fx.close();
		console.warn = warn;
	}
});

test("a picture frozen past the recovery window rebuilds the track", async () => {
	const warn = console.warn;
	console.warn = () => {};
	const fx = fixture();
	try {
		expect(await fx.subscriptions(1)).toBe(1);

		fx.served[0].encode(payload(16), Time.Micro(0), true);
		await settle();
		built[0].emit(0);
		await settle();
		expect(built).toHaveLength(1);

		// Nothing more arrives. The 500ms watchdog only ever labelled this a stall; now it is acted
		// on, so the track is replaced rather than left frozen with the last picture.
		expect(await fx.decoders(2)).toBeGreaterThanOrEqual(2);
		expect(fx.decoder.out.stalled.peek()).toBe(true);

		fx.served[0].encode(payload(16), Time.Micro(2_000_000), true);
		await settle();
		expect(built.at(-1)?.chunks).toContain("key");
	} finally {
		fx.close();
		console.warn = warn;
	}
});

test("the arrival estimator survives a rebuild", async () => {
	const warn = console.warn;
	console.warn = () => {};
	const fx = fixture();
	const seen: (number | undefined)[] = [];
	const dispose = fx.decoder.out.spread.subscribe((value) => seen.push(value));
	try {
		expect(await fx.subscriptions(1)).toBe(1);
		expect(fx.decoder.out.spread.peek()).toBeDefined();

		fx.served[0].encode(payload(16), Time.Micro(0), true);
		await settle();
		built[0].emit(0);
		await settle();

		// The stall watchdog replaces the track. The measurement belongs to the rendition, not to
		// the subscription: dropping it here handed Sync a delay sized for a path nobody is on, so
		// the shared delay collapsed to whatever audio had measured and the replacement was
		// convicted by a budget the picture could never meet.
		expect(await fx.decoders(2)).toBeGreaterThanOrEqual(2);
		expect(seen).not.toContain(undefined);
		expect(fx.decoder.out.spread.peek()).toBeDefined();
	} finally {
		dispose();
		fx.close();
		console.warn = warn;
	}
});

test("the arrival estimator survives the rendition leaving the catalog and coming back", async () => {
	// A publisher hiding its camera takes the rendition out of the catalog for a few hundred
	// milliseconds and then puts the same one back. That is a gap in one rendition, not a new one:
	// the path and the publisher's claim about it are unchanged, so what was measured on it still
	// holds. Building a fresh estimator there republishes the 80ms guess as though something had
	// measured it, and Sync holds every track to the widest reading, so the audio ring is resized
	// mid-playback and runs dry. Three of five watchers on the bench took an underrun from it.
	const warn = console.warn;
	console.warn = () => {};
	const fx = fixture();
	const rendition = fx.config.peek();
	try {
		expect(await fx.subscriptions(1)).toBe(1);

		// A prompt pair sets the arrival baseline, then one 600ms later closes the estimator's
		// first resample interval, which is what replaces the declaration with a measurement.
		const beating = heartbeat();
		try {
			fx.served[0].encode(payload(16), Time.Micro(0), true);
			fx.served[0].encode(payload(16), Time.Micro(20_000), false);
			await advance(600);
			fx.served[0].encode(payload(16), Time.Micro(40_000), false);
			await settle();

			const measured = fx.decoder.out.spread.peek();
			expect(measured).toBeDefined();
			expect(measured).toBeLessThan(80 as Time.Milli);

			// The camera goes. A departed track must stop holding the buffer open.
			fx.config.set(undefined);
			await settle();
			expect(fx.decoder.out.spread.peek()).toBeUndefined();

			// And comes back as the same rendition, with the measurement it left behind.
			fx.config.set(rendition);
			await settle();
			expect(fx.decoder.out.spread.peek()).toBe(measured);
		} finally {
			beating();
		}
	} finally {
		fx.close();
		console.warn = warn;
	}
});

test("a replaced session re-subscribes to video", async () => {
	// A reconnect swaps the broadcast consumer under the decoder. Audio re-subscribes because its
	// whole subscription lives in one effect that reads the handle; video has to do the same or
	// the tile stays frozen while the sound comes back, which is what the relay log of a restart
	// showed: catalog, meta and audio re-subscribed, video never asked again.
	const first = new Moq.Broadcast.Producer();
	const handle = new Signal<Moq.Broadcast.Consumer>(first.consume());

	const source = {
		in: {
			broadcast: new Signal({
				relativeBroadcast: (effect: Effect) => effect.get(handle),
			} as unknown as Broadcast),
		},
		out: {
			track: new Signal<string | undefined>(TRACK),
			config: new Signal<Catalog.VideoConfig | undefined>(
				Catalog.VideoConfigSchema.parse({ codec: "avc1.640028", container: { kind: "legacy" } }),
			),
			catalog: new Signal<Catalog.VideoConfig | undefined>(undefined),
		},
	} as unknown as Source;

	const sync = new Sync({ delay: Time.Milli(100) });
	const decoder = new Decoder({ source, sync });

	const requests: string[] = [];
	const serve = (producer: Moq.Broadcast.Producer, label: string) =>
		producer.insertTrack(new ServedTrack(TRACK, requests, label).accept({}));

	const second = new Moq.Broadcast.Producer();
	serve(first, "first");
	serve(second, "second");

	try {
		for (let i = 0; i < 400 && requests.length < 1; i++) await flush();
		expect(requests).toEqual([`first:${TRACK}`]);

		// The session is replaced, exactly as a reconnect replaces it.
		first.close();
		handle.set(second.consume());

		for (let i = 0; i < 400 && requests.length < 2; i++) await flush();
		expect(requests).toEqual([`first:${TRACK}`, `second:${TRACK}`]);
	} finally {
		decoder.close();
		sync.close();
		first.close();
		second.close();
	}
});

test("a republished broadcast re-anchors the clock", async () => {
	// A pinned element follows a publisher restart in place: the broadcast consumer underneath it
	// is replaced and the new encoder's timeline starts where it likes, which is near zero. A clock
	// still anchored to the dead publisher holds every one of those pictures behind a reference
	// they can never reach, and a republish declares no discontinuity, so nothing else lets go of
	// it. A rendition swap is the opposite case and keeps the reference: see the audio decoder's
	// "a replacement subscription on the same broadcast keeps the timeline it is playing".
	const warn = console.warn;
	console.warn = () => {};
	const first = new Moq.Broadcast.Producer();
	const second = new Moq.Broadcast.Producer();
	const handle = new Signal<Moq.Broadcast.Consumer>(first.consume());

	const source = {
		in: {
			broadcast: new Signal({
				relativeBroadcast: (effect: Effect) => effect.get(handle),
			} as unknown as Broadcast),
		},
		out: {
			track: new Signal<string | undefined>(TRACK),
			config: new Signal<Catalog.VideoConfig | undefined>(
				Catalog.VideoConfigSchema.parse({ codec: "avc1.640028", container: { kind: "legacy" } }),
			),
			catalog: new Signal<Catalog.VideoConfig | undefined>(undefined),
		},
	} as unknown as Source;

	const sync = new Sync({ delay: Time.Milli(100) });
	const decoder = new Decoder({ source, sync });

	const opened: string[] = [];
	const serve = (producer: Moq.Broadcast.Producer) => {
		const track = new ServedTrack(TRACK, opened).accept({});
		producer.insertTrack(track);
		return new Container.Legacy.Producer(track, new Container.Legacy.Format("video"));
	};
	const served = [serve(first), serve(second)];

	try {
		for (let i = 0; i < 400 && opened.length < 1; i++) await flush();
		expect(opened).toHaveLength(1);

		// A publisher that has been up for a while, so the clock anchors well past zero.
		served[0].encode(payload(16), Time.Micro(10_000_000), true);
		await settle();
		expect(sync.out.reference.peek()).toBeDefined();

		// It restarts: same name, a different broadcast.
		first.close();
		handle.set(second.consume());
		for (let i = 0; i < 400 && opened.length < 2; i++) await flush();
		expect(opened).toHaveLength(2);

		expect(sync.out.reference.peek()).toBeUndefined();
	} finally {
		decoder.close();
		sync.close();
		first.close();
		second.close();
		console.warn = warn;
	}
});

test("a rendition that left the catalog is not a stall", async () => {
	// A publisher hiding its camera takes the rendition out of the catalog and the tile keeps the
	// picture it already has. The buffering overlay reads `stalled`, so the watchdog labelling that
	// gap put a spinner over a still frame for as long as the camera was away: 4.6s of it on the
	// bench's `hide-mute` row, with the ring full and audio never interrupted.
	const fx = fixture();
	const rendition = fx.config.peek();
	try {
		expect(await fx.subscriptions(1)).toBe(1);

		fx.served[0].encode(payload(16), Time.Micro(0), true);
		await settle();
		built[0].emit(0);
		await settle();
		expect(fx.decoder.out.stalled.peek()).toBe(false);

		// The camera goes, and nothing arrives for several watchdog windows.
		fx.config.set(undefined);
		await advance(2_500);
		await settle();
		expect(fx.decoder.out.stalled.peek()).toBe(false);

		// It comes back, so a picture is due again and the watchdog arms with it.
		fx.config.set(rendition);
		await advance(1_500);
		await settle();
		expect(fx.decoder.out.stalled.peek()).toBe(true);
	} finally {
		fx.close();
	}
});

test("a pending rendition waits until its preview picture is due", async () => {
	const fx = fixture();
	const second = new Moq.Track.Producer("second").accept({});
	fx.broadcast.insertTrack(second);
	const encoded = new Container.Legacy.Producer(second, new Container.Legacy.Format("video"));
	try {
		expect(await fx.subscriptions(1)).toBe(1);
		const audio = fx.sync.track("audio");
		audio.clock.set({ timestamp: Time.Micro(1_000_000), reference: Time.Milli.now(), rate: 0 });
		fx.served[0].encode(payload(16), Time.Micro(1_000_000), true);
		await settle();
		built[0].emit(1_000_000);
		await settle();
		expect(fx.decoder.out.timestamp.peek()).toBe(Time.Milli(1_000));

		fx.rendition.set("second");
		await settle();
		expect(built).toHaveLength(2);
		encoded.encode(payload(16), Time.Micro(1_150_000), true);
		await settle();
		built[1].emit(1_150_000);
		await settle();
		expect(fx.decoder.out.timestamp.peek()).toBe(Time.Milli(1_000));
		expect(fx.decoder.out.frame.peek()?.timestamp).toBe(1_000_000);

		audio.clock.set({ timestamp: Time.Micro(1_150_000), reference: Time.Milli.now(), rate: 0 });
		await settle();
		expect(fx.decoder.out.frame.peek()?.timestamp).toBe(1_150_000);
	} finally {
		fx.close();
	}
});

test("a sparse rendition is not rebuilt at every healthy silence", async () => {
	const fx = fixture();
	try {
		expect(await fx.subscriptions(1)).toBe(1);
		for (let n = 0; n < 6; n++) {
			const timestamp = Time.Micro(n * 6_000_000);
			fx.served[0].encode(payload(16), timestamp, true);
			await settle();
			built.at(-1)?.emit(timestamp);
			await settle();
			await advance(6_000);
		}
		expect(await fx.subscriptions(2)).toBe(2);
		expect(fx.decoder.out.frame.peek()?.timestamp).toBe(30_000_000);
	} finally {
		fx.close();
	}
});

test("a new rendition does not inherit a sparse rendition's recovery window", async () => {
	const fx = fixture();
	const second = new Moq.Track.Producer("second").accept({});
	fx.broadcast.insertTrack(second);
	const encoded = new Container.Legacy.Producer(second, new Container.Legacy.Format("video"));
	try {
		expect(await fx.subscriptions(1)).toBe(1);
		for (let n = 0; n < 2; n++) {
			const timestamp = Time.Micro(n * 6_000_000);
			fx.served[0].encode(payload(16), timestamp, true);
			await settle();
			built.at(-1)?.emit(timestamp);
			await settle();
			await advance(6_000);
		}
		fx.rendition.set("second");
		await settle();
		encoded.encode(payload(16), Time.Micro(12_000_000), true);
		await settle();
		built.at(-1)?.emit(12_000_000);
		await advance(100);
		expect(fx.decoder.out.frame.peek()?.timestamp).toBe(12_000_000);
		const before = built.length;
		await advance(6_000);
		expect(built).toHaveLength(before + 1);
	} finally {
		fx.close();
	}
});

for (const resumed of [1, 3]) {
	test(`a recovered 30 fps source keeps its recovery window after ${resumed} frame(s) resume`, async () => {
		const fx = fixture();
		const paint = async (timestamp: number) => {
			fx.sync.track("audio").clock.set({
				timestamp: Time.Micro(timestamp),
				reference: Time.Milli.now(),
				rate: 0,
			});
			fx.served[0].encode(payload(16), Time.Micro(timestamp), true);
			await settle();
			built.at(-1)?.emit(timestamp);
			await settle();
		};
		try {
			expect(await fx.subscriptions(1)).toBe(1);
			for (let i = 0; i < 3; i++) {
				await paint(i * 33_333);
				await advance(34);
			}
			await advance(30_000);
			for (let i = 0; i < resumed; i++) {
				await paint(30_100_000 + i * 33_333);
				await advance(34);
			}
			expect(fx.decoder.out.frame.peek()?.timestamp).toBe(30_100_000 + (resumed - 1) * 33_333);
			const before = built.length;
			await advance(6_000);
			expect(built).toHaveLength(before + 1);
		} finally {
			fx.close();
		}
	});
}

test("alternating sparse intervals stop rebuilding once both gaps repeat", async () => {
	const fx = fixture();
	let timestamp = 0;
	const paint = async () => {
		fx.sync.track("audio").clock.set({
			timestamp: Time.Micro(timestamp),
			reference: Time.Milli.now(),
			rate: 0,
		});
		fx.served[0].encode(payload(16), Time.Micro(timestamp), true);
		await settle();
		built.at(-1)?.emit(timestamp);
		await settle();
	};
	const cycle = async () => {
		for (const interval of [2_000, 6_000]) {
			await advance(interval);
			timestamp += interval * 1_000;
			await paint();
		}
	};
	try {
		expect(await fx.subscriptions(1)).toBe(1);
		await paint();
		await cycle();
		await cycle();
		const before = built.length;
		for (let i = 0; i < 4; i++) await cycle();
		expect(fx.decoder.out.frame.peek()?.timestamp).toBe(48_000_000);
		expect(built).toHaveLength(before);
	} finally {
		fx.close();
	}
});

import { afterEach, beforeEach, expect, test } from "bun:test";
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
	/** Emit a decoded picture, which is what keeps the tile out of the stalled state. */
	emit(timestamp: number): void;
	/** Raise a codec error, the way a decoder does when it cannot decode what it was fed. */
	fail(error: Error): void;
};

let built: Built[] = [];

// Wall time runs this many times faster inside a test, so BUFFERING lands at 20ms, RETRY at 40ms and
// RECOVER at 200ms.
const SPEEDUP = 25;

const real = {
	VideoDecoder: globalThis.VideoDecoder,
	EncodedVideoChunk: globalThis.EncodedVideoChunk,
	setTimeout: globalThis.setTimeout,
};

beforeEach(() => {
	built = [];

	// The retry and recovery windows are seconds by design, so the timers run on a compressed clock
	// rather than being waited out. `Effect.timer` calls the global, so scaling it here is enough;
	// microtasks and the signal graph stay real. Same shape as the `performance.now` stub in
	// `sync.replay.test.ts`. Scaling rather than clamping keeps the order between the windows, which
	// is what tells a rebuild driven by the codec error from one driven by the stall watchdog.
	globalThis.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
		const scaled = ms === undefined ? ms : Math.max(1, Math.round(ms / SPEEDUP));
		return real.setTimeout(fn, scaled, ...rest);
	}) as typeof setTimeout;

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
				emit: (timestamp: number) => init.output(new FakeVideoFrame(timestamp)),
				fail: (error: Error) => init.error(error),
			};
			built.push(this.#entry);
		}

		configure(): void {
			this.state = "configured";
		}

		decode(chunk: { type: string }): void {
			this.#entry.chunks.push(chunk.type);
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
	globalThis.VideoDecoder = real.VideoDecoder;
	globalThis.EncodedVideoChunk = real.EncodedVideoChunk;
	globalThis.setTimeout = real.setTimeout;
});

const flush = () => new Promise((resolve) => real.setTimeout(resolve, 0));

async function settle(rounds = 10): Promise<void> {
	for (let i = 0; i < rounds; i++) await flush();
}

const TRACK = "video";
const payload = (n: number) => new Uint8Array(n).fill(1);

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

/** A live broadcast, a `Decoder` reading it, and every subscription it has raised. */
function fixture() {
	const broadcast = new Moq.Broadcast.Producer();
	const consumer = broadcast.consume();
	const source = {
		in: { broadcast: new Signal({ relativeBroadcast: () => consumer } as unknown as Broadcast) },
		out: {
			track: new Signal<string | undefined>(TRACK),
			config: new Signal<Catalog.VideoConfig | undefined>(
				Catalog.VideoConfigSchema.parse({ codec: "avc1.640028", container: { kind: "legacy" } }),
			),
			catalog: new Signal<Catalog.VideoConfig | undefined>(undefined),
		},
	} as unknown as Source;

	const sync = new Sync({ delay: Time.Milli(100) });
	const decoder = new Decoder(source, sync);

	// Accept every subscription as it arrives. One handle per subscription is the whole point: a
	// rebuilt track raises a second request, and a stranded one never does.
	const served: Container.Legacy.Producer[] = [];
	void (async () => {
		for (;;) {
			const request = await broadcast.requested();
			if (!request) return;
			served.push(new Container.Legacy.Producer(request.accept({}), new Container.Legacy.Format("video")));
		}
	})();

	return {
		served,
		decoder,
		/** The rendition the catalog is offering, which a publisher hiding its camera takes away. */
		config: source.out.config as Signal<Catalog.VideoConfig | undefined>,
		/** Wait until `count` subscriptions have been raised, or give up. */
		async subscriptions(count: number): Promise<number> {
			for (let i = 0; i < 400 && served.length < count; i++) await flush();
			return served.length;
		},
		/** Wait until `count` codecs have been built, or give up. One per rebuilt track. */
		async decoders(count: number): Promise<number> {
			for (let i = 0; i < 400 && built.length < count; i++) await flush();
			return built.length;
		},
		close(): void {
			decoder.close();
			sync.close();
			broadcast.close();
		},
	};
}

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
			// one left in place.
			expect(await fx.decoders(2)).toBeGreaterThanOrEqual(2);

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
			await new Promise((resolve) => real.setTimeout(resolve, 600));
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
	const decoder = new Decoder(source, sync);

	const requests: string[] = [];
	const serve = (producer: Moq.Broadcast.Producer, label: string) =>
		void (async () => {
			for (;;) {
				const request = await producer.requested();
				if (!request) return;
				requests.push(`${label}:${request.name}`);
				request.accept({});
			}
		})();

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
	const decoder = new Decoder(source, sync);

	const served: Container.Legacy.Producer[] = [];
	const serve = (producer: Moq.Broadcast.Producer) =>
		void (async () => {
			for (;;) {
				const request = await producer.requested();
				if (!request) return;
				served.push(new Container.Legacy.Producer(request.accept({}), new Container.Legacy.Format("video")));
			}
		})();
	serve(first);
	serve(second);

	try {
		for (let i = 0; i < 400 && served.length < 1; i++) await flush();
		expect(served).toHaveLength(1);

		// A publisher that has been up for a while, so the clock anchors well past zero.
		served[0].encode(payload(16), Time.Micro(10_000_000), true);
		await settle();
		expect(sync.out.reference.peek()).toBeDefined();

		// It restarts: same name, a different broadcast.
		first.close();
		handle.set(second.consume());
		for (let i = 0; i < 400 && served.length < 2; i++) await flush();
		expect(served).toHaveLength(2);

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
		await new Promise((resolve) => real.setTimeout(resolve, 100));
		await settle();
		expect(fx.decoder.out.stalled.peek()).toBe(false);

		// It comes back, so a picture is due again and the watchdog arms with it.
		fx.config.set(rendition);
		await new Promise((resolve) => real.setTimeout(resolve, 60));
		await settle();
		expect(fx.decoder.out.stalled.peek()).toBe(true);
	} finally {
		fx.close();
	}
});

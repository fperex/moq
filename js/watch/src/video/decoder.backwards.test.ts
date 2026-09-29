import { afterEach, beforeEach, expect, test } from "bun:test";
import * as Catalog from "@moq/hang/catalog";
import * as Moq from "@moq/net";
import { Time } from "@moq/net";
import { type Effect, Signal } from "@moq/signals";
import type { Broadcast } from "../broadcast";
import { Sync } from "../sync";
import { Decoder } from "./decoder";
import type { Source } from "./source";

// What a track opened after a gap (a tab shown again, a tile scrolled back, a resume, a reattached
// element) may put on screen. Its first group can start before the picture the tile is holding, and
// nothing in that group older than the held picture is due. WebCodecs is not in bun, so a fake codec
// records chunks and emits pictures on demand. Real timers throughout, each wait a poll bounded at 3 s.

type Codec = {
	chunks: string[];
	emit(timestamp: number): void;
};
let codecs: Codec[] = [];

const real = { VideoDecoder: globalThis.VideoDecoder, EncodedVideoChunk: globalThis.EncodedVideoChunk };

beforeEach(() => {
	codecs = [];
	class FakeVideoFrame {
		readonly displayWidth = 16;
		readonly displayHeight = 16;
		readonly timestamp: number;
		constructor(timestamp: number) {
			this.timestamp = timestamp;
		}
		clone(): FakeVideoFrame {
			return new FakeVideoFrame(this.timestamp);
		}
		close(): void {}
	}
	class FakeVideoDecoder {
		state = "unconfigured";
		readonly #codec: Codec;
		constructor(init: { output: (frame: unknown) => void; error: (error: Error) => void }) {
			this.#codec = { chunks: [], emit: (timestamp) => init.output(new FakeVideoFrame(timestamp)) };
			codecs.push(this.#codec);
		}
		configure(): void {
			this.state = "configured";
		}
		decode(chunk: { type: string }): void {
			this.#codec.chunks.push(chunk.type);
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
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
async function settle(rounds = 20): Promise<void> {
	for (let i = 0; i < rounds; i++) await flush();
}
async function until(done: () => boolean, ms = 3_000): Promise<void> {
	const start = Date.now();
	while (!done() && Date.now() - start < ms) await flush();
}

function write(group: Moq.Group.Producer, timestamp: number): void {
	const header = Moq.Varint.encode(timestamp);
	const body = new Uint8Array(header.length + 1);
	body.set(header);
	body[header.length] = 1;
	group.writeFrame({ payload: body, timestamp: Time.Timestamp.now() });
}

// The broadcast clock every catalog here advertises unless a case says otherwise: the one mapping a
// publisher fixes for its whole run.
const CLOCK: Catalog.Clock = { wall: Catalog.u53(1_000_000), timescale: 1_000_000 };

function fixture(options: { clock?: Catalog.Clock } = { clock: CLOCK }) {
	const clock = options.clock;
	let broadcast = new Moq.Broadcast.Producer();
	const handle = new Signal<Moq.Broadcast.Consumer | undefined>(broadcast.consume());
	const config = Catalog.VideoConfigSchema.parse({ codec: "avc1.640028", container: { kind: "legacy" } });
	const catalog = new Signal<Catalog.Root | undefined>({
		video: { renditions: { video: config } },
		clock,
	} as Catalog.Root);
	const source = {
		in: {
			broadcast: new Signal({
				relativeBroadcast: (effect: Effect) => effect.get(handle),
				out: { catalog },
			} as unknown as Broadcast),
		},
		out: {
			track: new Signal<string | undefined>("video"),
			config: new Signal<Catalog.VideoConfig | undefined>(config),
			catalog: new Signal<Catalog.VideoConfig | undefined>(undefined),
		},
	} as unknown as Source;
	const sync = new Sync({ delay: Time.Milli(100) });
	const enabled = new Signal(true);
	const decoder = new Decoder({ source, sync, enabled });
	let track = new Moq.Track.Producer("video").accept({});
	broadcast.insertTrack(track);

	// Every picture the decoder hands the renderer, in order.
	const shown: number[] = [];
	const dispose = decoder.out.frame.subscribe((frame) => {
		if (frame) shown.push(frame.timestamp);
	});

	// The audio playhead, parked so nothing here depends on how fast the machine is.
	const park = (micro: number) =>
		sync.track("audio").clock.set({ timestamp: Time.Micro(micro), reference: Time.Milli.now(), rate: 0 });

	const close = () => {
		dispose();
		decoder.close();
		sync.close();
		broadcast.close();
	};
	return {
		decoder,
		sync,
		enabled,
		get track() {
			return track;
		},
		shown,
		park,
		close,
		// A reattached element or a replaced session: the same publisher's broadcast comes back as a
		// new consumer, with the catalog it always had.
		reconnect() {
			handle.set(broadcast.consume());
		},
		// The session dropped while the tile stayed on screen: the broadcast goes away.
		offline() {
			handle.set(undefined);
		},
		// A publisher restarted under the same name: a new broadcast whose catalog names its own clock.
		republish(next: Catalog.Clock | undefined) {
			broadcast.close();
			broadcast = new Moq.Broadcast.Producer();
			track = new Moq.Track.Producer("video").accept({});
			broadcast.insertTrack(track);
			handle.set(broadcast.consume());
			catalog.set({ video: { renditions: { video: config } }, clock: next } as Catalog.Root);
		},
	};
}

// One group, keyframe at 10.000 s and a delta at 12.000 s, painted up to 12.000 s.
async function hold(fx: ReturnType<typeof fixture>): Promise<void> {
	await until(() => codecs.length >= 1);
	fx.park(12_000_000);
	const group = fx.track.appendGroup();
	write(group, 10_000_000);
	write(group, 12_000_000);
	await until(() => (codecs[0]?.chunks.length ?? 0) > 1);
	codecs[0].emit(10_000_000);
	codecs[0].emit(12_000_000);
	await until(() => fx.decoder.out.frame.peek()?.timestamp === 12_000_000);
	expect(fx.decoder.out.frame.peek()?.timestamp).toBe(12_000_000);
}

// `hold`, then the video is taken away (a hidden tab, a scroll out) and, after `during`, brought back.
async function holdThenReopen(fx: ReturnType<typeof fixture>, during?: () => void): Promise<void> {
	await hold(fx);
	fx.enabled.set(false);
	await settle();
	during?.();
	fx.shown.length = 0;
	fx.enabled.set(true);
	await until(() => codecs.length >= 2);
}

test("a track reopened after a gap never steps the picture back", async () => {
	const fx = fixture();
	try {
		await holdThenReopen(fx);

		// Back within the same group: the new subscription starts at its keyframe, 10.000 s, which is
		// older than the held picture, while the playhead is still at 12.000 s. Nothing in it is due.
		await until(() => (codecs[1]?.chunks.length ?? 0) > 1);
		codecs[1].emit(10_000_000);
		await settle();

		// The live group follows and plays as usual.
		fx.park(12_100_000);
		write(fx.track.appendGroup(), 12_040_000);
		await until(() => (codecs[1]?.chunks.length ?? 0) > 2);
		codecs[1].emit(12_040_000);
		await until(() => fx.decoder.out.frame.peek()?.timestamp === 12_040_000);

		expect(fx.shown.filter((ts) => ts < 12_000_000)).toEqual([]);
		expect(fx.decoder.out.frame.peek()?.timestamp).toBe(12_040_000);
	} finally {
		fx.close();
	}
});

test("a track reopened after a gap never steps back, even once its first group was skipped", async () => {
	const fx = fixture();
	try {
		await holdThenReopen(fx);

		// The live group lands before the joined group's keyframe comes out of the codec, so the
		// consumer skips the joined group (a discontinuity) while its 10.000 s picture is in flight.
		await until(() => (codecs[1]?.chunks.length ?? 0) > 1);
		fx.park(12_100_000);
		write(fx.track.appendGroup(), 12_040_000);
		await until(() => (codecs[1]?.chunks.length ?? 0) > 2);
		codecs[1].emit(10_000_000);
		await settle();
		codecs[1].emit(12_040_000);
		await until(() => fx.decoder.out.frame.peek()?.timestamp === 12_040_000);

		expect(fx.shown.filter((ts) => ts < 12_000_000)).toEqual([]);
		expect(fx.decoder.out.frame.peek()?.timestamp).toBe(12_040_000);
	} finally {
		fx.close();
	}
});

test("a track reopened on a rewound timeline still shows its pictures", async () => {
	// Only a publisher that names no clock can rewind: one that does fixes its mapping for good.
	const fx = fixture({});
	try {
		// The publisher rewound while the video was away: its latest group starts at 0.5 s, and the
		// shared clock was re-anchored there, so a picture older than the held one is what is due.
		await holdThenReopen(fx, () => {
			fx.sync.reset();
			fx.park(500_000);
			write(fx.track.appendGroup(), 500_000);
		});
		await until(() => (codecs[1]?.chunks.length ?? 0) > 0);
		codecs[1].emit(500_000);
		await until(() => fx.decoder.out.frame.peek()?.timestamp === 500_000);

		expect(fx.decoder.out.frame.peek()?.timestamp).toBe(500_000);
	} finally {
		fx.close();
	}
});

test("a reattached track never steps the picture back", async () => {
	const fx = fixture();
	try {
		// The element was detached and reattached: a new consumer of the same publisher, whose
		// catalog still names the clock the held picture was painted on.
		await holdThenReopen(fx, () => fx.reconnect());

		// The first group served is the one the viewer was watching when it left.
		await until(() => (codecs[1]?.chunks.length ?? 0) > 1);
		codecs[1].emit(10_000_000);
		await settle();

		fx.park(12_100_000);
		write(fx.track.appendGroup(), 12_040_000);
		await until(() => (codecs[1]?.chunks.length ?? 0) > 2);
		codecs[1].emit(12_040_000);
		await until(() => fx.decoder.out.frame.peek()?.timestamp === 12_040_000);

		expect(fx.shown.filter((ts) => ts < 12_000_000)).toEqual([]);
		expect(fx.decoder.out.frame.peek()?.timestamp).toBe(12_040_000);
	} finally {
		fx.close();
	}
});

test("a track whose broadcast went away and came back never steps the picture back", async () => {
	const fx = fixture();
	try {
		await hold(fx);

		// The session dropped while the tile stayed on screen, which clears the picture, and the same
		// publisher's broadcast came back on a new one.
		fx.offline();
		await until(() => fx.decoder.out.frame.peek() === undefined);
		expect(fx.decoder.out.frame.peek()).toBeUndefined();
		fx.shown.length = 0;
		fx.reconnect();
		await until(() => codecs.length >= 2);

		await until(() => (codecs[1]?.chunks.length ?? 0) > 1);
		codecs[1].emit(10_000_000);
		await settle();

		fx.park(12_100_000);
		write(fx.track.appendGroup(), 12_040_000);
		await until(() => (codecs[1]?.chunks.length ?? 0) > 2);
		codecs[1].emit(12_040_000);
		await until(() => fx.decoder.out.frame.peek()?.timestamp === 12_040_000);

		expect(fx.shown.filter((ts) => ts < 12_000_000)).toEqual([]);
		expect(fx.decoder.out.frame.peek()?.timestamp).toBe(12_040_000);
	} finally {
		fx.close();
	}
});

test("a reopened track never steps back, even once the audio clock parks behind the held picture", async () => {
	const fx = fixture();
	try {
		await holdThenReopen(fx);

		// Audio came back first, with media from before the gap: its playhead sits behind the
		// picture on screen, so by the clock alone the older picture would be due.
		fx.park(11_000_000);
		await until(() => fx.sync.now() === 11_000);
		expect(fx.sync.now()).toBe(Time.Milli(11_000));
		await until(() => (codecs[1]?.chunks.length ?? 0) > 1);
		codecs[1].emit(10_000_000);
		await settle();

		fx.park(12_100_000);
		write(fx.track.appendGroup(), 12_040_000);
		await until(() => (codecs[1]?.chunks.length ?? 0) > 2);
		codecs[1].emit(12_040_000);
		await until(() => fx.decoder.out.frame.peek()?.timestamp === 12_040_000);

		expect(fx.shown.filter((ts) => ts < 12_000_000)).toEqual([]);
		expect(fx.decoder.out.frame.peek()?.timestamp).toBe(12_040_000);
	} finally {
		fx.close();
	}
});

test("a republished broadcast on its own clock still shows its pictures", async () => {
	const fx = fixture();
	try {
		// The publisher restarted while the video was away: a new broadcast on a new clock, whose
		// timeline starts near zero, far below the held picture.
		await holdThenReopen(fx, () => {
			fx.republish({ wall: Catalog.u53(9_000_000), timescale: 1_000_000 });
			fx.park(500_000);
			write(fx.track.appendGroup(), 500_000);
		});
		await until(() => (codecs[1]?.chunks.length ?? 0) > 0);
		codecs[1].emit(500_000);
		await until(() => fx.decoder.out.frame.peek()?.timestamp === 500_000);

		expect(fx.decoder.out.frame.peek()?.timestamp).toBe(500_000);
	} finally {
		fx.close();
	}
});

test("a republished broadcast without a clock still shows its pictures", async () => {
	const fx = fixture();
	try {
		// Nothing names the timeline, so a new broadcast is taken for a new one.
		await holdThenReopen(fx, () => {
			fx.republish(undefined);
			fx.park(500_000);
			write(fx.track.appendGroup(), 500_000);
		});
		await until(() => (codecs[1]?.chunks.length ?? 0) > 0);
		codecs[1].emit(500_000);
		await until(() => fx.decoder.out.frame.peek()?.timestamp === 500_000);

		expect(fx.decoder.out.frame.peek()?.timestamp).toBe(500_000);
	} finally {
		fx.close();
	}
});

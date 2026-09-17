import { afterEach, beforeEach, expect, test } from "bun:test";
import { Container } from "@moq/hang";
import * as Catalog from "@moq/hang/catalog";
import * as Moq from "@moq/net";
import { Time } from "@moq/net";
import { Signal } from "@moq/signals";
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

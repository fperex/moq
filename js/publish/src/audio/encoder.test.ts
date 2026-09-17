import { describe, expect, mock, test } from "bun:test";
import * as Catalog from "@moq/hang/catalog";
import * as Moq from "@moq/net";
import { Time } from "@moq/net";
import { Signal } from "@moq/signals";
import type { Format } from "./capture";
import { resolve } from "./encoder";

// Bun does not load Vite's worklet URL imports from the public audio entrypoint.
mock.module("./capture-worklet.ts?worklet", () => ({ default: "blob:fake-capture" }));

const Audio = await import("./index");

const captured: Format = { sampleRate: 48_000, channelCount: 2 };

describe("resolve", () => {
	test("keeps resolution out of the public audio namespace", () => {
		// @ts-expect-error Resolution is internal to the encoder.
		expect(Audio.resolve).toBeUndefined();
	});

	test("defaults Opus to 20ms", () => {
		const resolved = resolve(captured, "opus");
		expect(resolved.frameDuration).toBe(Time.Micro(20_000));
		expect(resolved.catalog.jitter).toBe(Catalog.u53(20));
	});

	// The exact frame duration is independent of the catalog's whole-millisecond jitter hint.
	test("keeps a 2.5ms Opus frame exact and rounds the catalog hint up", () => {
		const resolved = resolve(captured, { mime: "opus", frameDuration: Time.Milli(2.5) });
		expect(resolved.frameDuration).toBe(Time.Micro(2_500));
		expect(resolved.catalog.jitter).toBe(Catalog.u53(3));
	});

	test("carries every Opus frame duration", () => {
		for (const millis of [2.5, 5, 10, 20, 40, 60]) {
			const resolved = resolve(captured, { mime: "opus", frameDuration: Time.Milli(millis) });
			expect(resolved.frameDuration).toBe(Time.Micro(millis * 1000));
		}
	});

	// Otherwise AudioEncoder.configure throws instead, by which point the rendition has already
	// been advertised and the failure lands on a subscriber rather than the caller.
	test("rejects a duration Opus cannot encode", () => {
		for (const millis of [2.5005, 15, 0, -20]) {
			expect(() => resolve(captured, { mime: "opus", frameDuration: Time.Milli(millis) })).toThrow();
		}
	});

	// AAC-LC has a fixed 1024-sample frame, so there is no duration to configure.
	test("leaves AAC without a frame duration", () => {
		const resolved = resolve(captured, "aac");
		expect(resolved.frameDuration).toBeUndefined();
		expect(resolved.catalog.jitter).toBe(Catalog.u53(Math.ceil((1024 / 48_000) * 1000)));
	});
});

/** An AudioEncoder that never encodes anything, but hands the test its output callback. */
class FakeAudioEncoder {
	static last: FakeAudioEncoder | undefined;

	state: CodecState = "unconfigured";
	readonly output: (frame: EncodedAudioChunk, metadata?: EncodedAudioChunkMetadata) => void;

	constructor(init: AudioEncoderInit) {
		this.output = init.output;
		FakeAudioEncoder.last = this;
	}

	configure(): void {
		this.state = "configured";
	}

	encode(): void {}

	close(): void {
		this.state = "closed";
	}
}

/** One encoded frame as WebCodecs hands it over: a length, a copy, and its place on the timeline. */
function chunk(timestamp: number, duration: number): EncodedAudioChunk {
	const payload = new Uint8Array([1, 2, 3]);
	return {
		type: "key",
		timestamp,
		duration,
		byteLength: payload.byteLength,
		copyTo: (buffer: Uint8Array) => buffer.set(payload),
	} as unknown as EncodedAudioChunk;
}

function installFakeAudioCodecs() {
	const originals = (["AudioEncoder", "AudioDecoder"] as const).map(
		(name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
	);
	Object.defineProperty(globalThis, "AudioEncoder", { configurable: true, value: FakeAudioEncoder, writable: true });
	// The Opus polyfill loads whenever either half is missing, and it cannot run here.
	Object.defineProperty(globalThis, "AudioDecoder", { configurable: true, value: class {}, writable: true });

	return {
		[Symbol.dispose]() {
			for (const [name, original] of originals) {
				if (original) Object.defineProperty(globalThis, name, original);
				else Reflect.deleteProperty(globalThis, name);
			}
		},
	};
}

/** Let the effect graph and the encoder's spawned setup settle. */
async function settle() {
	for (let i = 0; i < 20; i++) await Promise.resolve();
	await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("a rendition that stops encoding", () => {
	// A stand-in for the track producer a subscription hands the rendition, recording what it is
	// asked to publish.
	function trackOf(written: Array<{ payload: Uint8Array }>, groups: Array<{ frames: number }>) {
		return {
			writeFrame: (frame: { payload: Uint8Array }) => written.push(frame),
			// An empty group is how a publisher declares a break in the timeline.
			appendGroup: () => {
				const group = { frames: 0 };
				groups.push(group);
				return { close: () => {} };
			},
		};
	}

	async function encoding() {
		const written: Array<{ payload: Uint8Array }> = [];
		const groups: Array<{ frames: number }> = [];
		const track = trackOf(written, groups);
		const rendition = { config: new Signal(undefined), track: new Signal<unknown>(track), close: () => {} };
		const capture = {
			in: { source: new Signal(undefined) },
			out: {
				root: new Signal(undefined),
				format: new Signal<Format | undefined>({ sampleRate: 48_000, channelCount: 1 }),
				frames: new Signal(undefined),
			},
		};
		const enabled = new Signal(true);
		const encoder = new Audio.Encoder("audio", {
			enabled,
			broadcast: { audio: () => rendition } as never,
			capture: capture as never,
		});

		await settle();
		return { encoder, enabled, capture, rendition, written, groups };
	}

	test("declares where the timeline stops when it is muted", async () => {
		using _codecs = installFakeAudioCodecs();
		const { encoder, enabled, written } = await encoding();

		try {
			// One 20ms frame reaches the wire, so the timeline runs to 20ms.
			FakeAudioEncoder.last?.output(chunk(0, 20_000));
			expect(written).toHaveLength(1);

			enabled.set(false);
			await settle();

			// The endpoint is an empty payload behind the timestamp varint, which is what
			// `Container.Legacy.Format.end` reads back and the watcher renders as silence.
			expect(written).toHaveLength(2);
			const [timestamp, payload] = Moq.Varint.decode(written[1].payload);
			expect(timestamp).toBe(20_000);
			expect(payload.byteLength).toBe(0);
		} finally {
			encoder.close();
		}
	});

	test("declares the break that reopens the timeline when it resumes", async () => {
		using _codecs = installFakeAudioCodecs();
		const { encoder, enabled, written, groups } = await encoding();

		try {
			FakeAudioEncoder.last?.output(chunk(0, 20_000));
			enabled.set(false);
			await settle();
			expect(written).toHaveLength(2);
			expect(groups).toHaveLength(0);

			enabled.set(true);
			await settle();
			// Nothing on the wire until there is audio again: the break belongs with the frame it
			// reopens the timeline for.
			expect(groups).toHaveLength(0);

			FakeAudioEncoder.last?.output(chunk(10_000_000, 20_000));
			expect(groups).toHaveLength(1);
			expect(written).toHaveLength(3);

			// And only once: the timeline is open again.
			FakeAudioEncoder.last?.output(chunk(10_020_000, 20_000));
			expect(groups).toHaveLength(1);
		} finally {
			encoder.close();
		}
	});

	test("declares nothing when it never encoded anything", async () => {
		using _codecs = installFakeAudioCodecs();
		const { encoder, enabled, written } = await encoding();

		try {
			enabled.set(false);
			await settle();
			expect(written).toHaveLength(0);
		} finally {
			encoder.close();
		}
	});

	test("declares the break after an interval with no subscriber", async () => {
		using _codecs = installFakeAudioCodecs();
		const { encoder, rendition, written, groups } = await encoding();

		try {
			FakeAudioEncoder.last?.output(chunk(0, 20_000));
			expect(written).toHaveLength(1);

			// The last subscriber leaves. The pipeline deliberately outlives any one subscription, so
			// nothing tears down and nothing writes an endpoint: the frames encoded meanwhile are
			// simply dropped, leaving a hole in the timeline.
			rendition.track.set(undefined);
			await settle();
			FakeAudioEncoder.last?.output(chunk(20_000, 20_000));
			expect(written).toHaveLength(1);
			expect(groups).toHaveLength(0);

			// A new subscriber arrives. Its first frame has to declare the break: without it the
			// frame reads as continuing the last one, and the subscriber holds it at the old anchor
			// with its playhead the whole gated interval behind.
			rendition.track.set(trackOf(written, groups));
			await settle();
			FakeAudioEncoder.last?.output(chunk(40_000_000, 20_000));
			expect(groups).toHaveLength(1);
			expect(written).toHaveLength(2);

			// And only once: the timeline is open again.
			FakeAudioEncoder.last?.output(chunk(40_020_000, 20_000));
			expect(groups).toHaveLength(1);
		} finally {
			encoder.close();
		}
	});

	test("keeps the timeline open across a reconfigure", async () => {
		using _codecs = installFakeAudioCodecs();
		const { encoder, written } = await encoding();

		try {
			FakeAudioEncoder.last?.output(chunk(0, 20_000));
			expect(written).toHaveLength(1);

			// A codec change rebuilds the encoder but keeps encoding, so nothing has stopped.
			encoder.codec.set({ mime: "opus", bitrate: 24_000 });
			await settle();
			expect(written).toHaveLength(1);
		} finally {
			encoder.close();
		}
	});

	test("declares where the timeline stops when the source ends while it is still enabled", async () => {
		using _codecs = installFakeAudioCodecs();
		const { encoder, capture, written } = await encoding();

		try {
			FakeAudioEncoder.last?.output(chunk(0, 20_000));
			expect(written).toHaveLength(1);

			// Removing the source without muting stops the pipeline just as a mute does, and a
			// subscriber still has no way to tell audio that stopped from audio that is late.
			capture.out.format.set(undefined);
			await settle();

			expect(written).toHaveLength(2);
			const [timestamp, payload] = Moq.Varint.decode(written[1].payload);
			expect(timestamp).toBe(20_000);
			expect(payload.byteLength).toBe(0);
		} finally {
			encoder.close();
		}
	});
});

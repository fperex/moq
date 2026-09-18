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
	function trackOf(written: Array<{ payload: Uint8Array }>) {
		return {
			writeFrame: (frame: { payload: Uint8Array }) => written.push(frame),
			// An audio rendition writes one frame per group and nothing else. An empty group means
			// nothing on the wire, so reaching for one is a bug rather than a declaration.
			appendGroup: () => {
				throw new Error("audio wrote a group of its own");
			},
		};
	}

	async function encoding() {
		const written: Array<{ payload: Uint8Array }> = [];
		const track = trackOf(written);
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
		return { encoder, enabled, capture, rendition, written };
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

	test("writes only media when it resumes", async () => {
		using _codecs = installFakeAudioCodecs();
		const { encoder, enabled, written } = await encoding();

		try {
			FakeAudioEncoder.last?.output(chunk(0, 20_000));
			enabled.set(false);
			await settle();
			expect(written).toHaveLength(2); // the frame, then the endpoint

			enabled.set(true);
			await settle();
			// Nothing on the wire until there is audio again.
			expect(written).toHaveLength(2);

			// The endpoint alone in its group is already the discontinuity, so the run that resumes
			// declares nothing of its own: its first frame is media, and only media.
			FakeAudioEncoder.last?.output(chunk(10_000_000, 20_000));
			expect(written).toHaveLength(3);
			const [timestamp, payload] = Moq.Varint.decode(written[2].payload);
			expect(timestamp).toBe(10_000_000);
			expect(payload.byteLength).toBeGreaterThan(0);

			FakeAudioEncoder.last?.output(chunk(10_020_000, 20_000));
			expect(written).toHaveLength(4);
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

	test("writes only media after an interval with no subscriber", async () => {
		using _codecs = installFakeAudioCodecs();
		const { encoder, rendition, written } = await encoding();

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

			// A new subscriber arrives. The hole the gate left is the subscriber's to find, since
			// its first frame sits the whole gated interval past the last one, so this writes media
			// and nothing else.
			rendition.track.set(trackOf(written));
			await settle();
			FakeAudioEncoder.last?.output(chunk(40_000_000, 20_000));
			expect(written).toHaveLength(2);

			FakeAudioEncoder.last?.output(chunk(40_020_000, 20_000));
			expect(written).toHaveLength(3);
		} finally {
			encoder.close();
		}
	});

	// The mute sequence, through the real broadcast and net path rather than a stand-in track: the
	// watcher drops its audio subscription, the publisher keeps capturing, and the subscription that
	// replaces it three seconds later has to land on the same live track at the live timestamp. A
	// release of the serving scope on `unused()` closes the producer here instead, which both ends
	// the track for good on the wire and restarts the timeline, so the resumed audio plays out
	// seconds behind the video.
	test("keeps the track and the timeline across a dropped and resumed subscription", async () => {
		using _codecs = installFakeAudioCodecs();

		const { Broadcast } = await import("../broadcast");
		const broadcast = new Broadcast({
			enabled: true,
			origin: new Moq.Origin.Producer(),
			name: Moq.Path.from("mute.hang"),
		});
		const capture = {
			in: { source: new Signal(undefined) },
			out: {
				root: new Signal(undefined),
				format: new Signal<Format | undefined>({ sampleRate: 48_000, channelCount: 1 }),
				frames: new Signal(undefined),
			},
		};
		const encoder = new Audio.Encoder("audio", { enabled: true, broadcast, capture: capture as never });

		let front: Moq.Broadcast.Consumer | undefined;
		let first: Moq.Track.Subscriber | undefined;
		let second: Moq.Track.Subscriber | undefined;

		try {
			await settle();
			const net = broadcast.net.peek();
			if (!net) throw new Error("expected a network producer");
			front = net.consume();

			first = front.subscribe("audio");
			await settle();
			FakeAudioEncoder.last?.output(chunk(0, 20_000));
			expect(await readTimestamp(first)).toBe(0);

			// The user mutes: the watcher drops the subscription with the reset it sends when it
			// leaves. The publisher keeps capturing throughout.
			first.close(new Error("remote error: 1"));
			await settle();

			for (let timestamp = 20_000; timestamp <= 3_000_000; timestamp += 20_000) {
				FakeAudioEncoder.last?.output(chunk(timestamp, 20_000));
			}
			await settle();

			// Unmute. The subscription is served rather than answered from a finished track, and it
			// reaches the live timestamp: the pipeline never re-anchored, so the audio is where the
			// video is.
			second = front.subscribe("audio");
			await settle();
			expect(second.closed.peek()).toBeUndefined();

			// The live edge is waiting for it: this is the track that kept running, so the unmute
			// starts three seconds on rather than at the timestamp the mute stopped at.
			const drain = draining(second);
			expect(await drain()).toBe(3_000_000);

			// And it stays on that timeline: the next frame follows it.
			FakeAudioEncoder.last?.output(chunk(3_020_000, 20_000));
			await settle();
			expect(await drain()).toBe(3_020_000);
		} finally {
			first?.close();
			second?.close();
			front?.close();
			encoder.close();
			broadcast.close();
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

// The timestamp of the next frame a subscriber reads, as the legacy container stamps it.
async function readTimestamp(subscriber: Moq.Track.Subscriber): Promise<number | undefined> {
	const group = await subscriber.recvGroup();
	const payload = await group?.readFrame();
	return payload ? Number(Moq.Varint.decode(payload.payload)[0]) : undefined;
}

// Drains whatever a subscriber can read without waiting and reports the newest timestamp it
// reached, keeping the read it had to abandon so the next drain starts where this one stopped:
// recvGroup hands each group out exactly once, including to a read nobody waited for.
function draining(subscriber: Moq.Track.Subscriber): () => Promise<number | undefined> {
	let pending: Promise<Moq.Group.Consumer | undefined> | undefined;

	return async () => {
		let latest: number | undefined;
		for (;;) {
			pending ??= subscriber.recvGroup();
			const read = pending;
			// Everything written has settled by the time this is called, so a read that has to wait
			// for the next macrotask is a read past the live edge.
			const idle = new Promise<"idle">((resolve) => setTimeout(() => resolve("idle"), 0));
			const group = await Promise.race([read, idle]);
			if (group === "idle") return latest;
			pending = undefined;
			if (!group) return latest;
			const payload = await group.readFrame();
			if (payload) latest = Number(Moq.Varint.decode(payload.payload)[0]);
		}
	};
}

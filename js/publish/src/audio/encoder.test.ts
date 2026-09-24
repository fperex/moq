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

/** The metadata WebCodecs attaches to an Opus chunk: the description a decoder has to init from. */
const described = {
	decoderConfig: { description: new Uint8Array([1, 2, 3]) },
} as unknown as EncodedAudioChunkMetadata;

/** The PCM format the microphone delivers, and delivers again once it has been re-acquired. */
const mono: Format = { sampleRate: 48_000, channelCount: 1 };

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
			// Open throughout, as the broadcast keeps a rendition's track across demand gaps.
			closed: { peek: () => undefined },
		};
	}

	async function encoding() {
		const written: Array<{ payload: Uint8Array }> = [];
		const track = trackOf(written);
		const rendition = {
			config: new Signal<Catalog.AudioConfig | undefined>(undefined),
			track: new Signal<unknown>(track),
			close: () => {},
		};
		const capture = {
			in: { source: new Signal(undefined) },
			out: {
				root: new Signal(undefined),
				format: new Signal<Format | undefined>(mono),
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

	test("shorter audio frames never lower the rendition's advertised jitter", async () => {
		using _codecs = installFakeAudioCodecs();
		const { encoder, enabled } = await encoding();
		try {
			expect(encoder.out.catalog.peek()?.jitter).toBe(Catalog.u53(20));
			encoder.codec.set({ mime: "opus", frameDuration: Time.Milli(5) });
			await settle();
			expect(encoder.out.catalog.peek()?.jitter).toBe(Catalog.u53(20));
			encoder.codec.set({ mime: "opus", frameDuration: Time.Milli(40) });
			await settle();
			expect(encoder.out.catalog.peek()?.jitter).toBe(Catalog.u53(40));
			enabled.set(false);
			await settle();
			expect(encoder.out.catalog.peek()?.jitter).toBe(Catalog.u53(40));
			encoder.codec.set({ mime: "opus", frameDuration: Time.Milli(5) });
			enabled.set(true);
			await settle();
			expect(encoder.out.catalog.peek()?.jitter).toBe(Catalog.u53(40));
		} finally {
			encoder.close();
		}
	});

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

	test("declares a pause once when the last subscriber leaves during it", async () => {
		using _codecs = installFakeAudioCodecs();
		const { encoder, enabled, rendition, written } = await encoding();

		try {
			FakeAudioEncoder.last?.output(chunk(0, 20_000));
			enabled.set(false);
			await settle();
			expect(written).toHaveLength(2); // the frame, then the endpoint

			// That endpoint already ends the timeline, so the demand gap after it has nothing to add.
			rendition.track.set(undefined);
			await settle();
			expect(written).toHaveLength(2);
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

	test("declares an interval with no subscriber and writes only media after it", async () => {
		using _codecs = installFakeAudioCodecs();
		const { encoder, rendition, written } = await encoding();

		try {
			FakeAudioEncoder.last?.output(chunk(0, 20_000));
			expect(written).toHaveLength(1);

			// The last subscriber leaves. The pipeline deliberately outlives any one subscription, so
			// nothing tears down, and the track outlives it too: the endpoint where the audio stopped
			// is what a later subscriber lands on, rather than the stale frame before it. The frames
			// encoded meanwhile are dropped.
			rendition.track.set(undefined);
			await settle();
			expect(written).toHaveLength(2);
			const [timestamp, payload] = Moq.Varint.decode(written[1].payload);
			expect(timestamp).toBe(20_000);
			expect(payload.byteLength).toBe(0);

			FakeAudioEncoder.last?.output(chunk(20_000, 20_000));
			expect(written).toHaveLength(2);

			// A new subscriber arrives. The endpoint already opened the break, so this writes media
			// and nothing else.
			rendition.track.set(trackOf(written));
			await settle();
			FakeAudioEncoder.last?.output(chunk(40_000_000, 20_000));
			expect(written).toHaveLength(3);

			FakeAudioEncoder.last?.output(chunk(40_020_000, 20_000));
			expect(written).toHaveLength(4);
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
	test("keeps the track writable across a dropped and resumed subscription", async () => {
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
				format: new Signal<Format | undefined>(mono),
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

			first = front.track("audio").subscribe();
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
			// accepts a chunk at the live timestamp. The browser media lifecycle test checks that
			// the codec itself preserves the input gap.
			second = front.track("audio").subscribe();
			await settle();
			expect(second.closed.peek()).toBeUndefined();

			// The track kept running, so the subscription is served from it rather than answered from
			// a finished track. The newest thing on it is the endpoint written as the last subscriber
			// left, where the audio stopped: nothing else was added while nobody was listening,
			// because the rendition handle is demand-gated.
			const drain = draining(second);
			expect(await drain()).toBe(20_000);

			// A new chunk at the live timestamp is published on the same track.
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

	test("a muted rendition stays in the catalog", async () => {
		using _codecs = installFakeAudioCodecs();
		const { encoder, enabled, capture, rendition } = await encoding();

		try {
			const entry = rendition.config.peek();
			expect(entry?.codec).toBe("opus");

			// Muting releases the microphone, so the captured format goes with it. The rendition is
			// paused rather than gone, and the endpoint marker on the wire already says so.
			enabled.set(false);
			capture.out.format.set(undefined);
			await settle();

			expect(rendition.config.peek()).toEqual(entry);
		} finally {
			encoder.close();
		}
	});

	test("the resumed rendition carries the same catalog entry", async () => {
		using _codecs = installFakeAudioCodecs();
		const { encoder, enabled, capture, rendition } = await encoding();

		try {
			FakeAudioEncoder.last?.output(chunk(0, 20_000), described);
			await settle();
			const entry = rendition.config.peek();
			expect(entry?.description).toBeDefined();

			enabled.set(false);
			capture.out.format.set(undefined);
			await settle();
			expect(rendition.config.peek()).toEqual(entry);

			// The device comes back and the encoder is built again, against an equal config. A
			// subscriber's rendition is unchanged throughout, description included: a catalog that
			// dropped it would look like a different rendition to select, decode and measure.
			enabled.set(true);
			capture.out.format.set(mono);
			await settle();
			expect(rendition.config.peek()).toEqual(entry);

			FakeAudioEncoder.last?.output(chunk(10_000_000, 20_000), described);
			await settle();
			expect(rendition.config.peek()).toEqual(entry);
		} finally {
			encoder.close();
		}
	});

	test("a rendition whose source is removed leaves the catalog", async () => {
		using _codecs = installFakeAudioCodecs();
		const { encoder, capture, rendition } = await encoding();

		try {
			expect(rendition.config.peek()).toBeDefined();

			// Capture ending while the rendition is enabled is the source going for good, not a
			// pause, so nothing is held open for it.
			capture.out.format.set(undefined);
			await settle();
			expect(rendition.config.peek()).toBeUndefined();
		} finally {
			encoder.close();
		}
	});

	test("a rendition that comes back republishes its decoder description", async () => {
		using _codecs = installFakeAudioCodecs();
		const { encoder, capture, rendition } = await encoding();

		try {
			FakeAudioEncoder.last?.output(chunk(0, 20_000), described);
			await settle();
			const entry = rendition.config.peek();
			expect(entry?.description).toBeDefined();

			// A device unplugged and plugged back in: the rendition leaves and is resolved again into
			// an equal config, which is a different object for the description to be keyed against.
			capture.out.format.set(undefined);
			await settle();
			expect(rendition.config.peek()).toBeUndefined();

			capture.out.format.set(mono);
			await settle();

			FakeAudioEncoder.last?.output(chunk(10_000_000, 20_000), described);
			await settle();
			expect(rendition.config.peek()).toEqual(entry);
		} finally {
			encoder.close();
		}
	});

	// The unmute end to end, on the real broadcast and net path: a subscriber attached throughout
	// has to receive the first resumed frame on the subscription it already has. A rendition that
	// leaves the catalog while the device is released costs that subscriber a catalog round trip
	// and a resubscribe before the publisher's demand gate reopens, and every frame captured in
	// between is dropped at the gate rather than sent.
	test("a mute and unmute resume on the same subscription", async () => {
		using _codecs = installFakeAudioCodecs();

		const { Broadcast } = await import("../broadcast");
		const broadcast = new Broadcast({
			enabled: true,
			origin: new Moq.Origin.Producer(),
			name: Moq.Path.from("unmute.hang"),
		});
		const format = new Signal<Format | undefined>(mono);
		const capture = {
			in: { source: new Signal(undefined) },
			out: { root: new Signal(undefined), format, frames: new Signal(undefined) },
		};
		const enabled = new Signal(true);
		const encoder = new Audio.Encoder("audio", { enabled, broadcast, capture: capture as never });

		let front: Moq.Broadcast.Consumer | undefined;
		let sub: Moq.Track.Subscriber | undefined;

		try {
			await settle();
			const net = broadcast.net.peek();
			if (!net) throw new Error("expected a network producer");
			front = net.consume();

			sub = front.track("audio").subscribe();
			await settle();
			FakeAudioEncoder.last?.output(chunk(0, 20_000));
			const drain = draining(sub);
			expect(await drain()).toBe(0);

			// Everything the catalog does from here on, which is what decides whether that subscriber
			// stays where it is.
			const changes: Array<Catalog.AudioConfig | undefined> = [];
			const dispose = encoder.out.catalog.subscribe((config) => changes.push(config));

			enabled.set(false);
			format.set(undefined);
			await settle();

			// The endpoint marker, and nothing else: the rendition is still advertised.
			expect(await drain()).toBe(20_000);
			expect(changes).toEqual([]);

			enabled.set(true);
			format.set(mono);
			await settle();
			expect(changes).toEqual([]);

			// The first frame the re-acquired device produces goes straight out, on a subscription
			// that was never dropped and a track that never closed.
			FakeAudioEncoder.last?.output(chunk(3_000_000, 20_000));
			await settle();
			expect(await drain()).toBe(3_000_000);
			expect(sub.closed.peek()).toBeUndefined();

			dispose();
		} finally {
			sub?.close();
			front?.close();
			encoder.close();
			broadcast.close();
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

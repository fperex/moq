import { expect, mock, test } from "bun:test";
import type * as Catalog from "@moq/hang/catalog";
import * as Moq from "@moq/net";
import { Signal } from "@moq/signals";

// Bun does not load Vite's worker/worklet URL imports from the public entrypoints.
mock.module("./audio/capture-worklet.ts?worklet", () => ({ default: "blob:fake-capture" }));
mock.module("./video/capture-worker.ts?worker&inline", () => ({ default: class {} }));

const Audio = await import("./audio/index.ts");
const Video = await import("./video/index.ts");
const { Broadcast } = await import("./broadcast.ts");
const { Fanout } = await import("./fanout.ts");

/** A VideoEncoder that hands every frame straight back, so a test drives the wire by enqueuing captures. */
class InstantVideoEncoder {
	state: CodecState = "unconfigured";
	encodeQueueSize = 0;
	readonly #output: VideoEncoderInit["output"];

	constructor(init: VideoEncoderInit) {
		this.#output = init.output;
	}

	static async isConfigSupported(config: VideoEncoderConfig): Promise<{ supported: boolean }> {
		return { supported: config.codec.startsWith("avc1") };
	}

	configure(): void {
		this.state = "configured";
	}

	encode(frame: VideoFrame, options?: VideoEncoderEncodeOptions): void {
		this.#output({
			timestamp: frame.timestamp,
			type: options?.keyFrame ? "key" : "delta",
			byteLength: 1,
			copyTo: (buffer: Uint8Array) => {
				buffer[0] = 0;
			},
		} as EncodedVideoChunk);
	}

	close(): void {
		this.state = "closed";
	}
}

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

class TestFrame {
	readonly codedWidth = 640;
	readonly codedHeight = 480;
	readonly timestamp: number;

	constructor(timestamp: number) {
		this.timestamp = timestamp;
	}

	clone(): TestFrame {
		return new TestFrame(this.timestamp);
	}
	close(): void {}
}

/** One encoded audio frame as WebCodecs hands it over. */
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

function installFakeCodecs() {
	const names = ["VideoEncoder", "AudioEncoder", "AudioDecoder"] as const;
	const originals = names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
	const values: Record<string, unknown> = {
		VideoEncoder: InstantVideoEncoder,
		AudioEncoder: FakeAudioEncoder,
		// The Opus polyfill loads whenever either half is missing, and it cannot run here.
		AudioDecoder: class {},
	};
	for (const name of names) {
		Object.defineProperty(globalThis, name, { configurable: true, value: values[name], writable: true });
	}

	return {
		[Symbol.dispose]() {
			for (const [name, original] of originals) {
				if (original) Object.defineProperty(globalThis, name, original);
				else Reflect.deleteProperty(globalThis, name);
			}
		},
	};
}

/** Let the effect graph, the codec probe and the encoders' spawned setup settle. */
async function settle(millis = 20): Promise<void> {
	for (let i = 0; i < 20; i++) await Promise.resolve();
	await new Promise((resolve) => setTimeout(resolve, millis));
}

// Drains whatever a subscriber can read without waiting and reports the frame timestamps it
// reached, keeping the read it had to abandon so the next drain starts where this one stopped:
// recvGroup hands each group out exactly once, including to a read nobody waited for.
function draining(subscriber: Moq.Track.Subscriber): () => Promise<number[]> {
	let pending: Promise<Moq.Group.Consumer | undefined> | undefined;

	return async () => {
		const timestamps: number[] = [];
		for (;;) {
			pending ??= subscriber.recvGroup();
			const read = pending;
			// Everything written has settled by the time this is called, so a read that has to wait
			// for the next macrotask is a read past the live edge.
			const idle = new Promise<"idle">((resolve) => setTimeout(() => resolve("idle"), 0));
			const group = await Promise.race([read, idle]);
			if (group === "idle") return timestamps;
			pending = undefined;
			if (!group) return timestamps;
			const payload = await group.readFrame();
			if (payload) timestamps.push(Number(Moq.Varint.decode(payload.payload)[0]));
		}
	};
}

// The newest catalog a subscriber can read without waiting. A newcomer is seeded with the current
// catalog, so this is what its first read lands on.
async function latestCatalog(subscriber: Moq.Track.Subscriber): Promise<Catalog.Root | undefined> {
	let latest: Catalog.Root | undefined;
	for (;;) {
		const idle = new Promise<"idle">((resolve) => setTimeout(() => resolve("idle"), 0));
		const group = await Promise.race([subscriber.recvGroup(), idle]);
		if (group === "idle" || !group) return latest;
		latest = (await group.readJson()) as Catalog.Root | undefined;
	}
}

// One watcher: its own consumer handle onto the publisher's broadcast, plus whichever of the three
// tracks it currently wants. Every handle shares the publisher's one track producer per name, which
// is what a relay serving several watchers off one upstream subscription does.
class Watcher {
	readonly front: Moq.Broadcast.Consumer;

	catalog: Moq.Track.Subscriber | undefined;
	video: Moq.Track.Subscriber | undefined;
	audio: Moq.Track.Subscriber | undefined;

	#video: (() => Promise<number[]>) | undefined;
	#audio: (() => Promise<number[]>) | undefined;

	readonly label: string;

	constructor(label: string, net: Moq.Broadcast.Producer) {
		this.label = label;
		this.front = net.consume();
	}

	joinCatalog(): void {
		this.catalog = this.front.subscribe(Broadcast.CATALOG_TRACK);
	}

	joinVideo(): void {
		this.video = this.front.subscribe("video");
		this.#video = draining(this.video);
	}

	joinAudio(): void {
		this.audio = this.front.subscribe("audio");
		this.#audio = draining(this.audio);
	}

	// A watcher hiding a tile or muting resets the subscribe stream, which is what the peer's
	// close looks like on the wire ("remote error: 1").
	leaveVideo(): void {
		this.video?.close(new Error("remote error: 1"));
		this.video = undefined;
		this.#video = undefined;
	}

	leaveAudio(): void {
		this.audio?.close(new Error("remote error: 1"));
		this.audio = undefined;
		this.#audio = undefined;
	}

	leave(): void {
		this.leaveVideo();
		this.leaveAudio();
		this.catalog?.close(new Error("remote error: 1"));
		this.catalog = undefined;
		this.front.close();
	}

	drainVideo(): Promise<number[]> {
		if (!this.#video) throw new Error(`${this.label} is not watching video`);
		return this.#video();
	}

	drainAudio(): Promise<number[]> {
		if (!this.#audio) throw new Error(`${this.label} is not watching audio`);
		return this.#audio();
	}

	// Every track this watcher still wants must still be live: a producer closed under it ends the
	// subscription for good on the wire, whatever the catalog keeps advertising.
	live(): string[] {
		const dead: string[] = [];
		for (const [name, subscriber] of [
			["catalog", this.catalog],
			["video", this.video],
			["audio", this.audio],
		] as const) {
			if (subscriber && subscriber.closed.peek() !== undefined) dead.push(`${this.label}/${name}`);
		}
		return dead;
	}
}

// Three watchers joining and leaving audio and video at staggered moments, against one browser-style
// publisher. Everything a watcher does (mute, hide, close the tab) reaches the publisher as a
// subscribe stream opening or resetting, and every watcher shares the one track producer per name,
// so one watcher leaving must not end the track under the ones that stayed. That is the failure the
// bench kept reproducing: a tile freezes, or audio restarts its timeline, because a producer was
// released on the first watcher that left rather than the last.
//
// A stability pin rather than a guard on one fix: the single-watcher regressions already have their
// own tests (a rendition kept open across a hide, a catalog re-seeded for the next viewer), and what
// this adds is that they still hold when the watchers overlap. Drop the weak-dedup fast path in
// `net.subscribe` and it fails at the first drain, with B reading nothing while A reads the group.
test("several watchers joining and leaving audio and video keep both tracks live", async () => {
	using _codecs = installFakeCodecs();

	let controller!: ReadableStreamDefaultController<VideoFrame>;
	const stream = new ReadableStream<VideoFrame>({
		start: (next) => {
			controller = next;
		},
	});
	const fanout = new Fanout(stream, {
		queue: 128,
		clone: (frame) => (frame as unknown as TestFrame).clone() as never,
		release: (frame) => frame.close(),
	});

	const origin = new Moq.Origin.Producer();
	const announced = origin.announced();
	const announcements: Array<{ path: string; kind: Moq.Announce.Kind }> = [];
	const pump = (async () => {
		for (;;) {
			const event = await announced.next();
			if (!event) return;
			announcements.push({ path: event.path, kind: event.kind });
		}
	})();

	const broadcast = new Broadcast({
		enabled: true,
		origin,
		name: Moq.Path.from("call.hang"),
		display: { width: 640, height: 480 },
	});

	const videoCapture = {
		in: {
			source: new Signal({ getSettings: () => ({ frameRate: 30 }), getConstraints: () => ({}) } as never),
		},
		out: {
			display: new Signal({ width: 640, height: 480 }),
			frames: new Signal(fanout),
		},
	};
	const audioCapture = {
		in: { source: new Signal(undefined) },
		out: {
			root: new Signal(undefined),
			format: new Signal<{ sampleRate: number; channelCount: number } | undefined>({
				sampleRate: 48_000,
				channelCount: 1,
			}),
			frames: new Signal(undefined),
		},
	};

	const video = new Video.Encoder("video", {
		enabled: true,
		broadcast,
		capture: videoCapture as never,
		config: { frameRate: 30 },
	});
	const audio = new Audio.Encoder("audio", { enabled: true, broadcast, capture: audioCapture as never });

	const watchers: Watcher[] = [];
	// The video encoder only opens a group on a keyframe, so each capture is spaced past the
	// keyframe interval: one group per frame, which is what makes a lost group visible below.
	let captured = 1_000_000;
	let sampled = 0;

	// One captured frame and one encoded audio frame, which is what every live subscription should
	// see land.
	const publish = async (frames = 1) => {
		for (let i = 0; i < frames; i++) {
			captured += 3_000_000;
			controller.enqueue(new TestFrame(captured) as never);
			sampled += 20_000;
			FakeAudioEncoder.last?.output(chunk(sampled, 20_000));
			await settle();
		}
	};

	// Nobody's subscription may have been ended under them, ever.
	const expectLive = (moment: string) => {
		const dead = watchers.flatMap((watcher) => watcher.live());
		expect([moment, dead]).toEqual([moment, []]);
	};

	// Every watcher still on the track reached the same live edge, and reached one: they share a
	// single producer, so a watcher left behind is the producer going away under it.
	const expectSame = async (moment: string, group: Watcher[], drain: (w: Watcher) => Promise<number[]>) => {
		const first = await drain(group[0]);
		expect([moment, group[0].label, first.length > 0]).toEqual([moment, group[0].label, true]);
		for (const watcher of group.slice(1)) {
			// Compare the edge rather than the whole drain: a subscriber serves the live edge and
			// drops the backlog it could never play, so how many groups it kept is its own business.
			expect([moment, watcher.label, (await drain(watcher)).at(-1)]).toEqual([
				moment,
				watcher.label,
				first.at(-1),
			]);
		}
		return first;
	};
	const expectSameVideo = (moment: string, group: Watcher[]) =>
		expectSame(moment, group, (watcher) => watcher.drainVideo());
	const expectSameAudio = (moment: string, group: Watcher[]) =>
		expectSame(moment, group, (watcher) => watcher.drainAudio());

	try {
		await settle(200);
		const net = broadcast.net.peek();
		if (!net) throw new Error("expected a network producer once published");

		// Three watchers join, each with its own consumer handle, catalog first the way a player does.
		const a = new Watcher("A", net);
		const b = new Watcher("B", net);
		const c = new Watcher("C", net);
		watchers.push(a, b, c);
		for (const watcher of watchers) {
			watcher.joinCatalog();
			watcher.joinVideo();
			watcher.joinAudio();
		}
		await settle(50);

		// Each one is seeded with a catalog carrying both renditions: without it a watcher has
		// nothing to choose a decoder from, however well the media tracks are flowing.
		for (const watcher of watchers) {
			if (!watcher.catalog) throw new Error("expected a catalog subscription");
			const catalog = await latestCatalog(watcher.catalog);
			expect([watcher.label, catalog?.video?.renditions.video?.codec?.startsWith("avc1")]).toEqual([
				watcher.label,
				true,
			]);
			expect([watcher.label, catalog?.audio?.renditions.audio?.codec]).toEqual([watcher.label, "opus"]);
		}

		await publish(2);
		await expectSameVideo("everyone watching", [a, b, c]);
		await expectSameAudio("everyone watching", [a, b, c]);
		expectLive("everyone watching");

		// A mutes. B and C keep audio, so the audio track has to keep running: the publisher never
		// stopped capturing and the timeline never re-anchors.
		a.leaveAudio();
		await settle();
		const beforeMute = sampled;
		// Three seconds of audio at 20ms a frame, plus the video that kept flowing.
		for (let i = 0; i < 150; i++) {
			sampled += 20_000;
			FakeAudioEncoder.last?.output(chunk(sampled, 20_000));
		}
		await publish();
		expect(sampled - beforeMute).toBe(3_020_000);

		// B and C are at the live edge of a timeline that never stopped, three seconds past the mute.
		const muted = await expectSameAudio("A muted", [b, c]);
		expect(muted.at(-1)).toBe(sampled);
		expectLive("A muted");

		// C hides its video tile. A and B keep it, so the video track has to keep running too.
		c.leaveVideo();
		await settle();
		await publish(2);
		await expectSameVideo("C hid video", [a, b]);
		expectLive("C hid video");

		// A unmutes. The subscription lands on the same live track at the live edge rather than on a
		// finished one, so the audio it resumes with is where the video is.
		a.joinAudio();
		await settle();
		await publish();
		const resumed = await a.drainAudio();
		expect(resumed.at(-1)).toBe(sampled);
		expectLive("A unmuted");

		// B closes the tab outright: every one of its subscriptions resets at once.
		b.leave();
		watchers.splice(watchers.indexOf(b), 1);
		await settle();
		await publish(2);
		await expectSameVideo("B left", [a]);
		await expectSameAudio("B left", [a, c]);
		expectLive("B left");

		// And a watcher arriving after all of that is seeded with the catalog and served both tracks,
		// which is the case that used to starve: the publisher had already served its first viewer.
		const d = new Watcher("D", net);
		watchers.push(d);
		d.joinCatalog();
		d.joinVideo();
		d.joinAudio();
		await settle(50);

		if (!d.catalog) throw new Error("expected a catalog subscription");
		const catalog = await latestCatalog(d.catalog);
		expect(catalog?.video?.renditions.video?.codec?.startsWith("avc1")).toBe(true);
		expect(catalog?.audio?.renditions.audio?.codec).toBe("opus");

		await publish(2);
		await expectSameVideo("D joined", [a, d]);
		await expectSameAudio("D joined", [a, c, d]);
		expectLive("D joined");

		// The broadcast was announced once and stayed announced: watchers coming and going are
		// subscriptions, not publications, so a relay must never see it withdrawn and re-offered.
		expect(announcements).toEqual([{ path: "call.hang", kind: "announced" }]);
	} finally {
		for (const watcher of watchers) watcher.leave();
		video.close();
		audio.close();
		broadcast.close();
		fanout.close();
		announced.close();
		await pump;
	}
});

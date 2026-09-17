import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import type * as Catalog from "@moq/hang/catalog";
import { Group, Broadcast as MoqBroadcast, Time, Varint } from "@moq/net";
import { Signal } from "@moq/signals";
import type { Decoder as DecoderType } from "./decoder";

// The worklet is compiled to a blob URL by a vite plugin, which `bun test` has no loader for. The
// modules under test are imported after the mock, since a static import would load it first.
mock.module("./render-worklet.ts?worklet", () => ({ default: "blob:render-worklet" }));

const { Decoder } = await import("./decoder");
const { Source } = await import("./source");
const { Sync } = await import("../sync");

/**
 * Minimal AudioContext stand-in that counts the contexts the decoder builds.
 *
 * The identity of the context is the whole point: a context is the only thing a user gesture
 * starts, so replacing one is losing the gesture that started it.
 */
class MockContext extends EventTarget {
	static built: MockContext[] = [];

	// Whether a user gesture is being dispatched, which is the only time WebKit starts a context.
	static activation = false;

	state = "suspended";
	resumeCalls = 0;
	readonly sampleRate: number;
	readonly audioWorklet = { addModule: async () => {} };

	constructor(options: { sampleRate: number }) {
		super();
		this.sampleRate = options.sampleRate;
		MockContext.built.push(this);
	}

	resume(): Promise<void> {
		this.resumeCalls++;
		if (!MockContext.activation) return Promise.reject(new Error("not allowed"));
		this.state = "running";
		this.dispatchEvent(new Event("statechange"));
		return Promise.resolve();
	}

	close(): Promise<void> {
		this.state = "closed";
		return Promise.resolve();
	}
}

/** One click on the page: a gesture, and the activation that goes with it. */
function click(): void {
	MockContext.activation = true;
	document.dispatchEvent(new Event("pointerdown"));
	MockContext.activation = false;
}

/**
 * Enough of WebCodecs for the decode loop to run. It decodes nothing: these cases are about what
 * the decoder subscribes to and what it measures, both of which sit above the codec.
 */
class MockAudioDecoder {
	state = "configured";
	configure(): void {}
	decode(): void {}
	reset(): void {}
	close(): void {
		this.state = "closed";
	}
	async flush(): Promise<void> {}
}

/** Enough of an AudioWorkletNode for the ring to be built against. */
class MockWorkletNode {
	readonly port = { postMessage: () => {}, onmessage: null, addEventListener: () => {}, start: () => {} };
	connect(): void {}
	disconnect(): void {}
}

/** One Opus rendition, optionally carrying the codec description the publisher adds later. */
function catalog(description?: Uint8Array, jitter?: number): Catalog.Root {
	// Cast rather than branded: the schema brands the integers, and a literal is what a catalog
	// frame decodes to anyway.
	const config = {
		codec: "opus",
		container: { kind: "legacy" },
		sampleRate: 48000,
		numberOfChannels: 2,
		...(jitter !== undefined ? { jitter } : {}),
	} as unknown as Catalog.AudioConfig;
	return {
		audio: { renditions: { audio: description ? { ...config, description } : config } },
	} as unknown as Catalog.Root;
}

// Drain microtasks and the spawned worklet load so scheduled effect (re)runs settle.
const flush = async () => {
	for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

let originals: {
	document: typeof globalThis.document;
	context: unknown;
	worklet: unknown;
	audioDecoder: unknown;
	audioEncoder: unknown;
	chunk: unknown;
};

beforeEach(() => {
	originals = {
		document: globalThis.document,
		context: (globalThis as Record<string, unknown>).AudioContext,
		worklet: (globalThis as Record<string, unknown>).AudioWorkletNode,
		audioDecoder: (globalThis as Record<string, unknown>).AudioDecoder,
		audioEncoder: (globalThis as Record<string, unknown>).AudioEncoder,
		chunk: (globalThis as Record<string, unknown>).EncodedAudioChunk,
	};
	globalThis.document = new EventTarget() as unknown as Document;
	(globalThis as Record<string, unknown>).AudioContext = MockContext;
	(globalThis as Record<string, unknown>).AudioWorkletNode = MockWorkletNode;
	// Present, so the libav polyfill resolves without loading anything.
	(globalThis as Record<string, unknown>).AudioDecoder = MockAudioDecoder;
	(globalThis as Record<string, unknown>).AudioEncoder = class {};
	(globalThis as Record<string, unknown>).EncodedAudioChunk = class {};
	MockContext.built = [];
	MockContext.activation = false;
});

afterEach(() => {
	globalThis.document = originals.document;
	(globalThis as Record<string, unknown>).AudioContext = originals.context;
	(globalThis as Record<string, unknown>).AudioWorkletNode = originals.worklet;
	(globalThis as Record<string, unknown>).AudioDecoder = originals.audioDecoder;
	(globalThis as Record<string, unknown>).AudioEncoder = originals.audioEncoder;
	(globalThis as Record<string, unknown>).EncodedAudioChunk = originals.chunk;
});

/** A decoder fed by a catalog signal, the way `<moq-watch>` wires one up. */
function decoder(
	enabled: boolean,
	props?: { catalog?: Catalog.Root; active?: MoqBroadcast.Consumer },
): {
	decoder: DecoderType;
	catalog: Signal<Catalog.Root | undefined>;
	enabled: Signal<boolean>;
	close: () => void;
} {
	const root = new Signal<Catalog.Root | undefined>(props?.catalog ?? catalog());
	// Only the two members the audio source and decoder read off a Broadcast.
	const broadcast = { out: { catalog: root }, relativeBroadcast: () => props?.active };
	const source = new Source({
		broadcast: new Signal(broadcast as never),
		supported: async () => true,
	});
	const sync = new Sync({ delay: new Signal("auto" as const), buffer: new Signal(Time.Milli.zero) });
	const downloading = new Signal(enabled);
	const built = new Decoder(source, sync, { enabled: downloading });
	return {
		decoder: built,
		catalog: root,
		enabled: downloading,
		close: () => {
			built.close();
			sync.close();
			source.close();
		},
	};
}

test("a gesture on a muted tile starts the context", async () => {
	// The demo page's tiles start muted and the click that selects one is what unmutes it, so a
	// listener armed because audio became enabled is armed a microtask after its own gesture has
	// already passed. WebKit then only has the few seconds of the page's activation to start the
	// context on a later attempt, and a viewer whose audio arrives after that hears nothing at all.
	const { decoder: built, close } = decoder(false);
	await flush();

	const context = built.out.context.peek() as unknown as MockContext;
	expect(context).toBeDefined();
	expect(context.state).toBe("suspended");

	click();
	expect(context.state).toBe("running");

	close();
});

test("a catalog frame that only adds the codec description keeps the running context", async () => {
	// Measured on real Safari: the publisher's Opus rendition gains its `description` in a later
	// catalog frame, which used to rebuild the whole graph. The replacement context was born
	// suspended with the gesture already spent, so one run in eight played video in silence forever.
	const { decoder: built, catalog: root, close } = decoder(true);
	await flush();

	const context = built.out.context.peek() as unknown as MockContext;
	click();
	expect(context.state).toBe("running");
	expect(MockContext.built.length).toBe(1);

	root.set(catalog(new Uint8Array([1, 2, 3])));
	await flush();

	expect(built.out.context.peek()).toBe(context as unknown as AudioContext);
	expect(context.state).toBe("running");
	expect(MockContext.built.length).toBe(1);

	close();
});

/** One legacy container frame: the media timestamp, then a payload nothing here decodes. */
function encodeLegacy(timestamp: Time.Micro): Uint8Array {
	const ts = Varint.encode(timestamp);
	const frame = new Uint8Array(ts.byteLength + 2);
	frame.set(ts, 0);
	frame.set([0xde, 0xad], ts.byteLength);
	return frame;
}

function writeGroup(track: { writeGroup: (group: Group.Producer) => void }, sequence: number, timestamp: number) {
	const group = new Group.Producer(sequence);
	group.writeFrame({ payload: encodeLegacy(timestamp as Time.Micro), timestamp: Time.Timestamp.now() });
	group.close();
	track.writeGroup(group);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test("unmuting continues the arrival estimate rather than starting over at the declaration", async () => {
	// Muting stops the download, so unmuting subscribes again and builds a second container
	// consumer. The path is the one that was already measured: reseeding it from the publisher's
	// declaration parks the playhead for the declared span on every unmute, which is the whole of
	// the fill a viewer sees as a spinner over video that never stopped.
	const producer = new MoqBroadcast.Producer();
	const track = producer.createTrack("audio");
	const {
		decoder: built,
		enabled,
		close,
	} = decoder(true, { catalog: catalog(undefined, 302), active: producer.consume() });
	await flush();

	// The declared flush span, rounded up to a whole bucket, is where it starts.
	expect(built.out.spread.peek()).toBe(320 as Time.Milli);

	// A prompt pair sets the arrival baseline, then one 600ms later closes the estimator's first
	// resample interval, which is what replaces the declaration with a measurement.
	writeGroup(track, 0, 0);
	writeGroup(track, 1, 20_000);
	await sleep(600);
	writeGroup(track, 2, 40_000);
	await flush();

	const measured = built.out.spread.peek();
	expect(measured).toBeDefined();
	expect(measured).toBeLessThan(320 as Time.Milli);

	// Muted: the download stops and the consumer goes with it. What Sync knows about this track
	// must not go too, or the delay collapses and then deepens on the way back, which is the
	// decoder's cue to park the playhead a second time (see #runLatencyReanchor).
	enabled.set(false);
	await flush();
	expect(built.out.spread.peek()).toBe(measured);

	// The publisher keeps going while nobody is listening, so by the time the download comes back
	// the track is holding far more media than the age budget allows anyone to play.
	for (let i = 0; i < 20; i++) writeGroup(track, 3 + i, 60_000 + i * 20_000);
	await flush();

	enabled.set(true);
	await flush();
	expect(built.out.spread.peek()).toBe(measured);

	// The replacement subscription starts at the live edge, so there is no stale backlog for the
	// age budget to convict. Replaying it is the `skipping slow group: track=audio` a viewer sees
	// on every unmute.
	expect(built.out.skipped.peek()).toBe(0);

	close();
	producer.close();
});

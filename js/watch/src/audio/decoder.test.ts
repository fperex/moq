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

// What a context runs at when it is built without a rate, as the bench's output device does.
const DEVICE_RATE = 48000;

/**
 * Minimal AudioContext stand-in that counts the contexts the decoder builds.
 *
 * The identity of the context is the whole point: a context is the only thing a user gesture
 * starts, so replacing one is losing the gesture that started it, and building one before any
 * gesture is a suspended context and an autoplay warning per tile.
 */
class MockContext extends EventTarget {
	static built: MockContext[] = [];

	// Whether a user gesture is being dispatched, which is the one moment WebKit always starts a
	// context.
	static activation = false;

	// Whether the page's activation is still live: the few seconds after a gesture during which
	// WebKit also honours a resume() from outside a handler.
	static grace = false;

	// Whether the browser's autoplay policy starts a context with no gesture at all, which is how
	// the audio-quality lane launches Chromium.
	static autoplay = false;

	state = "suspended";
	resumeCalls = 0;
	readonly sampleRate: number;
	readonly audioWorklet = { addModule: async () => {} };

	constructor(options?: { sampleRate?: number }) {
		super();
		// No rate asked for means the device default, which is what a context built before the
		// catalog arrives runs at.
		this.sampleRate = options?.sampleRate ?? DEVICE_RATE;
		MockContext.built.push(this);
	}

	/** Every context built and not yet closed, which is what "one context per tile" counts. */
	static live(): MockContext[] {
		return MockContext.built.filter((context) => context.state !== "closed");
	}

	resume(): Promise<void> {
		this.resumeCalls++;
		if (!MockContext.activation && !MockContext.grace && !MockContext.autoplay) {
			return Promise.reject(new Error("not allowed"));
		}
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

/** One Opus rendition, with the fields a case varies: the codec description a publisher adds later,
 * the declared arrival spread, and the rate the graph has to run at. */
function catalog(props?: { description?: Uint8Array; jitter?: number; rate?: number }): Catalog.Root {
	// Cast rather than branded: the schema brands the integers, and a literal is what a catalog
	// frame decodes to anyway.
	const config = {
		codec: "opus",
		container: { kind: "legacy" },
		sampleRate: props?.rate ?? DEVICE_RATE,
		numberOfChannels: 2,
		...(props?.jitter !== undefined ? { jitter: props.jitter } : {}),
		...(props?.description ? { description: props.description } : {}),
	} as unknown as Catalog.AudioConfig;
	return {
		audio: { renditions: { audio: config } },
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
	MockContext.grace = false;
	MockContext.autoplay = false;
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

test("a muted tile builds no context before the first gesture", async () => {
	// A context built for a tile nobody has asked to hear is a context nothing can start: Chromium
	// logs "The AudioContext was not allowed to start" for each one and each holds a render thread,
	// three of each on the demo page's three muted tiles. The catalog is already here and it still
	// builds nothing.
	const first = decoder(false);
	const second = decoder(false);
	await flush();

	expect(MockContext.built.length).toBe(0);
	expect(first.decoder.out.context.peek()).toBeUndefined();
	expect(second.decoder.out.context.peek()).toBeUndefined();

	first.close();
	second.close();
});

test("enabling without any gesture builds one context and it runs when the browser allows autoplay", async () => {
	// The audio-quality lane launches Chromium with --autoplay-policy=no-user-gesture-required and
	// its page sets `muted = false` without ever clicking, so audio that is asked for has to get a
	// graph and a resume() attempt of its own. A browser that refuses the attempt leaves that same
	// context suspended until a gesture; it is never a second context.
	MockContext.autoplay = true;
	const { decoder: built, close } = decoder(true);
	await flush();

	const context = built.out.context.peek() as unknown as MockContext;
	expect(context).toBeDefined();
	expect(context.state).toBe("running");
	expect(MockContext.live().length).toBe(1);

	close();
});

test("a tile the app enabled stays suspended under a strict policy until a gesture", async () => {
	const { decoder: built, close } = decoder(true);
	await flush();

	const context = built.out.context.peek() as unknown as MockContext;
	expect(context.state).toBe("suspended");

	click();
	expect(context.state).toBe("running");
	expect(MockContext.built.length).toBe(1);

	close();
});

test("a gesture on a muted tile builds and starts the context", async () => {
	// The demo page's tiles start muted and the click that selects one is what unmutes it, so a
	// listener armed because audio became enabled is armed a microtask after its own gesture has
	// already passed. WebKit then only has the few seconds of the page's activation to start the
	// context on a later attempt, and a viewer whose audio arrives after that hears nothing at all.
	const { decoder: built, close } = decoder(false);
	await flush();

	click();

	// Built inside the handler and started there: the gesture is not handed to an effect that runs
	// after it has passed.
	const context = built.out.context.peek() as unknown as MockContext;
	expect(context).toBeDefined();
	expect(context.state).toBe("running");
	expect(built.out.sampleRate.peek()).toBe(DEVICE_RATE);

	close();
});

test("the first gesture builds and starts one context per tile", async () => {
	// Every tile arms its own listeners on the document, so one click is spent on all of them at
	// once. Each tile gets exactly one context out of it, whether or not it is the tile clicked.
	// Both muted, so the gesture is the only thing that could have built them.
	const first = decoder(false);
	const second = decoder(false);
	await flush();

	click();

	expect(MockContext.live().length).toBe(2);
	for (const tile of [first, second]) {
		const context = tile.decoder.out.context.peek() as unknown as MockContext;
		expect(context.state).toBe("running");
	}

	// A second gesture is spent on the contexts that already exist, not on new ones.
	click();
	expect(MockContext.built.length).toBe(2);

	first.close();
	second.close();
});

test("a catalog frame that only adds the codec description keeps the running context", async () => {
	// Measured on real Safari: the publisher's Opus rendition gains its `description` in a later
	// catalog frame, which used to rebuild the whole graph. The replacement context was born
	// suspended with the gesture already spent, so one run in eight played video in silence forever.
	const { decoder: built, catalog: root, close } = decoder(true);
	await flush();

	click();
	const context = built.out.context.peek() as unknown as MockContext;
	expect(context.state).toBe("running");
	expect(MockContext.built.length).toBe(1);

	root.set(catalog({ description: new Uint8Array([1, 2, 3]) }));
	await flush();

	expect(built.out.context.peek()).toBe(context as unknown as AudioContext);
	expect(context.state).toBe("running");
	expect(MockContext.built.length).toBe(1);

	close();
});

test("a gesture before the catalog builds at the device default, and the real rate replaces it", async () => {
	// The tile is clicked for a broadcast that has not started yet, so there is no rate to build at
	// and waiting for one would mean waiting past the gesture. The device default is what a context
	// built with no rate runs at, and it is kept if the catalog turns out to agree with it.
	const { decoder: built, catalog: root, close } = decoder(true, { catalog: {} as Catalog.Root });
	await flush();

	expect(MockContext.built.length).toBe(0);

	click();
	const first = built.out.context.peek() as unknown as MockContext;
	expect(first.sampleRate).toBe(DEVICE_RATE);
	expect(first.state).toBe("running");

	// The broadcast starts at a rate the device does not run at, which is the one change a context
	// cannot absorb.
	MockContext.grace = true;
	root.set(catalog({ rate: 44100 }));
	await flush();

	const second = built.out.context.peek() as unknown as MockContext;
	expect(second.sampleRate).toBe(44100);
	expect(second.state).toBe("running");
	expect(MockContext.live().length).toBe(1);

	close();
});

test("a rate change after the gesture rebuilds inside the grace and re-arms outside it", async () => {
	// A context's rate is fixed for its lifetime, so the rate the decoder turns out to emit is the
	// one change that has to replace it. The replacement is built outside the handler, so whether it
	// starts depends on the page's activation still being live; the listeners stay armed either way.
	const { decoder: built, catalog: root, close } = decoder(true);
	await flush();

	click();
	const first = built.out.context.peek() as unknown as MockContext;
	expect(first.sampleRate).toBe(DEVICE_RATE);

	// Inside the grace: the replacement starts on its own, with nothing for the viewer to do.
	MockContext.grace = true;
	root.set(catalog({ rate: 44100 }));
	await flush();

	const second = built.out.context.peek() as unknown as MockContext;
	expect(second).not.toBe(first);
	expect(second.sampleRate).toBe(44100);
	expect(second.state).toBe("running");
	expect(first.state).toBe("closed");
	expect(MockContext.live().length).toBe(1);

	// Outside it: the replacement is born suspended and has to be armed again rather than assumed
	// started, which is how the one-in-eight silent run happened.
	MockContext.grace = false;
	root.set(catalog({ rate: 32000 }));
	await flush();

	const third = built.out.context.peek() as unknown as MockContext;
	expect(third.sampleRate).toBe(32000);
	expect(third.state).toBe("suspended");
	expect(second.state).toBe("closed");
	expect(MockContext.live().length).toBe(1);

	click();
	expect(third.state).toBe("running");

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
	} = decoder(true, { catalog: catalog({ jitter: 302 }), active: producer.consume() });
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

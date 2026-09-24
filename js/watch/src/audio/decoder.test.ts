import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import type * as Catalog from "@moq/hang/catalog";
import { Group, Broadcast as MoqBroadcast, Time, Varint } from "@moq/net";
import { type Effect, Signal } from "@moq/signals";
import type { Delay, Sync as SyncType } from "../sync";
import type { Decoder as DecoderType } from "./decoder";
import { STRETCH_BOUND } from "./playout";

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
	static deferModule = false;
	module?: ReturnType<typeof Promise.withResolvers<void>>;

	state = "suspended";
	resumeCalls = 0;
	readonly sampleRate: number;
	readonly audioWorklet = {
		addModule: () => {
			if (!MockContext.deferModule) return Promise.resolve();
			this.module ??= Promise.withResolvers<void>();
			return this.module.promise;
		},
	};

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
		this.module?.reject(new DOMException("Unable to load a worklet module.", "AbortError"));
		return Promise.resolve();
	}
}

/** One click on the page: a gesture, and the activation that goes with it. */
function click(): void {
	MockContext.activation = true;
	document.dispatchEvent(new Event("pointerdown"));
	MockContext.activation = false;
}

/** Enough of an EncodedAudioChunk to carry a frame's timestamp to the decoder below. */
class MockEncodedChunk {
	readonly timestamp: number;
	constructor(init: { timestamp: number }) {
		this.timestamp = init.timestamp;
	}
}

/**
 * Enough of an AudioData for the emit path: one 20ms stereo packet of a constant, copied planar.
 *
 * Stamped from the chunk that produced it, which is what a decoder anchored on that chunk emits.
 */
class MockAudioData {
	readonly format = "f32-planar";
	readonly sampleRate = DEVICE_RATE;
	readonly numberOfFrames = 960;
	readonly numberOfChannels = 2;
	readonly timestamp: number;

	constructor(timestamp: number) {
		this.timestamp = timestamp;
	}

	copyTo(dst: Float32Array): void {
		dst.fill(0.5);
	}

	close(): void {}
}

/**
 * Enough of WebCodecs for the decode loop to run: one decoded packet per chunk, so what the
 * container consumer orders reaches the ring. The codec itself is not what these cases are about.
 */
class MockAudioDecoder {
	state = "configured";
	readonly #output: (data: MockAudioData) => void;

	constructor(init: { output: (data: MockAudioData) => void }) {
		this.#output = init.output;
	}

	configure(): void {}
	decode(chunk: MockEncodedChunk): void {
		this.#output(new MockAudioData(chunk.timestamp));
	}
	reset(): void {}
	close(): void {
		this.state = "closed";
	}
	async flush(): Promise<void> {}
}

/** Enough of an AudioWorkletNode for the ring to be built against. */
class MockWorkletNode {
	static built: MockContext[] = [];
	constructor(context: MockContext) {
		MockWorkletNode.built.push(context);
	}
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
	(globalThis as Record<string, unknown>).EncodedAudioChunk = MockEncodedChunk;
	MockContext.built = [];
	MockWorkletNode.built = [];
	MockContext.activation = false;
	MockContext.grace = false;
	MockContext.autoplay = false;
	MockContext.deferModule = false;
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
	props?: { catalog?: Catalog.Root; active?: MoqBroadcast.Consumer; delay?: Signal<Delay> },
): {
	decoder: DecoderType;
	catalog: Signal<Catalog.Root | undefined>;
	enabled: Signal<boolean>;
	attached: Signal<boolean>;
	active: Signal<MoqBroadcast.Consumer | undefined>;
	sync: SyncType;
	close: () => void;
} {
	const root = new Signal<Catalog.Root | undefined>(props?.catalog ?? catalog());
	// Which broadcast is being consumed, as a signal: a publisher that restarts is announced again
	// and the element is handed a different consumer for the same name.
	const active = new Signal<MoqBroadcast.Consumer | undefined>(props?.active);
	// Only the two members the audio source and decoder read off a Broadcast.
	const broadcast = { out: { catalog: root }, relativeBroadcast: (effect: Effect) => effect.get(active) };
	const source = new Source({
		broadcast: new Signal(broadcast as never),
		supported: async () => true,
	});
	// A numeric delay is the estimator's answer, verbatim and under the test's hand: `out.delay` is
	// what the ring's target is derived from, whether a viewer fixed it or the estimator moved it.
	const sync = new Sync({
		delay: props?.delay ?? new Signal<Delay>("auto"),
		buffer: new Signal(Time.Milli.zero),
	});
	const downloading = new Signal(enabled);
	// Whether the player is on the page, which is what `<moq-watch>` feeds from its connect callbacks.
	const attached = new Signal(true);
	const built = new Decoder({ source, sync, enabled: downloading, attached });
	return {
		decoder: built,
		catalog: root,
		enabled: downloading,
		attached,
		active,
		sync,
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

test("a worklet load failure in the current context remains an error", async () => {
	MockContext.deferModule = true;
	const errors = spyOn(console, "error").mockImplementation(() => {});
	const tile = decoder(true);
	try {
		await flush();
		const failure = new Error("module failed");
		const context = MockContext.built[0];
		expect(context.module).toBeDefined();
		context.module?.reject(failure);
		await flush();
		expect(errors).toHaveBeenCalledWith("spawn error", failure);
		expect(MockWorkletNode.built).toEqual([]);
	} finally {
		tile.close();
		errors.mockRestore();
	}
});

test("a catalog rate replacing the gesture context cancels its pending worklet before closing it", async () => {
	MockContext.deferModule = true;
	const errors = spyOn(console, "error").mockImplementation(() => {});
	const tile = decoder(true, { catalog: {} as Catalog.Root });
	try {
		await flush();
		click();
		MockContext.grace = true;
		tile.catalog.set(catalog({ rate: 44100 }));
		await flush();
		const [first, second] = MockContext.built;
		expect(first.module).toBeDefined();
		expect(first.state).toBe("closed");
		expect(second.sampleRate).toBe(44100);
		expect(second.module).toBeDefined();
		second.module?.resolve();
		await flush();
		expect(tile.decoder.out.context.peek()).toBe(second as unknown as AudioContext);
		expect(MockWorkletNode.built).toEqual([second]);
		expect(errors).not.toHaveBeenCalled();
	} finally {
		tile.close();
		errors.mockRestore();
	}
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

test("a player taken off the page releases its context", async () => {
	// A context is a render thread and one of the handful a browser allows, and a player that is
	// not in the document can never be heard out of. Held past the detach, a page that cycles its
	// tiles runs out of contexts and the media lane's resource baseline never comes back to zero.
	const { decoder: built, attached, close } = decoder(true);
	await flush();

	click();
	const context = built.out.context.peek() as unknown as MockContext;
	expect(context.state).toBe("running");

	attached.set(false);
	await flush();

	expect(context.state).toBe("closed");
	expect(built.out.context.peek()).toBeUndefined();
	expect(built.out.root.peek()).toBeUndefined();
	expect(MockContext.live()).toBeEmpty();

	// The listeners stay armed for the player's lifetime, so a click anywhere on the page still
	// reaches this one. It belongs to whatever the viewer clicked, not to a tile that is gone.
	click();
	expect(MockContext.live()).toBeEmpty();

	close();
});

test("a player put back on the page builds a context again", async () => {
	const { decoder: built, attached, close } = decoder(true);
	await flush();

	click();
	const first = built.out.context.peek() as unknown as MockContext;

	attached.set(false);
	await flush();
	expect(first.state).toBe("closed");

	// The page keeps its activation across the detach (Chromium's is sticky for the document's
	// lifetime), so the replacement starts without asking the viewer to click again. Where it does
	// not, unlockOnGesture is still armed and spends the next gesture on it.
	MockContext.grace = true;
	attached.set(true);
	await flush();

	const second = built.out.context.peek() as unknown as MockContext;
	expect(second).toBeDefined();
	expect(second).not.toBe(first as unknown as MockContext);
	expect(second.state).toBe("running");
	expect(built.out.root.peek()).toBeDefined();
	expect(MockContext.live().length).toBe(1);

	close();
});

test("a viewer muting a tile keeps the context it is playing", async () => {
	// Muting stops the download, and the graph stays up behind it: rebuilding would spend a gesture
	// on the unmute, which is the one thing a viewer cannot be asked for twice.
	const { decoder: built, enabled, close } = decoder(true);
	await flush();

	click();
	const context = built.out.context.peek() as unknown as MockContext;
	expect(context.state).toBe("running");

	enabled.set(false);
	await flush();

	expect(built.out.context.peek()).toBe(context as unknown as AudioContext);
	expect(context.state).toBe("running");

	enabled.set(true);
	await flush();

	expect(built.out.context.peek()).toBe(context as unknown as AudioContext);
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

test("a tune-in gap before the first decoded callback keeps audio on the source timeline", async () => {
	class DeferredDecoder extends MockAudioDecoder {
		readonly output: (data: MockAudioData) => void;
		pending: MockAudioData[] = [];
		next: number | undefined;

		constructor(init: { output: (data: MockAudioData) => void }) {
			super(init);
			this.output = init.output;
		}

		override decode(chunk: MockEncodedChunk): void {
			this.next ??= chunk.timestamp;
			this.pending.push(new MockAudioData(this.next));
			this.next += 20_000;
			setTimeout(() => this.drain(), 0);
		}
		drain(): void {
			for (const sample of this.pending.splice(0)) this.output(sample);
		}
		override async flush(): Promise<void> {
			this.drain();
		}
		override reset(): void {
			this.next = undefined;
			this.pending = [];
		}
	}
	Object.assign(globalThis, { AudioDecoder: DeferredDecoder });
	const producer = new MoqBroadcast.Producer();
	const track = producer.createTrack("audio");
	const tile = decoder(true, { active: producer.consume() });
	try {
		await flush();
		writeGroup(track, 0, 1_000_000);
		for (let i = 0; i < 6; i++) writeGroup(track, i + 1, 2_140_000 + i * 20_000);
		await flush();
		expect(tile.decoder.out.buffered.peek().at(-1)?.end).toBe(Time.Milli(2_260));
	} finally {
		tile.close();
		producer.close();
	}
});

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

test("a rendition that leaves the catalog and comes back keeps its arrival estimate", async () => {
	// A publisher hiding a source takes the rendition out of the catalog for a few hundred
	// milliseconds and then puts the same one back. That is a gap in one rendition, not a new one:
	// the path and the publisher's claim about it are unchanged, so what was measured on it still
	// holds. Building a fresh estimator there republishes the declaration as though something had
	// measured it, and Sync holds every track to the widest reading, so one track's guess deepens
	// the buffer every other track has already measured and the audio ring is resized mid-playback.
	const producer = new MoqBroadcast.Producer();
	const track = producer.createTrack("audio");
	const rendition = catalog({ jitter: 302 });
	const { decoder: built, catalog: root, close } = decoder(true, { catalog: rendition, active: producer.consume() });
	await flush();

	writeGroup(track, 0, 0);
	writeGroup(track, 1, 20_000);
	await sleep(600);
	writeGroup(track, 2, 40_000);
	await flush();

	const measured = built.out.spread.peek();
	expect(measured).toBeDefined();
	expect(measured).toBeLessThan(320 as Time.Milli);

	// The source goes. A departed track must stop holding the buffer open.
	root.set({ audio: { renditions: {} } } as unknown as Catalog.Root);
	await flush();
	expect(built.out.spread.peek()).toBeUndefined();

	// And comes back as the same rendition, with the measurement it left behind.
	root.set(rendition);
	await flush();
	expect(built.out.spread.peek()).toBe(measured);

	close();
	producer.close();
});

/** The endpoint a muting publisher writes: an empty codec payload, alone in its group. */
function writeMarker(track: { writeGroup: (group: Group.Producer) => void }, sequence: number, timestamp: number) {
	const group = new Group.Producer(sequence);
	group.writeFrame({
		payload: Varint.encode(timestamp),
		timestamp: Time.Timestamp.fromMicros(timestamp as Time.Micro),
	});
	group.close();
	track.writeGroup(group);
}

test("a publisher's mute and unmute play the resumed audio", async () => {
	const producer = new MoqBroadcast.Producer();
	const track = producer.createTrack("audio");
	const { decoder: built, close } = decoder(true, { catalog: catalog(), active: producer.consume() });
	await flush();

	// Six 20ms frames, since the legacy warmup drops the first three decoder callbacks.
	for (let i = 0; i < 6; i++) writeGroup(track, i, i * 20_000);
	await sleep(60);
	await flush();

	const before = built.out.debug.peek();
	expect(before?.buffered).toBeGreaterThan(0);
	const playhead = built.out.timestamp.peek();
	expect(playhead).toBeDefined();

	// The microphone is muted: the endpoint says where the source stopped, alone in its group.
	writeMarker(track, 6, 120_000);
	await sleep(40);
	await flush();

	// Ten seconds later it is unmuted again. Nothing here is late and nothing is missing, so the
	// resumed run has to play: the endpoint bounds the run it ended, not this one.
	for (let i = 0; i < 6; i++) writeGroup(track, 7 + i, 10_000_000 + i * 20_000);
	await sleep(120);
	await flush();

	expect(built.out.skipped.peek()).toBe(0);
	const after = built.out.debug.peek();
	expect(after?.buffered).toBeGreaterThan(0);

	// The resumed run reached the ring. Applied to it instead, the endpoint trims every sample of
	// it to nothing and the ring holds only what was there before the mute.
	expect(built.out.buffered.peek().at(-1)?.start).toBeGreaterThanOrEqual(10_000 as Time.Milli);
	// And the playhead followed it. Nothing drains the ring here, so it lands where the ring's
	// capacity bounds it rather than on the resumed media itself.
	expect(built.out.timestamp.peek()).toBeGreaterThan(playhead as Time.Milli);
	expect(built.out.interrupted.peek()).toBe(false);

	close();
	producer.close();
});

test("a mute and unmute on one subscription plays on without rebuilding the ring", async () => {
	// A publisher that keeps the rendition in the catalog across a mute changes nothing a watcher
	// selects on, so the subscription, the decoder and the ring under it all survive the pause. The
	// resumed run lands in the ring that was already playing: no resubscribe to wait for, no second
	// decoder to prime, and no refill of a cushion that was never spent.
	const producer = new MoqBroadcast.Producer();
	const track = producer.createTrack("audio");
	const { decoder: built, close } = decoder(true, { catalog: catalog(), active: producer.consume() });
	await flush();

	for (let i = 0; i < 6; i++) writeGroup(track, i, i * 20_000);
	await sleep(60);
	await flush();

	// A rebuilt ring is a new worklet node, and a rebuilt context is a spent gesture.
	const worklet = built.out.root.peek();
	expect(worklet).toBeDefined();
	const spread = built.out.spread.peek();

	writeMarker(track, 6, 120_000);
	await sleep(40);
	await flush();

	for (let i = 0; i < 6; i++) writeGroup(track, 7 + i, 10_000_000 + i * 20_000);
	await sleep(120);
	await flush();

	expect(built.out.root.peek()).toBe(worklet);
	expect(MockContext.live().length).toBe(1);
	expect(built.out.spread.peek()).toBe(spread);
	expect(built.out.interrupted.peek()).toBe(false);
	expect(built.out.skipped.peek()).toBe(0);

	// The resumed run reached the ring from its first frame. A decoder primed a second time would
	// have swallowed the three callbacks the legacy warmup drops, which is 60ms of speech.
	expect(built.out.buffered.peek().at(-1)?.start).toBe(10_000 as Time.Milli);

	close();
	producer.close();
});

test("a watcher that joins while the publisher is muted waits rather than reporting a break", async () => {
	// The rendition is advertised with nothing captured behind it yet, so there is no media until
	// the first unmute. A ring nobody has played from is filling rather than stalling, and saying
	// otherwise puts a buffering overlay over video that is playing fine.
	const producer = new MoqBroadcast.Producer();
	const track = producer.createTrack("audio");
	const { decoder: built, close } = decoder(true, { catalog: catalog(), active: producer.consume() });
	await flush();
	await sleep(60);
	await flush();

	const worklet = built.out.root.peek();
	expect(worklet).toBeDefined();
	expect(built.out.interrupted.peek()).toBe(false);
	expect(built.out.debug.peek()?.fresh ?? true).toBe(true);
	expect(built.out.timestamp.peek()).toBeUndefined();

	// The publisher unmutes: the first media it captures plays on the graph already standing.
	for (let i = 0; i < 6; i++) writeGroup(track, i, 10_000_000 + i * 20_000);
	await sleep(80);
	await flush();

	expect(built.out.root.peek()).toBe(worklet);
	expect(built.out.debug.peek()?.buffered).toBeGreaterThan(0);
	expect(built.out.timestamp.peek()).toBeDefined();
	// This decoder is genuinely cold, so it still primes on the first real media. What a late
	// joiner must not pay is a second one on the unmute after it.
	expect(built.out.buffered.peek().at(-1)?.start).toBeGreaterThanOrEqual(10_000 as Time.Milli);
	expect(built.out.interrupted.peek()).toBe(false);
	expect(built.out.skipped.peek()).toBe(0);

	close();
	producer.close();
});

test("a republished broadcast is a tune-in, not a late continuation", async () => {
	// A pinned `<moq-watch reload>` survives a publisher restart: the element stays, and the
	// broadcast underneath it is replaced by a new consumer for the same name. The new encoder
	// starts its timeline where it likes, which is near zero, so everything anchored to the dead
	// publisher has to go. Kept, the ring discards every sample of the new run as too old for a
	// playhead ten seconds ahead of it, and nothing in the stream says so: a republish raises no
	// discontinuity, because nobody declared anything.
	const first = new MoqBroadcast.Producer();
	const firstTrack = first.createTrack("audio");
	const { decoder: built, active, close } = decoder(true, { catalog: catalog(), active: first.consume() });
	await flush();

	// A publisher that has been up for a while, so its timeline is well past zero.
	for (let i = 0; i < 6; i++) writeGroup(firstTrack, i, 10_000_000 + i * 20_000);
	await sleep(60);
	await flush();
	const before = built.out.debug.peek();
	expect(before?.buffered).toBeGreaterThan(0);
	expect(before?.anchor).toBeGreaterThan(10 * DEVICE_RATE);

	// It restarts: same name, a different broadcast, and a timeline that starts over.
	firstTrack.close();
	first.close();
	const second = new MoqBroadcast.Producer();
	const secondTrack = second.createTrack("audio");
	active.set(second.consume());
	await flush();

	for (let i = 0; i < 6; i++) writeGroup(secondTrack, i, i * 20_000);
	await sleep(60);
	await flush();

	// The new publisher's audio is in the ring, on its own timeline.
	const after = built.out.debug.peek();
	expect(after?.anchor).toBeLessThan(DEVICE_RATE);
	expect(after?.buffered).toBeGreaterThan(0);
	expect(built.out.buffered.peek().at(-1)?.end).toBeLessThan(1_000 as Time.Milli);

	close();
	second.close();
});

test("a replacement subscription on the same broadcast keeps the timeline it is playing", async () => {
	// The other half of the rule above. A rendition that redeclares its flush span reopens the
	// subscription and builds a new container consumer, on the same broadcast and the same
	// timeline, so the ring keeps playing what it holds. Re-anchoring there would park the playhead
	// and refill for nothing, on a stream that never stopped.
	const producer = new MoqBroadcast.Producer();
	const track = producer.createTrack("audio");
	const {
		decoder: built,
		catalog: root,
		close,
	} = decoder(true, { catalog: catalog({ jitter: 40 }), active: producer.consume() });
	await flush();

	for (let i = 0; i < 6; i++) writeGroup(track, i, 10_000_000 + i * 20_000);
	await sleep(60);
	await flush();
	const anchor = built.out.debug.peek()?.anchor;
	expect(anchor).toBeGreaterThan(10 * DEVICE_RATE);

	root.set(catalog({ jitter: 80 }));
	await flush();
	for (let i = 0; i < 6; i++) writeGroup(track, 6 + i, 10_120_000 + i * 20_000);
	await sleep(60);
	await flush();

	expect(built.out.debug.peek()?.anchor).toBe(anchor as number);

	close();
	producer.close();
});

/** A tile whose ring has filled and un-stalled, so what happens next happens mid-playback. */
async function playing(delay: Signal<Delay>): Promise<{ built: DecoderType; sync: SyncType; close: () => void }> {
	const producer = new MoqBroadcast.Producer();
	const track = producer.createTrack("audio");
	const tile = decoder(true, { catalog: catalog(), active: producer.consume(), delay });
	await flush();

	// Twelve 20ms frames, well past the depth below, since the legacy warmup drops the first three
	// decoder callbacks.
	for (let i = 0; i < 12; i++) writeGroup(track, i, i * 20_000);
	await sleep(80);
	await flush();
	expect(tile.decoder.out.stalled.peek()).toBe(false);

	return {
		built: tile.decoder,
		sync: tile.sync,
		close: () => {
			tile.close();
			producer.close();
		},
	};
}

// Two frames of the rendition below, which is the shallowest depth the estimator settles on.
const SHALLOW = Time.Milli(2 * 20);

// Past the re-anchor's debounce and past one poll of the ring's state, so whatever the ring did has
// reached the signals by the time it is read.
const settle = () => sleep(400);

test("a rise inside the stretch bound is expanded into rather than parked", async () => {
	const delay = new Signal<Delay>(SHALLOW);
	const { built, close } = await playing(delay);

	// A viewer nudging their delay. A whole stretch bound is what the reader closes in half a second
	// of slightly slurred speech, which is less than a cut costs, so even an explicit rise this small
	// is stretched into rather than parked.
	delay.set(Time.Milli.add(SHALLOW, Time.Milli(STRETCH_BOUND)));
	await settle();

	expect(built.out.stalled.peek()).toBe(false);
	expect(built.out.interrupted.peek()).toBe(false);

	close();
});

test("a rise past the stretch bound is walked into, not parked", async () => {
	const { built, sync, close } = await playing(new Signal<Delay>("auto"));
	const measured = sync.track("audio").spread;

	measured.set(SHALLOW);
	await settle();

	// The estimator's own answer climbing, which is every tune-in and every return to a tab. Nobody
	// asked for this depth, so nobody is expecting the cut: the reader expands into it a pitch period
	// at a time, the way the native engine reaches every deeper hold. Parking instead spent the whole
	// deficit as silence with the sound still arriving, and froze the picture with it, since video is
	// painted when the audio playhead reaches its timestamp.
	measured.set(Time.Milli.add(SHALLOW, Time.Milli(4 * STRETCH_BOUND)));
	await settle();

	expect(built.out.stalled.peek()).toBe(false);
	expect(built.out.interrupted.peek()).toBe(false);

	close();
});

test("a delay the viewer set deeper parks once rather than walking for seconds", async () => {
	const delay = new Signal<Delay>(SHALLOW);
	const { built, close } = await playing(delay);

	// The one rise still worth a cut. A viewer dragging the slider asked for this jump and expects
	// the silence; expanding into it instead would bend seconds of speech to spare them a break they
	// already accepted. Past the bound only, so a nudge stays a stretch.
	delay.set(Time.Milli.add(SHALLOW, Time.Milli(2 * STRETCH_BOUND)));
	await settle();

	expect(built.out.stalled.peek()).toBe(true);

	close();
});

test("small rises inside the debounce do not add up to a park", async () => {
	const delay = new Signal<Delay>(SHALLOW);
	const { built, close } = await playing(delay);

	// A slider drag arrives as a run of small steps even when it lands somewhere far away. Each one
	// is a rise the reader expands into, and the debounce is there to drop a step that is taken back
	// again, not to add the run up into a deficit none of its steps ever asked for.
	let depth = SHALLOW;
	for (let i = 0; i < 3; i++) {
		depth = Time.Milli.add(depth, Time.Milli(STRETCH_BOUND / 2));
		delay.set(depth);
		await sleep(30);
	}
	await settle();

	expect(built.out.stalled.peek()).toBe(false);
	expect(built.out.interrupted.peek()).toBe(false);

	close();
});

import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import type * as Catalog from "@moq/hang/catalog";
import { Time } from "@moq/net";
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

/** Enough of an AudioWorkletNode for the ring to be built against. */
class MockWorkletNode {
	readonly port = { postMessage: () => {}, onmessage: null, addEventListener: () => {}, start: () => {} };
	connect(): void {}
	disconnect(): void {}
}

/** One Opus rendition, optionally carrying the codec description the publisher adds later. */
function catalog(description?: Uint8Array): Catalog.Root {
	// Cast rather than branded: the schema brands the integers, and a literal is what a catalog
	// frame decodes to anyway.
	const config = {
		codec: "opus",
		container: { kind: "legacy" },
		sampleRate: 48000,
		numberOfChannels: 2,
	} as unknown as Catalog.AudioConfig;
	return {
		audio: { renditions: { audio: description ? { ...config, description } : config } },
	} as unknown as Catalog.Root;
}

// Drain microtasks and the spawned worklet load so scheduled effect (re)runs settle.
const flush = async () => {
	for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

let originals: { document: typeof globalThis.document; context: unknown; worklet: unknown };

beforeEach(() => {
	originals = {
		document: globalThis.document,
		context: (globalThis as Record<string, unknown>).AudioContext,
		worklet: (globalThis as Record<string, unknown>).AudioWorkletNode,
	};
	globalThis.document = new EventTarget() as unknown as Document;
	(globalThis as Record<string, unknown>).AudioContext = MockContext;
	(globalThis as Record<string, unknown>).AudioWorkletNode = MockWorkletNode;
	MockContext.built = [];
	MockContext.activation = false;
});

afterEach(() => {
	globalThis.document = originals.document;
	(globalThis as Record<string, unknown>).AudioContext = originals.context;
	(globalThis as Record<string, unknown>).AudioWorkletNode = originals.worklet;
});

/** A decoder fed by a catalog signal, the way `<moq-watch>` wires one up. */
function decoder(enabled: boolean): {
	decoder: DecoderType;
	catalog: Signal<Catalog.Root | undefined>;
	close: () => void;
} {
	const root = new Signal<Catalog.Root | undefined>(catalog());
	// Only the two members the audio source and decoder read off a Broadcast.
	const broadcast = { out: { catalog: root }, relativeBroadcast: () => undefined };
	const source = new Source({
		broadcast: new Signal(broadcast as never),
		supported: async () => true,
	});
	const sync = new Sync({ delay: new Signal("auto" as const), buffer: new Signal(Time.Milli.zero) });
	const built = new Decoder(source, sync, { enabled: new Signal(enabled) });
	return {
		decoder: built,
		catalog: root,
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

import { expect, mock, test } from "bun:test";

// Stand-ins for the only DOM globals the module body touches: the base class and the registry it
// writes to. No element is constructed here, so nothing else is reached.
const registry = new Map<string, CustomElementConstructor>();
// Enough of an element for the constructor: it looks for a <canvas> child and mirrors its own
// controls back out as attributes.
globalThis.HTMLElement = class {
	#attrs = new Map<string, string>();
	querySelector() {
		return null;
	}
	getAttribute(name: string) {
		return this.#attrs.get(name) ?? null;
	}
	setAttribute(name: string, value: string) {
		this.#attrs.set(name, value);
	}
	removeAttribute(name: string) {
		this.#attrs.delete(name);
	}
	hasAttribute(name: string) {
		return this.#attrs.has(name);
	}
	getBoundingClientRect() {
		return { width: 0, height: 0 };
	}
} as unknown as typeof HTMLElement;
globalThis.customElements = {
	define: (name: string, ctor: CustomElementConstructor) => {
		registry.set(name, ctor);
	},
	get: (name: string) => registry.get(name),
} as unknown as CustomElementRegistry;

// The audio worklet is inlined by a bundler plugin, which the test runner has no equivalent for.
mock.module("./audio/render-worklet.ts?worklet", () => ({ default: "blob:worklet" }));

// The constructor watches its children for a <canvas> and its own box for a resize. Nothing here
// has children, and nothing is laid out.
class NoopObserver {
	observe() {}
	unobserve() {}
	disconnect() {}
	takeRecords() {
		return [];
	}
}
globalThis.MutationObserver = NoopObserver as unknown as typeof MutationObserver;
globalThis.ResizeObserver = NoopObserver as unknown as typeof ResizeObserver;

// A framework binds the raw node (Svelte's `bind:this`, React's ref) and reads properties from it.
// Until the browser upgrades that node, every field the class sets is absent, so `el.broadcast` is
// undefined. Registering while the entrypoint evaluates is what makes the upgrade land first: any
// page that imports it before mounting can only ever see an upgraded element.
//
// `require` finishes the module graph synchronously, so a registration deferred to a microtask, an
// event, or a nested dynamic import leaves the registry empty here.
test("importing the entrypoint registers <moq-watch> before the import finishes", () => {
	require("./element");
	expect(registry.get("moq-watch")).toBeDefined();
});

test("an unparseable legacy latency attribute falls back to the element's default", () => {
	const MoqWatch = require("./element").default as new () => {
		attributeChangedCallback(name: string, old: string | null, value: string | null): void;
		controls: { delay: { peek(): unknown } };
	};
	const el = new MoqWatch();

	// The sibling `delay` parser warns and falls back to the default; this one used to land on a
	// silent 100ms, which is neither what the page asked for nor what the element does without it.
	el.attributeChangedCallback("latency", null, "nonsense");
	expect(el.controls.delay.peek()).toBe("auto");

	el.attributeChangedCallback("latency", "nonsense", "250");
	expect(el.controls.delay.peek()).toBe(250);
});

test("the conceal attribute reaches the audio decoder, defaulting to on", () => {
	const MoqWatch = require("./element").default as new () => {
		attributeChangedCallback(name: string, old: string | null, value: string | null): void;
		audio: { in: { conceal: { peek(): boolean } } };
		conceal: boolean;
	};
	const el = new MoqWatch();

	// Concealment is the player's default, so a page that never mentions it gets it.
	expect(el.audio.in.conceal.peek()).toBe(true);

	// Presence alone cannot say "off", which is why the boolean attributes take the explicit form.
	el.attributeChangedCallback("conceal", null, "false");
	expect(el.conceal).toBe(false);
	expect(el.audio.in.conceal.peek()).toBe(false);

	el.attributeChangedCallback("conceal", "false", "");
	expect(el.audio.in.conceal.peek()).toBe(true);

	el.conceal = false;
	expect(el.audio.in.conceal.peek()).toBe(false);
});

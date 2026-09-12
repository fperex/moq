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

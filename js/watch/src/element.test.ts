import { expect, mock, test } from "bun:test";

// Stand-ins for the only DOM globals the module body touches: the base class and the registry it
// writes to. No element is constructed here, so nothing else is reached.
const registry = new Map<string, CustomElementConstructor>();
// Enough of an element for the constructor: it looks for a <canvas> child and mirrors its own
// controls back out as attributes.
// The <canvas> child the element finds, when a test gives it one. Null by default, so every
// other test constructs an element with nothing to render into and the download gate stays shut.
let child: unknown = null;

globalThis.HTMLElement = class {
	#attrs = new Map<string, string>();
	style: Record<string, string> = {};
	children: unknown[] = [];
	querySelector(selector: string) {
		return selector === "canvas" ? child : null;
	}
	appendChild(node: unknown) {
		this.children.push(node);
		return node;
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

// The renderer's download gate is an IntersectionObserver on the <canvas>. Every one built is
// recorded with what it observes, so a test can answer as the browser would and can tell a gate
// that was re-armed from one still holding its first answer.
type Watcher = { targets: unknown[]; report(intersecting: boolean): void; live: boolean };
const watchers: Watcher[] = [];

class FakeIntersectionObserver {
	readonly #entry: Watcher;

	constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
		this.#entry = {
			targets: [],
			live: true,
			report: (intersecting: boolean) => callback([{ isIntersecting: intersecting }]),
		};
		watchers.push(this.#entry);
	}

	observe(target: unknown) {
		this.#entry.targets.push(target);
	}
	unobserve() {}
	disconnect() {
		this.#entry.live = false;
	}
	takeRecords() {
		return [];
	}
}
globalThis.IntersectionObserver = FakeIntersectionObserver as unknown as typeof IntersectionObserver;

globalThis.document = {
	hidden: false,
	createElement: () => ({ style: {} as Record<string, string> }),
	addEventListener: () => {},
	removeEventListener: () => {},
} as unknown as Document;

const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve));
async function settle(rounds = 8): Promise<void> {
	for (let i = 0; i < rounds; i++) await flush();
}

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

test("the audio decoder is told when the element leaves the document", () => {
	// The download gate alone cannot say it: a muted tile stops downloading too, and it keeps its
	// audio context so the unmute costs no gesture. Only the element knows it is off the page,
	// which is what lets the decoder release the context rather than leak one per detach.
	const MoqWatch = require("./element").default as new () => {
		connectedCallback(): void;
		disconnectedCallback(): void;
		audio: { in: { attached: { peek(): boolean } } };
	};
	const el = new MoqWatch();

	// Built but not inserted: a page appends the canvas before the element lands in a document.
	expect(el.audio.in.attached.peek()).toBe(false);

	el.connectedCallback();
	expect(el.audio.in.attached.peek()).toBe(true);

	el.disconnectedCallback();
	expect(el.audio.in.attached.peek()).toBe(false);
});

test("connecting re-arms the video download gate", async () => {
	// A page may not touch a custom element's children in its constructor, so `createElement`,
	// `appendChild(canvas)`, then insert is the ordinary order. That arms the download gate on a
	// canvas that is not in a document yet. Nothing then re-evaluated it when the node landed in
	// one, and a page that re-appends its tiles to reorder them (one disconnect and one connect in
	// the same task, which a boolean coalesces away) left the gate holding a stale answer. The tile
	// played audio and never asked for video again: the relay restart row, and the device switch
	// rows once the publisher's announcement flapped.
	const MoqWatch = require("./element").default as new () => {
		connectedCallback(): void;
		disconnectedCallback(): void;
		renderer: { out: { visible: { peek(): boolean } } };
		video: { in: { enabled: { peek(): boolean } } };
	};

	const canvas = { width: 0, height: 0, getContext: () => null };
	child = canvas;
	watchers.length = 0;

	try {
		const el = new MoqWatch();
		await settle();

		// Built detached, so nothing is on screen whatever a gate armed here would say.
		expect(el.renderer.out.visible.peek()).toBe(false);
		expect(el.video.in.enabled.peek()).toBe(false);

		const beforeConnect = watchers.length;
		el.connectedCallback();
		await settle();

		// The node has a place in a document now, which is the whole of what the gate reads, so
		// the gate is armed again on it rather than left holding what it decided while detached.
		const armed = watchers.filter((w) => w.live && w.targets.includes(canvas));
		expect(watchers.length).toBeGreaterThan(beforeConnect);
		expect(armed).not.toBeEmpty();

		armed.at(-1)?.report(true);
		await settle();
		expect(el.renderer.out.visible.peek()).toBe(true);
		expect(el.video.in.enabled.peek()).toBe(true);

		// Out of the document is off screen: the gate closes and stops observing rather than
		// leaving a removed tile downloading.
		el.disconnectedCallback();
		await settle();
		expect(el.renderer.out.visible.peek()).toBe(false);
		expect(watchers.filter((w) => w.live && w.targets.includes(canvas))).toBeEmpty();

		// The move: disconnect and connect in one task.
		const beforeMove = watchers.length;
		el.disconnectedCallback();
		el.connectedCallback();
		await settle();

		expect(watchers.length).toBeGreaterThan(beforeMove);
		const rearmed = watchers.filter((w) => w.live && w.targets.includes(canvas));
		expect(rearmed).not.toBeEmpty();

		rearmed.at(-1)?.report(true);
		await settle();
		expect(el.renderer.out.visible.peek()).toBe(true);
		expect(el.video.in.enabled.peek()).toBe(true);
	} finally {
		child = null;
	}
});

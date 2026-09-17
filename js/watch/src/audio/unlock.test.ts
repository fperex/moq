import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect, Signal } from "@moq/signals";
import { unlockOnGesture } from "./unlock";

// Minimal AudioContext stand-in: an EventTarget with a mutable `state` and a counting
// `resume()`. `transition` mirrors a real context firing `statechange` when its state moves.
class MockContext extends EventTarget {
	state = "suspended";
	resumeCalls = 0;

	resume(): Promise<void> {
		this.resumeCalls++;
		return Promise.resolve();
	}

	transition(state: string): void {
		this.state = state;
		this.dispatchEvent(new Event("statechange"));
	}
}

// Drain microtasks so scheduled effect (re)runs settle.
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

let originalDocument: typeof globalThis.document;

beforeEach(() => {
	originalDocument = globalThis.document;
	globalThis.document = new EventTarget() as unknown as Document;
});

afterEach(() => {
	globalThis.document = originalDocument;
});

const asContext = (ctx: MockContext) => ctx as unknown as AudioContext;

/** The usual case: a context that already exists when the unlock is armed. */
function armed(ctx: MockContext): Signal<AudioContext | undefined> {
	return new Signal<AudioContext | undefined>(asContext(ctx));
}

/** A builder that must not be called, since these cases already have a context. */
const never = (): AudioContext => {
	throw new Error("built a second context");
};

test("retries resume() on a user gesture until the context is running", async () => {
	const ctx = new MockContext();
	const effect = new Effect();
	unlockOnGesture(effect, armed(ctx), never);
	await flush();

	// The at-load attempt fires once. Browsers requiring a gesture reject it, but we still
	// try in case autoplay is already permitted.
	expect(ctx.resumeCalls).toBe(1);

	// The regression: a real gesture must produce a fresh resume(). Before the fix the effect
	// was edge-triggered on inputs that never changed, so no gesture ever reached resume().
	document.dispatchEvent(new Event("pointerdown"));
	expect(ctx.resumeCalls).toBe(2);

	document.dispatchEvent(new Event("keydown"));
	expect(ctx.resumeCalls).toBe(3);

	// Once the context is actually running, stop retrying: further gestures are no-ops.
	ctx.transition("running");
	await flush();
	document.dispatchEvent(new Event("pointerdown"));
	expect(ctx.resumeCalls).toBe(3);

	effect.close();
});

test("re-arms when Safari drops the context to interrupted", async () => {
	const ctx = new MockContext();
	const effect = new Effect();
	unlockOnGesture(effect, armed(ctx), never);
	await flush();

	ctx.transition("running");
	await flush();
	expect(ctx.resumeCalls).toBe(1); // only the at-load attempt so far

	// Safari can suspend a running context to its WebKit-only "interrupted" state. We must
	// re-attempt on the next gesture rather than staying silent.
	ctx.transition("interrupted");
	await flush();
	expect(ctx.resumeCalls).toBe(2); // immediate retry once no longer running

	document.dispatchEvent(new Event("pointerdown"));
	expect(ctx.resumeCalls).toBe(3);

	effect.close();
});

test("builds the context inside the gesture, not from an effect the gesture schedules", async () => {
	// Nothing is built at load: a context built there is one nothing can start, and it costs an
	// autoplay warning and a render thread per tile. The gesture is the moment it is built, and it
	// has to be built and resumed before the handler returns, because an effect scheduled here runs
	// a microtask later, by which point WebKit is relying on the grace that follows the activation.
	const context = new Signal<AudioContext | undefined>(undefined);
	let built = 0;
	const effect = new Effect();
	unlockOnGesture(effect, context, () => {
		built++;
		const ctx = new MockContext();
		context.set(asContext(ctx));
		return asContext(ctx);
	});
	await flush();

	expect(built).toBe(0);
	expect(context.peek()).toBeUndefined();

	document.dispatchEvent(new Event("pointerdown"));

	const ctx = context.peek() as unknown as MockContext;
	expect(built).toBe(1);
	expect(ctx.resumeCalls).toBe(1);

	// The context it built is the one the next gesture is spent on.
	document.dispatchEvent(new Event("keydown"));
	expect(built).toBe(1);
	expect(ctx.resumeCalls).toBe(2);

	effect.close();
});

test("resumes a context that replaced the one the gesture started", async () => {
	// The caller rebuilds the context when the rate the graph runs at changes. That one is born
	// outside a handler, so it is armed again here rather than assumed started.
	const context = new Signal<AudioContext | undefined>(undefined);
	const effect = new Effect();
	unlockOnGesture(effect, context, never);
	await flush();

	const ctx = new MockContext();
	context.set(asContext(ctx));
	await flush();
	expect(ctx.resumeCalls).toBe(1);

	document.dispatchEvent(new Event("pointerdown"));
	expect(ctx.resumeCalls).toBe(2);

	ctx.transition("running");
	await flush();
	document.dispatchEvent(new Event("keydown"));
	expect(ctx.resumeCalls).toBe(2);

	effect.close();
});

test("stops resuming after the effect closes", async () => {
	const ctx = new MockContext();
	const effect = new Effect();
	unlockOnGesture(effect, armed(ctx), never);
	await flush();

	effect.close();
	document.dispatchEvent(new Event("pointerdown"));
	expect(ctx.resumeCalls).toBe(1); // only the at-load attempt, no post-close listener
});

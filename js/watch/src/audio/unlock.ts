import { type Effect, type Getter, Signal } from "@moq/signals";

/**
 * Resume a suspended {@link AudioContext} from a real user gesture.
 *
 * Takes the context as a getter rather than a context, because the gesture that unlocks it usually
 * happens before it exists: the graph is built when the catalog names an audio rendition, which on a
 * slow-starting broadcast is seconds after the click that started playback. Listeners armed with the
 * context would miss that click, and the viewer would have to click a second time to hear anything.
 * Armed here from the moment audio is enabled, the first gesture anywhere on the page counts.
 *
 * Arming early is enough because the activation belongs to the page, not to a particular context: a
 * context built seconds after the click still starts. Building one inside the handler instead was
 * measured and rejected, since one activation starts one context, and a graph rebuilt at the rate the
 * decoder turns out to emit would then be born locked with the activation already spent.
 *
 * So this attempts `resume()` whenever the context is not running (for autoplay-permissive browsers
 * like Chrome with prior engagement, and for a page that has already had its gesture), and again on
 * every `pointerdown`/`keydown` until the context is actually running. A single unconditional attempt
 * would fire once, be rejected, and never retry, leaving audio silent. `pointerdown` and `keydown`
 * cover mouse, touch, pen, and keyboard, and each carries a user activation.
 *
 * Safari also reports an "interrupted" state (a WebKit-only value outside the
 * suspended/running/closed set) and can leave it on its own; mirroring `statechange` into a signal
 * picks that up so a context that drops out of "running" is retried as the state moves.
 *
 * Scoped to `effect`: the listeners are removed when the effect reruns or closes.
 */
export function unlockOnGesture(effect: Effect, context: Getter<AudioContext | undefined>): void {
	// Armed before anything reads the context, so a gesture is never lost to the order these run in.
	effect.event(document, "pointerdown", () => resume(context.peek()));
	effect.event(document, "keydown", () => resume(context.peek()));

	effect.run((inner) => {
		const current = inner.get(context);
		if (!current) return;

		const running = new Signal(current.state === "running");
		inner.event(current, "statechange", () => running.set(current.state === "running"));

		inner.run((retry) => {
			if (retry.get(running)) return;
			resume(current);
		});
	});
}

/** Start `context` unless it is already running or gone. Safe to call from anywhere, any number of times. */
function resume(context: AudioContext | undefined): void {
	// "interrupted" is Safari's, outside the state enum, and resumes the same way "suspended" does.
	if (!context || context.state === "running" || context.state === "closed") return;
	context.resume().catch(() => {});
}

import { type Effect, type Getter, Signal } from "@moq/signals";

/**
 * Build and start an {@link AudioContext} from a real user gesture.
 *
 * A context is the only thing here a user gesture starts, so a tile that has none builds one inside
 * the handler, by `build`, at the moment the gesture lands. Building one for every tile at load
 * instead makes a muted tile pay for a graph nobody has asked to hear: Chromium logs "The
 * AudioContext was not allowed to start" for each one and each holds a render thread. Building it
 * later, from an effect the gesture schedules, is worse than either: WebKit only starts a context
 * resumed outside a handler while the page's activation is still live, a few seconds, and past that
 * the context stays suspended for good while video keeps painting.
 *
 * `context` is the context that already exists, tracked rather than passed by value because the
 * caller builds one of its own when the app asks for audio without waiting to be clicked, and
 * replaces it when the rate the graph must run at changes. Either is born outside a handler, so it
 * starts on its own only where the autoplay policy is permissive or the activation is still live;
 * the listeners stay armed regardless and spend the next gesture on it.
 *
 * `build` returns nothing to decline the gesture, which a player off the page does: there is
 * nothing to hear out of it, and the gesture belongs to whatever the viewer actually clicked.
 *
 * This attempts `resume()` whenever the context is not running (for autoplay-permissive browsers
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
export function unlockOnGesture(
	effect: Effect,
	context: Getter<AudioContext | undefined>,
	build: () => AudioContext | undefined,
): void {
	// Nothing to arm where there is no document (server rendering, a test runner): no gestures reach
	// this build, and no audio plays out of it either.
	if (typeof document === "undefined") return;

	// Armed before anything reads the context, so a gesture is never lost to the order these run in.
	const spend = () => resume(context.peek() ?? build());
	effect.event(document, "pointerdown", spend);
	effect.event(document, "keydown", spend);

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

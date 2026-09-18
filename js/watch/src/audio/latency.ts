import * as Container from "@moq/hang/container";
import { Time } from "@moq/net";
import { WORKLET_QUANTUM } from "./config";
import { STRETCH_BOUND } from "./playout";

/**
 * The ring depth for a target delay, floored at one AudioWorklet render quantum.
 *
 * A ring shallower than one quantum can never be read from.
 *
 * `delay="instant"` reports a zero buffer, which the ring rejects outright: construction throws,
 * the worklet is left with no backend, and every later resize is gated on that backend existing, so
 * audio never recovers. Audio keeps its own floor rather than deriving its depth verbatim from a
 * buffer whose meaning is "video holds nothing".
 */
export function ringSamples(rate: number, delay: Time.Milli): number {
	return Math.max(WORKLET_QUANTUM, Math.ceil(rate * Time.Second.fromMilli(delay)));
}

/**
 * How long the ring holds a depth before it sheds another bucket of a fall.
 *
 * A shallower target is reached by time-compressing audio the ring already holds: it cannot
 * un-receive it. One bucket a second is one stretch period a second, which speech carries. The
 * whole of a cold-start seed at once is six of them inside half a second, which is the fast-forward
 * heard in the first seconds of a self-publish, where a browser publisher declares no flush span
 * and the estimator's first measurement replaces the 80ms guess with 20ms. NetEq lets the buffer
 * drift towards a lower target rather than stretching straight after a start for the same reason
 * (`delay_manager.cc`, and the accelerate decision in `decision_logic.cc`).
 */
export const LOWER_INTERVAL = Time.Milli(1_000);

/**
 * The depth to hold now, given the one being held, the one asked for, and how long the current one
 * has stood.
 *
 * Rises land at once: the ring reaches a deeper target by parking once, which costs silence rather
 * than a bent waveform, and delaying one only lengthens the shallow window an underrun is waiting
 * in. So does a fall further than the reader's own stretch bound, because past that the reader
 * skips ahead instead of stretching ({@link STRETCH_BOUND}), which is one discontinuity rather than
 * a run of them: walking a viewer's 2s delay down to 100ms would turn that single jump into a
 * minute of bent audio. Everything in between is walked, one bucket per {@link LOWER_INTERVAL}.
 */
export function nextLatency(current: Time.Milli, target: Time.Milli, held: Time.Milli): Time.Milli {
	if (target >= current || current - target > STRETCH_BOUND) return target;
	if (held < LOWER_INTERVAL) return current;
	return Time.Milli(Math.max(target, current - Container.Jitter.BUCKET));
}

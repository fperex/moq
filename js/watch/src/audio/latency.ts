import { Time } from "@moq/net";
import { WORKLET_QUANTUM } from "./config";

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

/**
 * Fakes the audio tests share: a clock the test moves by hand.
 *
 * @internal Test support, not part of the player.
 */
import { Time } from "@moq/net";

/**
 * Stub `performance.now()`, which `Time.Milli.now()` reads on every call, with a clock the test moves
 * by hand. Timers and microtasks stay real; `restore` puts the real clock back.
 */
export function fakeClock(start = 1000) {
	const real = performance.now.bind(performance);
	let at = start;
	performance.now = () => at;
	return {
		get at(): Time.Milli {
			return Time.Milli(at);
		},
		advance(ms: number) {
			at += ms;
		},
		set(ms: number) {
			at = ms;
		},
		restore() {
			performance.now = real;
		},
	};
}

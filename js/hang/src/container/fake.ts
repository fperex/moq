import type { Time } from "@moq/net";
import type { StallTimer } from "./stall";

/**
 * A clock the test moves by hand, with a `Stall` monitor's timer and probe on it.
 *
 * `advance` moves time and runs whatever was queued, which is a loop that never blocks. `block`
 * moves time without running anything and then lets the queue catch up, which is a loop that did.
 * `busy` runs nothing while the test keeps querying, which is a loop running flat out: it answers
 * the reads and everything queued behind them waits. `throttle` holds every schedule to a minimum
 * interval, which is a hidden tab: the loop runs, only its timers are rationed.
 *
 * @internal Test support, not part of the container.
 */
export function fakeTimer(): StallTimer & {
	advance(ms: number): void;
	block(ms: number): void;
	busy(on: boolean): void;
	throttle(ms: number): void;
	posts(): number;
	released(): boolean;
	at(): Time.Milli;
} {
	let now = 0;
	let due: { at: number; fn: () => void } | undefined;
	let floor = 0;
	let stopped = false;
	let handler: (() => void) | undefined;
	let queued = 0;
	let posts = 0;
	let released = false;

	const run = () => {
		if (stopped) return;

		for (;;) {
			// A task the loop was handed goes before a timer, which is what makes it the cheaper
			// witness: it is served as soon as whatever is in front of it is done.
			if (queued > 0) {
				queued--;
				handler?.();
				continue;
			}
			if (due !== undefined && due.at <= now) {
				const fn = due.fn;
				due = undefined;
				fn();
				continue;
			}
			break;
		}
	};

	return {
		now: () => now,
		schedule: (fn, ms) => {
			due = { at: now + Math.max(ms, floor), fn };
			return due;
		},
		clear: () => {
			due = undefined;
		},
		probe: (fn) => {
			handler = fn;
			return {
				post: () => {
					posts++;
					queued++;
				},
				close: () => {
					released = true;
				},
			};
		},
		advance(ms: number) {
			// One millisecond at a time, so a timer that reschedules itself fires as often as it
			// would on a loop that was running.
			for (let i = 0; i < ms; i++) {
				now++;
				run();
			}
		},
		block(ms: number) {
			// Nothing runs while the loop is blocked; the overdue timer fires the moment it is over.
			now += ms;
			run();
		},
		busy(on: boolean) {
			stopped = on;
		},
		throttle(ms: number) {
			floor = ms;
		},
		posts: () => posts,
		released: () => released,
		at: () => now as Time.Milli,
	};
}

/**
 * Whether this receiver's own event loop stopped running, which nothing about a frame can show.
 *
 * A browser content process is blocked in bursts of a few hundred milliseconds by anything from a
 * long paint to the profiler, and while it is blocked nothing reads the socket. The frames that
 * queued behind it are then read at once and stamped with the clock after the block, so they enter
 * the estimator as late arrivals that the path never delayed. The estimator infers this from
 * arrival spacing, but a real bursty path has the same spacing, so spacing alone cannot decide.
 * Scheduling lag can: a timer that was due while the loop was blocked runs late by however long the
 * block lasted, and no path condition moves it.
 *
 * `PerformanceObserver` with `longtask` would report the same thing and is Chromium only, so this
 * measures the lag directly instead.
 *
 * @module
 */

import type { Time } from "@moq/net";

/** How often the monitor checks in. Short enough to date a block to the burst that follows it. */
const TICK = 50;

/**
 * Lag above this is a block rather than ordinary timer slack.
 *
 * Timers are allowed to fire late, and a busy page delivers a few tens of milliseconds of that
 * routinely. Twice the tick is past anything scheduling noise produces and well under the shortest
 * block that reaches the estimator as delay.
 */
const THRESHOLD = 100;

/** The clock and timer a {@link Stall} runs on, so a test can drive one without waiting for time. */
export interface StallTimer {
	/** Milliseconds on the same monotonic clock arrivals are stamped with. */
	now(): number;
	/** Run `fn` in `ms`, returning whatever identifies it to {@link StallTimer.clear}. */
	schedule(fn: () => void, ms: number): unknown;
	/** Cancel a scheduled run. */
	clear(handle: unknown): void;
}

// The page's own timer. `unref` is Node's and Bun's, where a self-rescheduling timer would otherwise
// hold the process open for as long as a consumer is alive; in a browser `setTimeout` returns a
// number and there is nothing to unref.
const wall: StallTimer = {
	now: () => performance.now(),
	schedule: (fn, ms) => {
		const handle = setTimeout(fn, ms) as unknown as { unref?: () => void };
		handle.unref?.();
		return handle;
	},
	clear: (handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]),
};

// The monitor the whole document shares. Every consumer on a page watches the same event loop, so
// an element with an audio track and a video track would otherwise run two timers to learn one
// thing.
let current: Stall | undefined;

/**
 * Watches this receiver's event loop and reports when it was blocked.
 *
 * Hold one with {@link Stall.acquire} and release it with {@link Stall.close}; the timer runs while
 * anyone holds it.
 */
export class Stall {
	#timer: StallTimer;

	// When the next tick is due, so a query can see one that is already overdue.
	#due: number;

	// When the loop last came back from a block, if it ever has.
	#ended?: number;

	#handle: unknown;
	#holders = 1;

	/** A monitor on its own timer. Tests inject one; a page shares {@link Stall.acquire} instead. */
	constructor(timer: StallTimer = wall) {
		this.#timer = timer;
		this.#due = timer.now() + TICK;
		this.#handle = timer.schedule(this.#tick, TICK);
	}

	/** The document's monitor, started if nobody held it yet. */
	static acquire(): Stall {
		if (current === undefined) {
			// The constructor counts its caller as the first holder.
			current = new Stall();
			return current;
		}

		current.#holders++;
		return current;
	}

	/**
	 * Whether the loop was blocked in the tick before `now`, i.e. whether this arrival came out of a
	 * block rather than off the path.
	 *
	 * One tick, because that is how long a block takes to show up and how long the backlog behind it
	 * takes to read. An arrival further from the block than that was read by a loop already running
	 * normally, and what it waited is the path's.
	 */
	blocked(now: Time.Milli): boolean {
		// A tick that was due well before now and has not run yet means the loop is only getting back
		// to work at this arrival: the block is still being served rather than already dated. Reading
		// it here rather than waiting for the tick is what makes the answer independent of whether
		// the timer or the read loop wins the race out of a block, which nothing orders.
		if (now - this.#due > THRESHOLD) this.#ended = now;

		return this.#ended !== undefined && now - this.#ended <= TICK;
	}

	/** Release this holder's share; the timer stops once nobody holds it. */
	close(): void {
		if (this.#holders === 0) return;
		this.#holders--;
		if (this.#holders > 0) return;

		this.#timer.clear(this.#handle);
		if (current === this) current = undefined;
	}

	// Arrow, so the timer can call it without a bound copy per reschedule.
	#tick = (): void => {
		const now = this.#timer.now();
		if (now - this.#due > THRESHOLD) this.#ended = now;

		// Measured from this firing rather than from when it was due, so one late tick does not
		// convict the next one of the lag it inherited.
		this.#due = now + TICK;
		this.#handle = this.#timer.schedule(this.#tick, TICK);
	};
}

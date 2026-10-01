/**
 * Whether this receiver's own event loop kept frames waiting, which nothing about a frame can show.
 *
 * A blocked or saturated loop reads the backlog behind it at once and stamps it late, which arrival
 * spacing cannot tell from a bursty path. So the monitor times an ordinary task, a `MessageChannel`
 * message, and notices a stretch with no turn of the loop at all. Not a timer: a hidden tab rations
 * timers while its loop runs, and a saturated loop runs them late while answering every read on time.
 * `longtask` observers would do this in Chromium only. See `doc/concept/playout.md`.
 *
 * @module
 */

import type { Time } from "@moq/net";

/** How often the monitor checks in. Short enough to date a block to the burst that follows it. */
const TICK = 50;

/**
 * A wait above this is a block rather than ordinary scheduling noise.
 *
 * A task queued behind a page doing its job waits a few tens of milliseconds routinely. Twice the
 * tick is past anything that produces and well under the shortest block that reaches the estimator
 * as delay.
 */
const THRESHOLD = 100;

/** A queue a {@link Stall} puts one task on to measure what this loop makes it wait. */
export interface StallProbe {
	/** Queue one run of the handler. */
	post(): void;
	/** Release the queue, so a monitor nobody holds no longer keeps the runtime alive. */
	close(): void;
}

/** The clock, timer and task queue a {@link Stall} runs on, so a test can drive one without waiting for time. */
export interface StallTimer {
	/** Milliseconds on the same monotonic clock arrivals are stamped with. */
	now(): number;
	/** Run `fn` in `ms`, returning whatever identifies it to {@link StallTimer.clear}. */
	schedule(fn: () => void, ms: number): unknown;
	/** Cancel a scheduled run. */
	clear(handle: unknown): void;
	/** Open a probe on this loop's task queue, or undefined where the runtime has none. */
	probe(handler: () => void): StallProbe | undefined;
}

// The page's own loop. `unref` is Node's and Bun's, where a self-rescheduling timer and a started
// port would otherwise hold the process open for as long as a consumer is alive; in a browser
// `setTimeout` returns a number and a port has nothing to unref.
const wall: StallTimer = {
	now: () => performance.now(),
	schedule: (fn, ms) => {
		const handle = setTimeout(fn, ms) as unknown as { unref?: () => void };
		handle.unref?.();
		return handle;
	},
	clear: (handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]),
	probe: (handler) => {
		// Without one the monitor is left with the gap rule below, which is the half of this a late
		// timer could never have told apart from a rationed one anyway.
		if (typeof MessageChannel === "undefined") return undefined;

		const channel = new MessageChannel();
		channel.port1.onmessage = handler;
		(channel.port1 as unknown as { unref?: () => void }).unref?.();

		return {
			post: () => channel.port2.postMessage(undefined),
			close: () => {
				channel.port1.close();
				channel.port2.close();
			},
		};
	},
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
	#probe?: StallProbe;

	// When the loop was last seen running, by a tick, by a query, or by the probe coming back, since
	// each of those is a turn of it.
	#alive: number;

	// When the probe still in flight was posted, cleared once it comes back, and when an arrival
	// last sampled the cadence, so probes and cadence samples run at most once a tick.
	#sent?: number;
	#sampled?: number;

	// When the loop last came back from a block, if it ever has.
	#ended?: number;
	#ticked?: number;
	#slowTicks = 0;
	#queried?: number;
	#spacing?: number;

	#handle: unknown;
	#holders = 1;

	/** A monitor on its own loop. Tests inject one; a page shares {@link Stall.acquire} instead. */
	constructor(timer: StallTimer = wall) {
		this.#timer = timer;
		this.#alive = timer.now();
		this.#probe = timer.probe(this.#returned);
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
		// Being asked is itself a turn of the loop, and judging the arrival here rather than waiting
		// for the probe to come back is what makes the answer independent of whether the read loop or
		// the probe wins the race out of a block, which nothing orders.
		this.#see(now);
		this.#arm(now);
		if (this.#queried === undefined || now > this.#queried) this.#queried = now;

		return this.#ended !== undefined && now - this.#ended <= TICK;
	}

	/** Release this holder's share; the timer stops once nobody holds it. */
	close(): void {
		if (this.#holders === 0) return;
		this.#holders--;
		if (this.#holders > 0) return;

		this.#timer.clear(this.#handle);
		this.#probe?.close();
		this.#probe = undefined;
		if (current === this) current = undefined;
	}

	// Records a turn of the loop at `now`, dating a block that ended immediately before it.
	#see(now: number): void {
		// The gap is taken against the previous turn, before this one is recorded, so a turn never
		// closes the hole it is reporting.
		const gap = now - this.#alive;
		if (now > this.#alive) this.#alive = now;

		// A rationed timer cannot witness the healthy gaps between sparse arrivals.
		const cadence =
			this.#slowTicks >= 2 &&
			this.#spacing !== undefined &&
			this.#queried !== undefined &&
			now - this.#queried <= this.#spacing + THRESHOLD;
		const sent = this.#sent;
		if ((gap > THRESHOLD && !cadence) || (sent !== undefined && now - sent > THRESHOLD)) this.#ended = now;
	}

	// Hands the loop a task to be timed by, at most one a tick.
	#arm(now: number): void {
		if (this.#sent !== undefined) return;
		if (this.#sampled !== undefined && now - this.#sampled < TICK) return;
		if (this.#queried !== undefined && now > this.#queried) {
			const spacing = now - this.#queried;
			// Sample once a tick so frames delivered together cannot replace their burst's cadence.
			// A detected block must not become the cadence used to excuse the next block.
			if (this.#spacing === undefined || spacing <= this.#spacing + THRESHOLD) this.#spacing = spacing;
		}
		this.#sampled = now;
		const probe = this.#probe;
		if (probe === undefined) return;

		// Arrivals are the only thing there is to protect, so arrivals are what arm this. Posting
		// again from the handler would instead be a loop spinning on itself for as long as a consumer
		// is alive, and posting from the tick would keep one spinning over an idle page.
		this.#sent = now;
		probe.post();
	}

	// Arrow, so the probe can call it without a bound copy per post.
	#returned = (): void => {
		// Judged while it still counts as in flight, so what the loop made it wait is read here the
		// same way a query reads a probe that has not come back yet.
		this.#see(this.#timer.now());
		this.#sent = undefined;
	};

	// Arrow, so the timer can call it without a bound copy per reschedule.
	#tick = (): void => {
		// Being a turn of the loop is all this is for. How late it runs says nothing: a hidden tab
		// rations it to one a second with the loop running fine underneath.
		const now = this.#timer.now();
		this.#slowTicks =
			this.#ticked !== undefined && now - this.#ticked > 2 * TICK ? Math.min(2, this.#slowTicks + 1) : 0;
		this.#ticked = now;
		this.#see(now);
		this.#handle = this.#timer.schedule(this.#tick, TICK);
	};
}

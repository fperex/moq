/**
 * Whether this receiver's own event loop is keeping frames waiting, which nothing about a frame can
 * show.
 *
 * A browser content process stops reading its socket for bursts of a few hundred milliseconds,
 * whether because it was blocked outright by a long paint or because it is running flat out on a
 * keyframe. The frames that queued behind that are then read at once and stamped with the clock
 * afterwards, so they enter the estimator as late arrivals that the path never delayed. The
 * estimator infers this from arrival spacing, but a real bursty path has the same spacing, so
 * spacing alone cannot decide.
 *
 * What decides is how long a task waits in this loop. The monitor puts one on the queue, a
 * `MessageChannel` message rather than a timer, and reads back how long the loop took to get to it:
 * a loop running flat out holds it for as long as the work in front of it, and a hidden tab, which
 * rations timers and leaves ordinary tasks alone, does not hold it at all. A loop that stops dead
 * runs nothing to measure, so that is the second thing here: a stretch in which no turn of the loop
 * happened at all, neither the monitor's own tick nor an arrival being read.
 *
 * How late a timer runs measures neither of those. A hidden tab delivers one tick a second while
 * its loop runs and its socket is read as before, and a loop running flat out delivers its ticks
 * late while answering every read on time: the first reads as a block that is not there, the second
 * hides one that is.
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

	// When the probe still in flight was posted, cleared once it comes back, and when the last one
	// was posted at all, so an arrival arms at most one a tick.
	#sent?: number;
	#posted?: number;

	// When the loop last came back from a block, if it ever has.
	#ended?: number;

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

		// Two shapes of a receiver that is not keeping up, and a rationed timer is neither of them. No
		// turn of the loop at all for longer than the threshold means it stopped; the tick is the
		// witness between arrivals, until a hidden tab rations that too and a track whose arrivals are
		// further apart than the threshold is left with none, which is the answer the estimator's own
		// idle rule already gives such a track. Or the loop is running and the task it was handed
		// before this turn is still waiting, which is how long it kept this arrival waiting too.
		const sent = this.#sent;
		if (gap > THRESHOLD || (sent !== undefined && now - sent > THRESHOLD)) this.#ended = now;
	}

	// Hands the loop a task to be timed by, at most one a tick.
	#arm(now: number): void {
		const probe = this.#probe;
		if (probe === undefined || this.#sent !== undefined) return;
		if (this.#posted !== undefined && now - this.#posted < TICK) return;

		// Arrivals are the only thing there is to protect, so arrivals are what arm this. Posting
		// again from the handler would instead be a loop spinning on itself for as long as a consumer
		// is alive, and posting from the tick would keep one spinning over an idle page.
		this.#sent = now;
		this.#posted = now;
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
		this.#see(this.#timer.now());
		this.#handle = this.#timer.schedule(this.#tick, TICK);
	};
}

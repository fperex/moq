import { Time } from "@moq/net";
import { type Getter, Signal } from "@moq/signals";

// Buckets in the histogram.
const BUCKETS = 100;

// The fraction of arrivals the target covers.
const QUANTILE = 0.95;

// Steady-state forget factor, applied once per resampled observation rather than per arrival.
// At 500ms per observation, old mass falls below the 5% quantile tail in 15s.
// A longer history keeps a recovered path buffered for a minute after a short queue.
const FORGET = 0.9;

// Cold-start ramp: the first observations replace the seeded prior instead of nudging it.
const START_FORGET_WEIGHT = 2;

// One observation per interval, the maximum delay seen in it.
const RESAMPLE = 500;

// How much media the arrival reference covers. Measured on the media axis, not the wall clock, so
// a stalled sender cannot age out the only arrivals the reference has.
const WINDOW = 2000;

// The target before any observation lands, when the publisher declares nothing.
const START = 80;

// How many empty intervals one arrival may decay. 60 intervals is 30s, past the histogram's own
// memory, so a longer pause converges to the same near-reset for a bounded amount of work.
const MAX_CATCHUP = 60;

// How long the target holds before it may step down again.
const LOWER_INTERVAL = 1000;

// The share of the distance to the quantile the target may close per LOWER_INTERVAL, when that is
// more than one bucket: one part in this many. This smooths reductions after the histogram has
// released an old delay. A divisor rather than a fraction keeps the arithmetic exact in every language.
const LOWER_DIVISOR = 6;

// One admitted arrival, on both axes in milliseconds.
type Arrival = { timestamp: number; arrival: number };

/** What the caller already knows about one arrival, beyond the two clocks it carries. */
export type JitterObservation = {
	/**
	 * The frame is out of order for a reason that is not the path, so it says nothing about it.
	 *
	 * An encoder reorders its own frames: a B frame is coded after the picture that follows it on
	 * screen, so it arrives with a timestamp older than the frame before it however the path
	 * behaves. Counting it would add the media-time distance between the two to a delay. It is
	 * excluded from both the reference and the histogram.
	 *
	 * Without this, a frame whose timestamp is not newer than one already admitted is taken to have
	 * been delivered late, and is measured as such.
	 */
	reordered?: boolean;

	/**
	 * The receiver itself was blocked before this arrival, so the wait in it is not the path's.
	 *
	 * The estimator infers the same thing from arrival spacing, but spacing alone cannot separate a
	 * blocked receiver from a bursty path; whoever watched the receiver can. Set it and the arrival
	 * reference is dropped, exactly as the reading-gap rule does.
	 */
	stalled?: boolean;
};

/** How to start a {@link Jitter} that has not measured anything yet. */
export type JitterProps = {
	/**
	 * What the publisher declares it flushes, from the rendition's catalog `jitter`.
	 *
	 * A prior, not an observation: it is the only thing a receiver knows about the path before the
	 * first frame lands, and it is a better guess than a constant. The first resampled observation
	 * replaces it outright, however far below it that lands.
	 */
	start?: Time.Milli;
};

/**
 * How much buffer a receiver needs to play audio on time, measured from when frames arrive.
 *
 * Each frame's delay against the fastest recent arrival feeds a histogram read at a high quantile,
 * and the target rises at once and falls once a second. `doc/concept/playout.md` specifies the
 * algorithm and why, and the corpus at `rs/moq-audio/tests/playout-01.json` holds this to it. The
 * design is WebRTC's NetEq (`modules/audio_coding/neteq/`), reimplemented in f64.
 */
export class Jitter {
	/**
	 * Width of one histogram bucket in milliseconds, and the resolution of the target.
	 *
	 * The target is always a whole number of buckets, so a consumer that wants to know whether the
	 * estimate really moved compares the change against this.
	 */
	static readonly BUCKET = 20;

	/**
	 * The widest delay the histogram can hold, so the widest target it can produce.
	 *
	 * An observation above this is dropped rather than clamped, which makes this a real ceiling on
	 * the estimate rather than a saturation point. Whoever sizes a buffer from the estimate can
	 * allocate for it once instead of growing as the target climbs.
	 */
	static readonly CEILING = BUCKETS * Jitter.BUCKET;

	// Admitted arrivals within WINDOW of media, ascending by `arrival - timestamp`, so the front is
	// the fastest recent arrival: the best-case path everything else is measured against.
	#min: Arrival[] = [];

	// The newest timestamp admitted so far. Anything not strictly newer was overtaken on the way.
	#newest?: number;

	// The first timestamp admitted since the measurement began, which is where the media this
	// estimate is about starts. Anything older belongs to a time before it.
	#start?: number;

	// The previous admitted arrival, on both axes, so a gap in the receiver's own reading is visible.
	#previous?: Arrival;

	// Weighted probability per delay bucket, summing to 1.
	#buckets = new Float64Array(BUCKETS);

	// Observations folded in so far, and the factor the next one decays the histogram by.
	#adds = 0;
	#forget = 0;

	// The resample interval currently open, and the largest delay seen inside it.
	#intervalStart?: number;
	#intervalMax = 0;

	// The quantile's upper edge, i.e. what the histogram currently asks for.
	#optimal?: number;

	// Whether the target is a measurement yet, or still the seeded prior.
	#measured = false;

	// The published target, and when it last moved.
	#target: number;
	#lowered?: number;

	#value: Signal<Time.Milli>;

	/** The current target: enough buffer to play `QUANTILE` of arrivals on time. */
	readonly value: Getter<Time.Milli>;

	/** Seed the histogram with a decaying prior so a cold start has something to quantile. */
	constructor(props?: JitterProps) {
		for (let i = 0; i < BUCKETS; i++) this.#buckets[i] = 0.5 ** (i + 1);

		this.#target = startTarget(props?.start);
		this.#value = new Signal<Time.Milli>(Time.Milli(this.#target));
		this.value = this.#value;
	}

	/**
	 * Fold one frame into the estimate, given its media timestamp and the wall time it arrived.
	 *
	 * What the caller knows and the two clocks do not show goes in `observation`: that the frame came
	 * out of order, or that the receiver itself was blocked before it landed.
	 */
	observe(timestamp: Time.Micro, now: Time.Milli, observation: JitterObservation = {}): void {
		const { reordered = false, stalled = false } = observation;

		// Plain numbers from here down. The branded time types are structurally numbers, so mixing
		// a media axis with a wall axis type-checks; keeping both in ms and unbranded makes the unit
		// visible in the arithmetic instead.
		const ts = timestamp / 1000;
		const arrival = now as number;

		if (reordered) {
			this.#publish(arrival);
			return;
		}

		if (this.#newest !== undefined && ts <= this.#newest) {
			this.#overtaken(ts, arrival, stalled);
			this.#publish(arrival);
			return;
		}
		this.#newest = ts;
		this.#start ??= ts;

		// A gap in the receiver's own reading lands in every frame of the backlog it then reads, so
		// drop the reference and measure those against each other. Idle time past the media it
		// covered is what separates that from a sparse track; `stalled` is a caller that watched the
		// receiver saying so outright.
		const previous = this.#previous;
		this.#previous = { timestamp: ts, arrival };
		if (stalled) {
			this.#min.length = 0;
		} else if (previous !== undefined) {
			const idle = arrival - previous.arrival;
			if (idle > RESAMPLE && idle - (ts - previous.timestamp) > RESAMPLE) this.#min.length = 0;
		}

		// Drop arrivals the timeline has moved past. The window is media, so this prunes by how much
		// content has been delivered rather than by how long the receiver has been running.
		while (this.#min.length > 0 && this.#min[0].timestamp + WINDOW < ts) this.#min.shift();

		// Maintain the monotone deque: anything at least as slow as this arrival can never be the
		// minimum again.
		while (this.#min.length > 0) {
			const back = this.#min[this.#min.length - 1];
			if (arrival - ts > back.arrival - back.timestamp) break;
			this.#min.pop();
		}
		this.#min.push({ timestamp: ts, arrival });

		const ref = this.#min[0];
		const delay = Math.max(0, arrival - ref.arrival - (ts - ref.timestamp));

		this.#resample(arrival, delay);
		this.#publish(arrival);
	}

	/**
	 * Forget the arrival reference, keeping the measured distribution.
	 *
	 * A discontinuity moves the media timeline underneath the measurement, so every arrival in the
	 * reference describes a timeline that no longer exists and the open interval spans the jump.
	 * The histogram holds delays, which the jump does not move, so it survives.
	 */
	reanchor(): void {
		this.#min.length = 0;
		this.#newest = undefined;
		this.#start = undefined;
		this.#previous = undefined;
		this.#intervalStart = undefined;
		this.#intervalMax = 0;
	}

	// A frame older than one already admitted: it left the sender first and got here after.
	//
	// Groups travel on streams of their own and a sender with several queued sends the newest first,
	// so the frames of one flush reach the receiver newest first. The oldest is the frame the playhead
	// needs first and the one that waited longest, which makes it the one the buffer is sized for:
	// leaving it out leaves the estimate blind to exactly the flush it exists to measure. So it is
	// measured against the reference like any other frame, but it can never be the reference, since
	// a frame sent after it got here first.
	#overtaken(ts: number, arrival: number, stalled: boolean): void {
		// A blocked receiver's wait is not the path's. A frame from before the measurement began is
		// the window a subscriber is served behind the live edge, which no depth of buffer makes
		// playable.
		if (stalled || this.#start === undefined || ts < this.#start) return;

		// Admitted whenever a timestamp has been, so there is always a reference to measure against.
		const ref = this.#min[0];
		this.#resample(arrival, Math.max(0, arrival - ref.arrival - (ts - ref.timestamp)));
	}

	// Take at most one observation per RESAMPLE, the largest delay in the interval. That
	// decorrelates observations and turns the forget factor into a wall-clock time constant.
	#resample(arrival: number, delay: number): void {
		this.#intervalStart ??= arrival;

		const elapsed = arrival - this.#intervalStart;
		if (elapsed > RESAMPLE) {
			this.#add(this.#intervalMax);

			// Intervals that passed with no arrival still decay. A normalised histogram cannot
			// forget without an observation, so a pause would otherwise preserve whatever the path
			// looked like before it; a timer instead of this would be untestable and unportable.
			const empty = Math.min(MAX_CATCHUP, Math.floor(elapsed / RESAMPLE) - 1);
			for (let i = 0; i < empty; i++) this.#add(0);

			this.#intervalStart = arrival;
			this.#intervalMax = 0;
		}

		// The arrival that closed an interval belongs to the new one, not to the one it closed.
		this.#intervalMax = Math.max(this.#intervalMax, delay);
	}

	// Fold one resampled observation into the histogram and read the quantile back out.
	#add(ms: number): void {
		const index = Math.floor(ms / Jitter.BUCKET);

		// Past the histogram's range the observation is dropped rather than clamped into the last
		// bucket, so one absurd arrival cannot pin the target at the ceiling for a whole minute.
		if (index < BUCKETS) {
			const forget = this.#forget;
			for (let i = 0; i < BUCKETS; i++) this.#buckets[i] *= forget;
			this.#buckets[index] += 1 - forget;

			this.#adds++;
			this.#forget = Math.max(0, Math.min(FORGET, 1 - START_FORGET_WEIGHT / (this.#adds + 1)));

			// The bucket's upper edge, because the delay it holds is somewhere inside it. Read
			// inside the guard: a dropped observation leaves the histogram alone, so re-reading the
			// quantile would return what it already says, and before the first real one it would
			// publish the bare prior as though something had measured it.
			this.#optimal = (this.#quantile() + 1) * Jitter.BUCKET;
		}
	}

	// The lowest bucket whose tail mass has dropped to 1 - QUANTILE.
	#quantile(): number {
		let sum = 1 - this.#buckets[0];
		let index = 0;
		while (sum > 1 - QUANTILE && index < BUCKETS - 1) {
			index++;
			sum -= this.#buckets[index];
		}
		return index;
	}

	#publish(now: number): void {
		const optimal = this.#optimal;

		// A seed is a prior, not an observation: the first measurement replaces it outright, since the
		// fall bound only protects measurements. NetEq does the same with `kStartDelayMs`.
		if (optimal === undefined) return;
		if (!this.#measured) {
			this.#measured = true;
			this.#lowered = now;
			this.#set(optimal);
			return;
		}

		const current = this.#target;

		if (optimal >= current) {
			// Rise at once: a late frame has already proven the buffer is too shallow, and waiting
			// costs an underrun the viewer hears. The histogram's range bounds how far one
			// observation can take it.
			this.#lowered = now;
			if (optimal > current) this.#set(optimal);
			return;
		}

		// Fall once a second, in as many steps as the elapsed time allows so a 1 fps track and a 50
		// fps one shrink at the same wall-clock rate. Shrinking faster than this drops the playhead
		// onto a ring the network has not refilled yet.
		this.#lowered ??= now;
		const steps = Math.floor((now - this.#lowered) / LOWER_INTERVAL);
		if (steps <= 0) return;
		this.#lowered += steps * LOWER_INTERVAL;

		// Each step closes a share of the distance left, with one bucket as the floor: what a ring
		// can refill scales with the buffer being shrunk.
		let target = current;
		for (let i = 0; i < steps && target > optimal; i++) {
			const share = Math.floor((target - optimal) / LOWER_DIVISOR / Jitter.BUCKET) * Jitter.BUCKET;
			target = Math.max(optimal, target - Math.max(Jitter.BUCKET, share));
		}
		this.#set(target);
	}

	#set(target: number): void {
		if (target === this.#target) return;
		this.#target = target;
		this.#value.set(Time.Milli(target));
	}
}

// Where the target sits until the first observation replaces it: the publisher's declared flush
// span, never below NetEq's 80ms guess since the network adds to it, rounded up to a whole bucket.
function startTarget(advertised: Time.Milli | undefined): number {
	const ms = Math.max(START, advertised ?? 0);
	return Math.min(Jitter.CEILING, Math.ceil(ms / Jitter.BUCKET) * Jitter.BUCKET);
}

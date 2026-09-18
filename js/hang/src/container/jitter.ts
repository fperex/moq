import { Time } from "@moq/net";
import { type Getter, Signal } from "@moq/signals";

// Buckets in the histogram.
const BUCKETS = 100;

// The fraction of arrivals the target covers.
const QUANTILE = 0.95;

// Steady-state forget factor, applied once per resampled observation rather than per arrival.
// 500ms / (1 - 0.983) is about 29s of wall-clock memory.
const FORGET = 0.983;

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
// more than one bucket: one part in this many. Enough to close the histogram's whole range inside
// the histogram's own memory, so the limiter can never outlast the observation that raised the
// target. A divisor rather than a fraction so the arithmetic is exact in every language.
const LOWER_DIVISOR = 6;

// One admitted arrival, on both axes in milliseconds.
type Arrival = { timestamp: number; arrival: number };

/** What the caller already knows about one arrival, beyond the two clocks it carries. */
export type JitterObservation = {
	/**
	 * The frame came out of order, whatever its timestamp says.
	 *
	 * It is excluded from both the reference and the histogram: its arrival is early relative to its
	 * timestamp, so counting it would add the media-time distance between the two to a delay.
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
 * Each frame is measured against the fastest recent arrival rather than against the previous one,
 * so a path that slowly gets worse reads as a delay climbing to its real size instead of as a
 * string of tiny inter-arrival deltas. Those delays feed a histogram that is read at a high
 * quantile, because network delay is one-sided and heavy-tailed and a mean plus deviations sizes
 * that tail wrong.
 *
 * The estimate rises the moment a late frame proves the buffer is too shallow and falls once a
 * second by a share of the distance left, so a refinement shrinks a viewer's buffer in steps it can
 * absorb without taking longer to undo than the histogram remembers. That bound holds between two
 * measurements. It carries no floor: the rendition's advertised jitter is the prior it starts from
 * ({@link JitterProps.start}), and the first measurement replaces it outright.
 *
 * Time the receiver spends not reading is not the path's fault, so a gap in the receiver's own
 * reading drops the arrival reference rather than reading as a delay the size of the gap. A caller
 * that can see the receiver was blocked says so with {@link JitterObservation.stalled}; the spacing
 * the estimator infers it from covers a caller that cannot.
 *
 * The algorithm is written down in `doc/concept/playout.md` and held to it by the conformance
 * corpus at `rs/moq-audio/tests/playout-01.json`. The design is WebRTC's NetEq
 * (`modules/audio_coding/neteq/`: `underrun_optimizer.cc`, `packet_arrival_history.cc`,
 * `histogram.cc`, `delay_manager.cc`), reimplemented in f64 rather than copied.
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

	// The newest timestamp admitted so far. Anything not strictly newer is reordered.
	#newest?: number;

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

		if (reordered || (this.#newest !== undefined && ts <= this.#newest)) {
			// Costing a reordered arrival as delay against loss is a separate step, not yet written.
			this.#publish(arrival);
			return;
		}
		this.#newest = ts;

		// The arrival clock is sampled by the receiver's own read loop. When that loop does not run
		// for a whole resample interval, the time it spent not running lands in the next arrival it
		// stamps, and in every frame it then pulls out of the backlog, because all of them are
		// measured against a reference taken before the gap. Drop the reference so they are measured
		// against each other instead.
		//
		// The media term is what tells the receiver apart from the publisher. A track that genuinely
		// sends one frame a second is idle for longer than the interval too, but its timeline
		// advances by as much as the wall clock does; a receiver that was not reading comes back to
		// a backlog, so its idle time exceeds the media it covered.
		//
		// A caller that watched the receiver knows this outright and says so, which is the only way
		// to tell a block shorter than the interval from a path that flushes in bursts: the two have
		// the same arrival spacing. The action is the same either way.
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
		this.#previous = undefined;
		this.#intervalStart = undefined;
		this.#intervalMax = 0;
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

		// A seed is a prior, not an observation. It holds the target until the histogram has
		// measured something, and the first measurement then replaces it outright however far below
		// it that lands: there is no earlier measurement for the fall bound to protect, and walking
		// down from a guess keeps a viewer above their real buffer for tens of seconds. NetEq does
		// the same, replacing `kStartDelayMs` with the first optimal delay it gets rather than
		// approaching it (`delay_manager.cc`).
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

		// Each step closes a share of the distance left, with one bucket as the floor. What a ring
		// can refill scales with the buffer being shrunk, so a fixed step brakes hardest exactly
		// when the target is furthest from what the histogram asks for: walking 1600ms back a bucket
		// at a time takes longer than the histogram remembers why it went up.
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

// Where the target sits until the first observation replaces it.
//
// A publisher's declared flush span is the best prior a receiver has: it is exactly the quantity
// the estimator goes on to measure, published by the only party that already knows it. NetEq has to
// guess 80ms because RTP carries nothing like it. Never below that guess, because a publisher can
// declare a flush span the network then adds to, and rounded up to a whole bucket so a cold start
// reads on the same grid every later target does.
function startTarget(advertised: Time.Milli | undefined): number {
	const ms = Math.max(START, advertised ?? 0);
	return Math.min(Jitter.CEILING, Math.ceil(ms / Jitter.BUCKET) * Jitter.BUCKET);
}

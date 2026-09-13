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

// The target before any observation lands.
const START = 80;

// How many empty intervals one arrival may decay. 60 intervals is 30s, past the histogram's own
// memory, so a longer pause converges to the same near-reset for a bounded amount of work.
const MAX_CATCHUP = 60;

// How long the target holds before it may step down by another bucket.
const LOWER_INTERVAL = 1000;

// One admitted arrival, on both axes in milliseconds.
type Arrival = { timestamp: number; arrival: number };

/**
 * How much buffer a receiver needs to play audio on time, measured from when frames arrive.
 *
 * Each frame is measured against the fastest recent arrival rather than against the previous one,
 * so a path that slowly gets worse reads as a delay climbing to its real size instead of as a
 * string of tiny inter-arrival deltas. Those delays feed a histogram that is read at a high
 * quantile, because network delay is one-sided and heavy-tailed and a mean plus deviations sizes
 * that tail wrong.
 *
 * The estimate rises the moment a late frame proves the buffer is too shallow and falls one bucket
 * per second, so a refinement shrinks a viewer's buffer in steps it can absorb. It carries no floor
 * of its own: the rendition's advertised jitter is a publisher-declared floor and belongs to
 * whoever combines the two.
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

	// The published target, and when it last moved.
	#target = START;
	#lowered?: number;

	#value = new Signal<Time.Milli>(Time.Milli(START));

	/** The current target: enough buffer to play `QUANTILE` of arrivals on time. */
	readonly value: Getter<Time.Milli> = this.#value;

	/** Seed the histogram with a decaying prior so a cold start has something to quantile. */
	constructor() {
		for (let i = 0; i < BUCKETS; i++) this.#buckets[i] = 0.5 ** (i + 1);
	}

	/**
	 * Fold one frame into the estimate, given its media timestamp and the wall time it arrived.
	 *
	 * Pass `reordered` when the caller already knows the frame came out of order; a frame whose
	 * timestamp is not strictly newer than the newest admitted one is treated the same way. Either
	 * way it is excluded from both the reference and the histogram: its arrival is early relative to
	 * its timestamp, so counting it would add the media-time distance between the two to a delay
	 * measurement.
	 */
	observe(timestamp: Time.Micro, now: Time.Milli, reordered = false): void {
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
		}

		// The bucket's upper edge, because the delay it holds is somewhere inside it.
		this.#optimal = (this.#quantile() + 1) * Jitter.BUCKET;
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
		const optimal = this.#optimal ?? START;
		const current = this.#target;

		if (optimal >= current) {
			// Rise at once: a late frame has already proven the buffer is too shallow, and waiting
			// costs an underrun the viewer hears. The histogram's range bounds how far one
			// observation can take it.
			this.#lowered = now;
			if (optimal > current) this.#set(optimal);
			return;
		}

		// Fall one bucket per second, in as many steps as the elapsed time allows so a 1 fps track
		// and a 50 fps one shrink at the same wall-clock rate. Shrinking faster than this drops the
		// playhead onto a ring the network has not refilled yet.
		this.#lowered ??= now;
		const steps = Math.floor((now - this.#lowered) / LOWER_INTERVAL);
		if (steps <= 0) return;

		this.#lowered += steps * LOWER_INTERVAL;
		this.#set(Math.max(optimal, current - steps * Jitter.BUCKET));
	}

	#set(target: number): void {
		if (target === this.#target) return;
		this.#target = target;
		this.#value.set(Time.Milli(target));
	}
}

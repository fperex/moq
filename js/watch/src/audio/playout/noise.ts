/**
 * What the stream sounds like when nobody is talking.
 *
 * Mirrors `background_noise.cc` and the Rust twin in `rs/moq-audio/src/playout/noise.rs`. Two
 * consumers: the time stretch asks for {@link Noise.energy} to decide whether a block is speech or
 * room tone, and concealment asks for {@link Noise.generate} so a long outage fades into the room
 * rather than into silence.
 *
 * The estimate only moves on a window that is quieter than everything accepted so far and whose
 * spectrum is flat enough to be noise, which is what keeps a held vowel or a sustained tone out of
 * it. The acceptance threshold then climbs slowly on every loud window, so a room that gets
 * noisier is tracked within seconds instead of being locked out forever.
 */

/**
 * Frames each update looks at. NetEq fixes this at 256 samples whatever the rate, which is 5.3ms
 * at 48kHz, and so do we.
 */
const WINDOW = 256;

/** Frames the residual energy is measured over, a quarter of the window. */
const RESIDUAL = 64;

/** Sample energy the estimate is never allowed under, `1.0` in NetEq's Q15 units. */
const MIN_ENERGY = 1 / (32768 * 32768);

/** Starting acceptance threshold, NetEq's `500000` in Q15 units. */
const THRESHOLD = 500_000 / (32768 * 32768);

/**
 * Energy reported before anything has been estimated, NetEq's `75000` fixed threshold in Q15
 * units. Roughly -42 dBFS, so an untrained engine treats anything quieter than about -33 dBFS as
 * passive.
 */
const UNINITIALISED = 75_000 / (32768 * 32768);

/**
 * Per update growth of the acceptance threshold, NetEq's `0.0035` in Q16. Four hundred loud
 * updates, so four seconds of 10ms blocks, raise it by a factor 4.
 */
const THRESHOLD_GROWTH = 1.0035;

/** The loudest window seen decays by this much per update, NetEq's `1023/1024`. */
const MAX_DECAY = 1023 / 1024;

/**
 * The threshold is never more than 60dB under the loudest window, so a stream that only ever gets
 * louder still admits an estimate eventually.
 */
const MAX_RATIO = 1 / 1_048_576;

/**
 * How much residual a window must leave to count as noise rather than tone.
 *
 * NetEq accepts when `5 * residual >= 16 * sample`, with the residual summed over {@link RESIDUAL}
 * frames and the sample energy averaged over {@link WINDOW}, so as a ratio of two averages that is
 * `residual >= sample * 16 / (5 * 64)`. A first order predictor takes 18dB off a sine and almost
 * nothing off white noise, which is the whole point.
 */
const FLATNESS = 16 / (5 * RESIDUAL);

/**
 * The deterministic noise source behind the unvoiced and comfort noise parts.
 *
 * NetEq draws from a fixed table plus a linear congruential step so its output is reproducible
 * across builds (`random_vector.cc`). A xorshift gives us the same property without the table; the
 * Rust twin runs a 64 bit variant, since neither engine is bit exact with the other and only the
 * distribution matters. The same sample feeds every channel, so a correlated stereo image stays
 * correlated.
 */
export class Rng {
	// Any non-zero seed works; this one is shared with the Rust twin.
	#state = 0x2545_f491;

	/** The next sample: white noise with unit variance, so a filter driven by it comes out at its gain. */
	sample(): number {
		let x = this.#state;
		x ^= x << 13;
		x ^= x >>> 17;
		x ^= x << 5;
		this.#state = x >>> 0;
		// 24 bits as a uniform in -1..1, which has variance 1/3.
		return ((this.#state >>> 8) / 8_388_608 - 1) * Math.sqrt(3);
	}
}

/** One channel's estimate: a level, a one pole spectrum, and the search state that replaces them. */
class Channel {
	energy = 2500 / (32768 * 32768);
	maxEnergy = 0;
	threshold = THRESHOLD;
	reflection = 0;
	gain = 0;
	// The one pole filter's memory, so consecutive calls to `generate` are one continuous signal.
	state = 0;

	/** Fold in one window, returning whether it replaced the estimate. */
	update(window: Float32Array): boolean {
		let energy = 0;
		for (const sample of window) energy += sample * sample;
		const r0 = energy;
		energy /= window.length;

		if (energy >= this.threshold) {
			// Loud window. Open the search up a little and remember the peak, so the threshold
			// tracks a room that got noisier instead of locking out.
			this.threshold *= THRESHOLD_GROWTH;
			this.maxEnergy *= MAX_DECAY;
			this.maxEnergy = Math.max(this.maxEnergy, energy);
			this.threshold = Math.max(this.threshold, this.maxEnergy * MAX_RATIO);
			return false;
		}

		// Quiet window: the level is worth having whatever the spectrum turns out to be, so record
		// it before the flatness test can reject the filter.
		this.threshold = Math.max(energy, MIN_ENERGY);
		if (r0 <= 0) return false;

		let r1 = 0;
		for (let i = 1; i < window.length; i++) r1 += window[i - 1] * window[i];
		const reflection = Math.max(-0.99, Math.min(0.99, r1 / r0));

		let residual = 0;
		for (let i = window.length - RESIDUAL; i < window.length; i++) {
			const error = window[i] - reflection * window[i - 1];
			residual += error * error;
		}
		residual /= RESIDUAL;

		// Predictable, so tonal: a vowel or a whistle, not the room.
		if (residual < energy * FLATNESS) return false;

		this.energy = Math.max(energy, MIN_ENERGY);
		this.reflection = reflection;
		this.gain = Math.sqrt(residual);
		return true;
	}
}

/** The background noise estimate for one stream. */
export class Noise {
	#channels: Channel[];
	#initialised = false;
	#window: Float32Array;
	#excitation = new Float32Array(0);

	/** An estimate that reports the fixed floor until it sees a quiet window. */
	constructor(channels: number) {
		this.#channels = [];
		for (let i = 0; i < Math.max(1, channels); i++) this.#channels.push(new Channel());
		this.#window = new Float32Array(WINDOW);
	}

	/** Feed the most recent PCM, planar. Only the tail of the first `length` frames is looked at. */
	update(pcm: Float32Array[], length: number): void {
		const take = Math.min(length, WINDOW);
		if (take < RESIDUAL + 1) return;

		const window = this.#window.subarray(0, take);
		for (let index = 0; index < this.#channels.length; index++) {
			window.set(pcm[Math.min(index, pcm.length - 1)].subarray(length - take, length));
			if (this.#channels[index].update(window)) this.#initialised = true;
		}
	}

	/** Whether a quiet enough window has been seen yet. */
	get initialised(): boolean {
		return this.#initialised;
	}

	/** Mean per sample energy of the background, or the fixed floor before the first estimate lands. */
	energy(channel: number): number {
		if (!this.#initialised) return UNINITIALISED;
		return this.#channels[Math.min(channel, this.#channels.length - 1)].energy;
	}

	/**
	 * Write `count` frames of background noise into `out` at `offset`, scaled by `gain`.
	 *
	 * `out` carries one plane per channel. Silence until the estimate initialises, matching NetEq:
	 * inventing a room tone we have never heard would be worse than the gap.
	 */
	generate(out: Float32Array[], offset: number, count: number, gain: number, rng: Rng): void {
		if (!this.#initialised) {
			for (const plane of out) plane.fill(0, offset, offset + count);
			return;
		}

		// One excitation for every channel, as `expand.cc` does, so noise added to a correlated
		// stereo image does not decorrelate it.
		if (this.#excitation.length < count) this.#excitation = new Float32Array(count);
		const excitation = this.#excitation;
		for (let i = 0; i < count; i++) excitation[i] = rng.sample();

		for (let index = 0; index < this.#channels.length; index++) {
			const channel = this.#channels[index];
			const plane = out[Math.min(index, out.length - 1)];
			for (let i = 0; i < count; i++) {
				const next = channel.gain * excitation[i] + channel.reflection * channel.state;
				channel.state = Math.max(-1, Math.min(1, next));
				plane[offset + i] = channel.state * gain;
			}
		}
	}

	/** Forget everything, for a stream that restarted somewhere else. */
	reset(): void {
		this.#initialised = false;
		for (let i = 0; i < this.#channels.length; i++) this.#channels[i] = new Channel();
	}
}

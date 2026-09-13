/**
 * What the stream sounds like when nobody is talking.
 *
 * Mirrors `background_noise.cc` and the Rust twin in `rs/moq-audio/src/playout/noise.rs`. One
 * consumer so far: the time stretch asks for {@link Noise.energy} to decide whether a block is
 * speech or room tone. Concealment will ask the same estimate for a level to fade a long outage
 * into, which is what the spectrum kept here is for.
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

/** One channel's estimate: a level, a one pole spectrum, and the search state that replaces them. */
class Channel {
	energy = 2500 / (32768 * 32768);
	maxEnergy = 0;
	threshold = THRESHOLD;
	reflection = 0;
	gain = 0;

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

	/** Forget everything, for a stream that restarted somewhere else. */
	reset(): void {
		this.#initialised = false;
		for (let i = 0; i < this.#channels.length; i++) this.#channels[i] = new Channel();
	}
}

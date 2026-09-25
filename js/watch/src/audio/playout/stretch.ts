import type { Noise } from "./noise";

/**
 * Making a block of audio shorter or longer without changing its pitch.
 *
 * Mirrors `time_stretch.cc` and its two subclasses, `accelerate.cc` and `preemptive_expand.cc`,
 * and the Rust twin in `rs/moq-audio/src/playout/stretch.rs`. Both operations are the same splice:
 * find the pitch period, then either drop one period by crossfading over it (the buffer is too
 * full, so play the same audio in less time) or repeat one period the same way (the buffer is too
 * empty, so take longer over it). One period is the only length that leaves the waveform
 * continuous, which is why the whole thing hangs off a correlation search.
 *
 * The search runs twice. A coarse pass over a 4kHz decimation picks the lag out of 50 candidates
 * between 2.5 and 15ms, and one normalised correlation at full rate then says whether that lag is
 * good enough to splice on. A block that is barely above the room tone skips the second test
 * entirely: nobody can hear a splice in noise, and the correlation of noise is meaningless.
 *
 * PCM is planar here, one `Float32Array` per channel, because that is what the ring stores and
 * what the worklet renders. Every length derives from the sample rate, so 44.1kHz AAC works as
 * well as 48kHz Opus.
 */

/** The crossfade a splice gets when the operation does not pick its own length, in milliseconds. */
export const OVERLAP = 5;

/** Shortest pitch period searched, in milliseconds, so 400Hz and up. */
const MIN_LAG = 2.5;

/** Longest pitch period searched, in milliseconds, so 66Hz and up, and where a splice sits. */
export const MAX_LAG = 15;

/** The window a time stretch correlates over, in milliseconds, taken from the 15ms mark. */
export const SEARCH = 12.5;

/**
 * The rate the coarse pitch search runs at, not the input rate: 50 lags of a 4kHz decimation cost
 * a fraction of the same search at 48kHz and land within one decimated sample, which the full-rate
 * check that follows then refines.
 */
export const DECIMATED = 4000;

/** Correlation a time stretch needs before it will splice active speech. */
export const CORRELATION = 0.9;

/** Correlation fast accelerate settles for, because a buffer that far above target is late either way. */
export const CORRELATION_FAST = 0.5;

/**
 * How far above the background a block must sit to count as speech.
 *
 * Below it the correlation is meaningless and a splice is inaudible, so it is always allowed.
 */
const PASSIVE_GATE = 8;

/** How well a sub-multiple of the winning lag must correlate before it is preferred to the lag itself. */
const SUBMULTIPLE = 0.9;

/** Frames in `ms` milliseconds at `rate`. */
export function frames(rate: number, ms: number): number {
	return Math.round((rate * ms) / 1000);
}

/**
 * The fade-out weight at `i` of a `len` sample linear crossfade.
 *
 * NetEq steps a Q14 factor down by `16384 / (len + 1)` per sample (`audio_multi_vector.cc`), so the
 * fade starts at full old signal and stops one step short of full new signal.
 */
export function fade(i: number, len: number): number {
	return 1 - i / (len + 1);
}

/**
 * Resample `input` down to `out.length` samples.
 *
 * NetEq keeps a 3 to 7 tap FIR per supported rate (`dsp_helper.cc`), all of them integer
 * decimations of 8, 16, 32, or 48kHz. We take 44.1kHz too, where the ratio is not an integer, so
 * this is a boxcar average over one decimation span instead: the same job, one tap count short of
 * the same stopband, and the coarse search that consumes it only needs the peak location.
 */
export function decimate(input: Float32Array, out: Float32Array): void {
	const step = input.length / out.length;
	const width = Math.max(1, Math.round(step));

	for (let i = 0; i < out.length; i++) {
		const start = Math.min(Math.round(i * step), input.length);
		const end = Math.min(start + width, input.length);
		let sum = 0;
		for (let j = start; j < end; j++) sum += input[j];
		out[i] = sum / Math.max(1, end - start);
	}
}

/** What the pitch search found. */
export interface Match {
	/** The pitch period, in frames. */
	lag: number;
	/** Normalised correlation at that lag, in `0..=1`. */
	correlation: number;
	/** Whether the block sits far enough above the background to count as speech. */
	active: boolean;
}

/**
 * The correlation at each lag a search tries, shared by every search so none allocates on the audio
 * thread. No search tries more than the lags between 2.5 and 15ms at the decimated rate, whatever
 * the input rate or window, and each reads only the entries it has just written.
 */
const LAGS = new Float64Array(frames(DECIMATED, MAX_LAG) - frames(DECIMATED, MIN_LAG));

/**
 * The lag, in frames, whose autocorrelation against the last `window` milliseconds of `signal` is
 * strongest.
 *
 * One channel, and `signal` must hold `window` plus 15ms. Mirrors `TimeStretch::AutoCorrelation`
 * plus `DspHelper::PeakDetection`: the search itself runs on a 4kHz decimation, and a parabola
 * through the winning bin and its neighbours recovers most of what the decimation threw away.
 *
 * Pass `scratch` (sized `frames(DECIMATED, window + MAX_LAG)`) so the audio thread does not
 * allocate the decimation on every search.
 */
export function peak(signal: Float32Array, rate: number, window: number, scratch?: Float32Array): number {
	const minLag = frames(rate, MIN_LAG);
	const maxLag = frames(rate, MAX_LAG);
	const span = frames(rate, window) + maxLag;
	if (signal.length < span) throw new RangeError("pitch search needs the window plus one max lag");

	const decimated = scratch ?? new Float32Array(frames(DECIMATED, window + MAX_LAG));
	decimate(signal.subarray(signal.length - span), decimated);

	const width = frames(DECIMATED, window);
	const min = frames(DECIMATED, MIN_LAG);
	// Where the correlation window starts, which is also the furthest back a lag can reach without
	// running off the front of the decimation.
	const head = decimated.length - width;
	const longest = Math.min(frames(DECIMATED, MAX_LAG), head);

	// Only the first `count` entries are this search's.
	const count = Math.max(0, longest - min);
	const correlation = LAGS;
	for (let lag = min; lag < longest; lag++) {
		let sum = 0;
		for (let i = 0; i < width; i++) sum += decimated[head + i] * decimated[head - lag + i];
		correlation[lag - min] = sum;
	}

	let best = 0;
	for (let i = 1; i < count; i++) {
		if (correlation[i] > correlation[best]) best = i;
	}

	// A periodic signal correlates about as well at twice its period as at its period, and NetEq
	// splices on whichever wins because either is a whole number of cycles. We want the
	// fundamental: concealment repeats this lag verbatim, and fast accelerate folds it back up to
	// 15ms, so starting from a multiple costs both of them. Walk down the sub-multiples and take
	// the shortest one that still correlates nearly as well.
	const strongest = min + best;
	if (count > 0 && correlation[best] > 0) {
		const floor = SUBMULTIPLE * correlation[best];
		for (let divisor = 2; divisor <= Math.max(1, Math.floor(strongest / min)); divisor++) {
			const candidate = Math.floor(strongest / divisor);
			if (correlation[candidate - min] >= floor) best = candidate - min;
		}
	}

	// Parabolic fit through the peak and its neighbours, for the sub-sample part of the lag that
	// the decimation cannot see.
	let refined = min + best;
	if (best > 0 && best + 1 < count) {
		const left = correlation[best - 1];
		const centre = correlation[best];
		const right = correlation[best + 1];
		const denominator = left - 2 * centre + right;
		if (denominator < 0) {
			refined += Math.max(-1, Math.min(1, (0.5 * (left - right)) / denominator));
		}
	}

	return Math.max(minLag, Math.min(maxLag, Math.round((refined * rate) / DECIMATED)));
}

/** The accelerate and preemptive expand pair for one stream. */
export class Stretch {
	readonly rate: number;
	readonly channels: number;
	/** Where a splice sits, in frames: NetEq's 15ms mark. */
	readonly maxLag: number;
	/** The crossfade floor, in frames. */
	readonly overlap: number;
	/** The correlation window, in frames. */
	readonly window: number;

	#scratch: Float32Array;
	// What `analyse` hands back, filled in place because it runs on the audio thread.
	readonly #match: Match = { lag: 0, correlation: 0, active: false };

	/** A stretcher for planar `channels` channel PCM at `rate`. */
	constructor(rate: number, channels: number) {
		this.rate = rate;
		this.channels = Math.max(1, channels);
		this.maxLag = frames(rate, MAX_LAG);
		this.overlap = frames(rate, OVERLAP);
		this.window = frames(rate, SEARCH);
		this.#scratch = new Float32Array(frames(DECIMATED, SEARCH + MAX_LAG));
	}

	/**
	 * Frames per channel either operation needs before it will look at a block: two 15ms halves
	 * less one frame, as NetEq's `(2 * k15ms - 1) * fs_mult`, which is what lets a rate whose 15ms
	 * does not land on a whole frame still stretch a 30ms block.
	 */
	get required(): number {
		return 2 * this.maxLag - 1;
	}

	/**
	 * The pitch period of the first `length` frames of `input` and how much the waveform repeats at it.
	 *
	 * Reads the reference channel only, as NetEq does, and applies the result to every channel: a
	 * splice at different points per channel would smear the stereo image. The same object every
	 * call, so copy it to keep it.
	 */
	analyse(input: Float32Array[], length: number, noise: Noise): Match {
		const reference = input[0];
		const lag = Math.min(
			peak(reference.subarray(0, this.maxLag + this.window), this.rate, SEARCH, this.#scratch),
			length - this.maxLag,
		);

		// The two halves either side of the 15ms mark, one pitch period each.
		let oldEnergy = 0;
		let newEnergy = 0;
		let cross = 0;
		for (let i = 0; i < lag; i++) {
			const a = reference[this.maxLag - lag + i];
			const b = reference[this.maxLag + i];
			oldEnergy += a * a;
			newEnergy += b * b;
			cross += a * b;
		}

		// NetEq's one line VAD: below eight times the background, a splice is inaudible whatever
		// the correlation says.
		const mean = (oldEnergy + newEnergy) / (2 * lag);
		const active = mean > PASSIVE_GATE * noise.energy(0);

		const match = this.#match;
		match.lag = lag;
		match.correlation =
			oldEnergy > 0 && newEnergy > 0 ? Math.max(0, Math.min(1, cross / Math.sqrt(oldEnergy * newEnergy))) : 0;
		match.active = active;
		return match;
	}

	/**
	 * Drop one pitch period from the first `length` frames of `input`, writing the rest into `out`.
	 *
	 * `fast` is NetEq's fast accelerate: it settles for half the correlation and folds the period
	 * up to as many whole copies as fit in 15ms, for a buffer so far above target that one period
	 * at a time will never catch up.
	 *
	 * Returns the frames removed, so `out` holds `length - removed`, or zero when the correlation
	 * was too weak to splice on and nothing was written.
	 */
	accelerate(input: Float32Array[], length: number, noise: Noise, fast: boolean, out: Float32Array[]): number {
		if (length < this.required) return 0;

		const found = this.analyse(input, length, noise);
		const threshold = fast ? CORRELATION_FAST : CORRELATION;
		if (found.active && found.correlation <= threshold) return 0;

		let lag = found.lag;
		if (fast) {
			// As many whole periods as fit in 15ms, and as fit in the block.
			const copies = Math.min(Math.floor(this.maxLag / lag), Math.floor((length - this.maxLag) / lag));
			lag *= Math.max(1, copies);
		}

		// Keep the first 15ms, crossfade the period that follows onto its tail, then keep
		// everything past that period. The output is one period shorter.
		for (let channel = 0; channel < this.channels; channel++) {
			const src = input[channel];
			const dst = out[channel];
			dst.set(src.subarray(0, this.maxLag));
			for (let i = 0; i < lag; i++) {
				const weight = fade(i, lag);
				const at = this.maxLag - lag + i;
				dst[at] = dst[at] * weight + src[this.maxLag + i] * (1 - weight);
			}
			dst.set(src.subarray(this.maxLag + lag, length), this.maxLag);
		}

		return lag;
	}

	/**
	 * Repeat one pitch period of the first `length` frames of `input`, writing the result into `out`.
	 *
	 * `old` is how many leading frames the caller has already played, which must stay untouched.
	 * NetEq has no fast mode here: a buffer that is too empty cannot afford a worse splice.
	 *
	 * Returns the frames inserted, so `out` holds `length + inserted`, or zero when nothing was written.
	 */
	preemptiveExpand(input: Float32Array[], length: number, old: number, noise: Noise, out: Float32Array[]): number {
		if (length < this.required || old + this.overlap >= length) return 0;

		const found = this.analyse(input, length, noise);
		if (found.active && (found.correlation <= CORRELATION || old > this.maxLag)) return 0;

		// The splice sits at 15ms, or at the end of the played part if that is later.
		const unmodified = Math.max(old, this.maxLag);
		const lag = Math.min(found.lag, length - unmodified);

		for (let channel = 0; channel < this.channels; channel++) {
			const src = input[channel];
			const dst = out[channel];
			dst.set(src.subarray(0, unmodified + lag));
			for (let i = 0; i < lag; i++) {
				const weight = fade(i, lag);
				const at = unmodified + i;
				dst[at] = dst[at] * weight + src[unmodified - lag + i] * (1 - weight);
			}
			dst.set(src.subarray(unmodified, length), unmodified + lag);
		}

		return lag;
	}
}

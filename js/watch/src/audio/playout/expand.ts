import { Rng } from "./noise";
import { DECIMATED, fade, frames, MAX_LAG, OVERLAP, peak } from "./stretch";

/**
 * What to play when the next block of media is not there yet.
 *
 * Mirrors `expand.cc` and the Rust twin in `rs/moq-audio/src/playout/expand.rs`. The last 30ms of
 * real audio are taken apart into a pitch period and a noise spectrum, and each call makes one more
 * block out of the two: the period repeated for the voiced part, white noise through a sixth order
 * filter for the unvoiced part, and a mix between them set by how periodic the signal actually was.
 * A held vowel is nearly all period; a fricative is nearly all noise.
 *
 * Every block after the first is quieter than the last, and once the muting slope has taken the gain
 * to zero the output is digital silence, so an outage that never ends is not a sound. That is what
 * the pinned Chromium tree does: `Expand::Process` scales each block by `mute_factor`, drops the
 * factor by the muting slope every block, and pins it to zero outright past the third consecutive
 * expansion once the slope would no longer lower it; `BackgroundNoise::GenerateBackgroundNoise`
 * ignores both the slope and `TooManyExpands()` it is handed and never raises its own mute factor,
 * which `ChannelParameters::Reset` leaves at 0, so the noise term contributes nothing at any point.
 * Comfort noise belongs to a codec that says it is sending comfort noise; if hang ever carries a
 * DTX/CNG signal, that is where it goes, not here.
 *
 * One simplification against the original, audible only on a long outage, which the muting slope
 * covers anyway: NetEq keeps three candidate lags and alternates between them so a long concealment
 * does not sound metronomic. We keep one.
 */

/** Order of the filter that shapes the unvoiced part, NetEq's `kUnvoicedLpcOrder`. */
const ORDER = 6;

/** Real audio {@link Expand.analyse} studies, in milliseconds. NetEq's `256 * fs_mult`. */
export const HISTORY = 32;

/** Audio the unvoiced filter is fitted over, in milliseconds. NetEq's `kLpcAnalysisLength`. */
const ANALYSIS = 20;

/** Correlation under which a signal counts as unvoiced and the period is not worth repeating alone. */
const VOICED = 0.48;

/**
 * Muting slopes from `expand.cc`, in gain lost per second: the floor for a signal that was not very
 * periodic, then the two escalations a concealment which has gone on too long is forced to.
 */
const MUTE_FLOOR = 40;
const MUTE_AFTER_3 = 8;
const MUTE_AFTER_7 = 16;

/** Voice mix under which the muting floor applies, NetEq's `13107` in Q14. */
const MUTE_FLOOR_MIX = 0.8;

/**
 * The block NetEq itself decides at, in milliseconds.
 *
 * Its concealment ceiling and its two muting escalations are counted in blocks, and this engine's
 * block is twice as long, so both are converted through this rather than copied as block counts: a
 * concealment that gives up after 200 of NetEq's blocks gives up after the same two seconds here.
 */
const NETEQ_BLOCK = 10;

/** Concealment blocks produced back to back before the output is silence and nothing else. */
export const MAX_CONSECUTIVE_EXPANDS = 200;

/** One channel's concealment: a period to repeat, a filter to drive, and the gains between them. */
class Channel {
	/** The pitch period being repeated, and how much of it is in use. */
	readonly period: Float32Array;
	length = 1;

	readonly filter = new Float64Array(ORDER);
	readonly state = new Float64Array(ORDER);
	gain = 0;

	voiceMix = 0;
	currentMix = 1;
	mixStep = 0;
	mute = 1;
	muteSlope = 0;

	// Levinson-Durbin scratch, so fitting the filter allocates nothing on the audio thread.
	readonly #auto = new Float64Array(ORDER + 1);
	readonly #coefficients = new Float64Array(ORDER + 1);
	readonly #previous = new Float64Array(ORDER + 1);

	constructor(maxLag: number) {
		this.period = new Float32Array(Math.max(1, maxLag));
	}

	/** Forget the analysis, so the next concealment studies fresh audio. */
	reset(): void {
		this.length = 1;
		this.period.fill(0);
		this.filter.fill(0);
		this.state.fill(0);
		this.gain = 0;
		this.voiceMix = 0;
		this.currentMix = 1;
		this.mixStep = 0;
		this.mute = 1;
		this.muteSlope = 0;
	}

	/** Study `length` frames of one channel's history, given the lag the reference channel found. */
	analyse(samples: Float32Array, length: number, lag: number, blend: number, voiceMix: number, rate: number): void {
		// One period, with its own tail faded into the run that preceded it, so repeating it joins up
		// where it wraps.
		const tail = length - lag - blend;
		for (let i = 0; i < lag; i++) this.period[i] = samples[tail + blend + i];
		for (let i = 0; i < blend; i++) {
			const weight = fade(i, blend);
			const at = lag - blend + i;
			this.period[at] = this.period[at] * weight + samples[tail + i] * (1 - weight);
		}
		this.length = lag;

		const analysis = Math.min(frames(rate, ANALYSIS), length);
		if (!this.#fit(samples, length - analysis, analysis)) {
			this.filter.fill(0);
			this.gain = 0;
		}
		for (let i = 0; i < ORDER; i++) this.state[i] = samples[length - 1 - i];

		this.voiceMix = voiceMix;
		this.currentMix = 1;
		this.mute = 1;

		// The mix walks from all period to its final blend over 8, 16, or 32ms, longer for a longer
		// period, as `expand.cc` picks by `max_lag_`.
		const mult = rate / 8000;
		const ramp = lag <= 31 * mult ? 8 : lag <= 63 * mult ? 16 : 32;
		this.mixStep = (1 - voiceMix) / frames(rate, ramp);

		// With a single expansion vector the amplitude ratio NetEq derives its slope from is 1 by
		// construction, which leaves only these two cases: hold a periodic signal steady, and fade a
		// barely periodic one out at the floor.
		this.muteSlope = voiceMix <= MUTE_FLOOR_MIX ? MUTE_FLOOR / rate : 0;
	}

	/**
	 * A concealment that has gone on too long is muted whatever it sounded like.
	 *
	 * NetEq escalates on its third and seventh block; `concealed` is a frame count rather than a
	 * block index because this engine's block is not NetEq's, so the comparison is `>=` and raising
	 * the slope again changes nothing.
	 */
	escalate(concealed: number, rate: number): void {
		if (concealed >= frames(rate, 3 * NETEQ_BLOCK)) {
			this.muteSlope = Math.max(this.muteSlope, MUTE_AFTER_3 / rate);
		}
		if (concealed >= frames(rate, 7 * NETEQ_BLOCK)) {
			this.muteSlope = Math.max(this.muteSlope, MUTE_AFTER_7 / rate);
		}
	}

	/** One sample of noise through the fitted filter. */
	unvoiced(excitation: number): number {
		let predicted = 0;
		for (let i = 0; i < ORDER; i++) predicted += this.filter[i] * this.state[i];

		const sample = Math.max(-1, Math.min(1, this.gain * excitation + predicted));
		for (let i = ORDER - 1; i > 0; i--) this.state[i] = this.state[i - 1];
		this.state[0] = sample;
		return sample;
	}

	/** Step the two gains one frame on: toward the final mix, and toward the background. */
	advance(): void {
		this.currentMix = Math.max(this.voiceMix, this.currentMix - this.mixStep);
		this.mute = Math.max(0, this.mute - this.muteSlope);
	}

	/**
	 * Fit an order {@link ORDER} predictor to `length` frames of `samples` from `start`, writing the
	 * coefficients and setting the gain to the residual it leaves behind.
	 *
	 * Levinson-Durbin, as `WebRtcSpl_LevinsonDurbin`. An unstable recursion is rejected rather than
	 * clamped, which leaves the caller with a flat spectrum and no filter, exactly as NetEq does.
	 */
	#fit(samples: Float32Array, start: number, length: number): boolean {
		if (length <= ORDER) return false;

		const auto = this.#auto;
		for (let lag = 0; lag <= ORDER; lag++) {
			let sum = 0;
			for (let i = lag; i < length; i++) sum += samples[start + i] * samples[start + i - lag];
			auto[lag] = sum / length;
		}
		if (auto[0] <= 0) return false;

		const coefficients = this.#coefficients;
		const previous = this.#previous;
		coefficients.fill(0);
		let error = auto[0];

		for (let i = 1; i <= ORDER; i++) {
			let acc = auto[i];
			for (let j = 1; j < i; j++) acc -= coefficients[j] * auto[i - j];

			const reflection = acc / error;
			if (!Number.isFinite(reflection) || Math.abs(reflection) >= 1) return false;

			previous.set(coefficients);
			coefficients[i] = reflection;
			for (let j = 1; j < i; j++) coefficients[j] = previous[j] - reflection * previous[i - j];

			error *= 1 - reflection * reflection;
			if (error <= 0) return false;
		}

		for (let i = 0; i < ORDER; i++) this.filter[i] = coefficients[i + 1];
		this.gain = Math.sqrt(error);
		return true;
	}
}

/**
 * How much of the concealment is the repeated period rather than noise.
 *
 * The cubic from `expand.cc`, evaluated in floating point rather than Q14. It is deliberately
 * discontinuous at {@link VOICED}: below that the signal is treated as unvoiced outright.
 */
export function voiceMix(correlation: number): number {
	const x = correlation;
	const mix = (-5179 + 19931 * x - 16422 * x * x + 5776 * x * x * x) / 4096;
	return Math.max(0, Math.min(1, mix));
}

/**
 * Normalised correlation of the last `window` frames of `length` frames of `signal` against the run
 * one `lag` earlier.
 */
function correlation(signal: Float32Array, length: number, lag: number, window: number): number {
	const newest = length - window;
	const oldest = newest - lag;
	if (oldest < 0) return 0;

	let newEnergy = 0;
	let oldEnergy = 0;
	let cross = 0;
	for (let i = 0; i < window; i++) {
		const a = signal[newest + i];
		const b = signal[oldest + i];
		newEnergy += a * a;
		oldEnergy += b * b;
		cross += a * b;
	}
	if (newEnergy <= 0 || oldEnergy <= 0) return 0;

	return Math.max(0, Math.min(1, cross / Math.sqrt(newEnergy * oldEnergy)));
}

/** Concealment for one stream. */
export class Expand {
	readonly rate: number;
	readonly channels: number;
	/** Frames of real audio {@link analyse} needs. */
	readonly history: number;
	/** Frames one {@link process} produces, per channel. */
	readonly block: number;

	readonly #maxLag: number;
	readonly #overlap: number;
	readonly #ceiling: number;
	readonly #channels: Channel[] = [];

	// The pitch period is shared, so every channel splices at the same point and the stereo image
	// holds; the position it is repeated from carries across blocks.
	#lag = 0;
	#position = 0;
	// Frames of concealment produced since the last real audio, which is what the ceiling and the
	// muting escalations are measured in.
	#concealed = 0;
	#ready = false;

	readonly #rng = new Rng();
	readonly #excitation: Float32Array;
	readonly #scratch: Float32Array;

	/** Concealment for planar `channels` channel PCM at `rate`, producing `block` millisecond blocks. */
	constructor(rate: number, channels: number, block: number) {
		this.rate = rate;
		this.channels = Math.max(1, channels);
		this.history = frames(rate, HISTORY);
		this.block = frames(rate, block);
		this.#maxLag = frames(rate, MAX_LAG);
		this.#overlap = frames(rate, OVERLAP);
		this.#ceiling = frames(rate, MAX_CONSECUTIVE_EXPANDS * NETEQ_BLOCK);
		this.#excitation = new Float32Array(this.block);
		this.#scratch = new Float32Array(frames(DECIMATED, MAX_LAG + MAX_LAG));

		for (let i = 0; i < this.channels; i++) {
			this.#channels.push(new Channel(this.#maxLag));
		}
	}

	/** Frames of concealment produced since the last real audio. */
	get concealed(): number {
		return this.#concealed;
	}

	/** Whether a concealment run is under way, so the history has already been studied. */
	get started(): boolean {
		return this.#concealed > 0;
	}

	/** Whether there is a signal to conceal with, which there is not until {@link analyse} has run. */
	get ready(): boolean {
		return this.#ready;
	}

	/** Whether the ceiling is reached and the output is silence from here. */
	get exhausted(): boolean {
		return this.#concealed >= this.#ceiling;
	}

	/**
	 * Study the tail of the real signal. Call once, when a concealment run starts.
	 *
	 * `history` holds `length` frames per channel, of which at least {@link history} must be real
	 * audio; anything less and the run plays silence instead.
	 */
	analyse(history: Float32Array[], length: number): void {
		const reference = history[0];
		this.#lag = peak(reference.subarray(0, length), this.rate, MAX_LAG, this.#scratch);
		this.#position = 0;
		this.#concealed = 0;
		this.#ready = true;

		const blend = Math.min(this.#overlap, Math.floor(this.#lag / 2));
		const found = correlation(reference, length, this.#lag, this.#maxLag);
		const mix = found > VOICED ? voiceMix(found) : 0;

		for (let index = 0; index < this.channels; index++) {
			const samples = history[Math.min(index, history.length - 1)];
			this.#channels[index].analyse(samples, length, this.#lag, blend, mix, this.rate);
		}
	}

	/** Write one block of concealment into `out` at `offset`. */
	process(out: Float32Array[], offset: number): void {
		if (!this.#ready || this.exhausted) {
			// Nothing to repeat, or nothing left worth repeating. Silence, not room tone: an outage
			// this long is not a quiet room, and a listener who can hear the noise cannot tell
			// whether the talker went quiet or the stream died.
			for (const plane of out) plane.fill(0, offset, offset + this.block);
			this.#grow();
			return;
		}

		// One excitation for every channel, so a correlated image stays correlated.
		for (let i = 0; i < this.block; i++) this.#excitation[i] = this.#rng.sample();

		for (let index = 0; index < this.channels; index++) {
			const state = this.#channels[index];
			const plane = out[Math.min(index, out.length - 1)];
			state.escalate(this.#concealed, this.rate);

			let position = this.#position;
			for (let frame = 0; frame < this.block; frame++) {
				const voiced = state.period[position];
				const unvoiced = state.unvoiced(this.#excitation[frame]);
				const mixed = voiced * state.currentMix + unvoiced * (1 - state.currentMix);

				// The muting slope is the whole ramp: it reaches zero within ~100ms of the
				// escalations, and there is nothing underneath it to fade into.
				plane[offset + frame] = mixed * state.mute;

				position = position + 1 < state.length ? position + 1 : 0;
				state.advance();
			}
		}

		this.#position = (this.#position + this.block) % this.#lag;
		this.#grow();
	}

	/** Count one more block of concealment, held at the ceiling so a dead stream cannot overflow it. */
	#grow(): void {
		this.#concealed = Math.min(this.#concealed + this.block, this.#ceiling);
	}

	/** Forget the analysis, so the next concealment studies fresh audio. */
	reset(): void {
		this.#ready = false;
		this.#concealed = 0;
		this.#position = 0;
		for (const channel of this.#channels) channel.reset();
	}
}

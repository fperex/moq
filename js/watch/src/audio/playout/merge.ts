import { BLOCK } from "./decision";
import { DECIMATED, decimate, fade, frames, MAX_LAG } from "./stretch";

/**
 * Getting back to real audio after a concealment.
 *
 * Mirrors `merge.cc` and the Rust twin in `rs/moq-audio/src/playout/merge.rs`. Concealment and the
 * media that finally arrives are the same speech at different phases, so splicing them at an
 * arbitrary point is a click. This finds where the returning audio lines up with the concealment,
 * keeps the concealment up to that point, and crossfades across the join. Media that comes back much
 * louder than the concealment faded to is brought in quietly and let back up over the crossfade,
 * which is the other half of what makes the return inaudible.
 */

/** The crossfade across the join, in milliseconds. NetEq's `kMaxCorrelationLength * fs_mult`. */
const FADE = 7.5;

/** How much audio the energies are compared over, in milliseconds. NetEq's `64 * fs_mult`. */
const SCALING = 8;

/** The splice from concealment back to real audio, for one stream. */
export class Merge {
	readonly rate: number;
	readonly channels: number;
	/** Crossfade length, in frames. */
	readonly fade: number;

	// How much of each side the energies are compared over, in frames.
	readonly #scaling: number;
	// How far ahead the alignment search looks, and how much returning audio it matches on, both in
	// 4kHz samples.
	readonly #search: number;
	readonly #window: number;
	readonly #new: Float32Array;
	readonly #old: Float32Array;

	/** A splice for planar `channels` channel PCM at `rate`. */
	constructor(rate: number, channels: number) {
		this.rate = rate;
		this.channels = Math.max(1, channels);
		this.fade = frames(rate, FADE);
		this.#scaling = frames(rate, SCALING);
		this.#search = frames(DECIMATED, MAX_LAG);
		this.#window = frames(DECIMATED, BLOCK);
		this.#new = new Float32Array(this.#window);
		this.#old = new Float32Array(this.#search + this.#window);
	}

	/**
	 * Splice `returning` frames of `input` onto `concealed` frames of `expanded`, writing to `out`.
	 *
	 * Returns the frames of concealment kept ahead of the crossfade, so the caller knows how much of
	 * the block it produced was made up. `out` holds that many frames more than `returning`.
	 */
	merge(
		expanded: Float32Array[],
		concealed: number,
		input: Float32Array[],
		returning: number,
		out: Float32Array[],
	): number {
		if (concealed === 0 || returning === 0) {
			for (let channel = 0; channel < out.length; channel++) {
				out[channel].set(input[Math.min(channel, input.length - 1)].subarray(0, returning));
			}
			return 0;
		}

		const best = Math.min(this.#align(expanded, concealed, input, returning), concealed - 1);
		const overlap = Math.min(this.fade, concealed - best, returning);
		const gain = this.#scale(expanded, concealed, input, returning);

		for (let channel = 0; channel < out.length; channel++) {
			const old = expanded[Math.min(channel, expanded.length - 1)];
			const fresh = input[Math.min(channel, input.length - 1)];
			const dst = out[channel];

			dst.set(old.subarray(0, best));
			for (let frame = 0; frame < overlap; frame++) {
				const weight = fade(frame, overlap);
				// Back to full scale across the crossfade, so the media is never held down once the
				// concealment underneath it is gone.
				const unmute = gain + (1 - gain) * (frame / overlap);
				dst[best + frame] = old[best + frame] * weight + fresh[frame] * unmute * (1 - weight);
			}
			dst.set(fresh.subarray(overlap, returning), best + overlap);
		}

		return best;
	}

	/**
	 * Where the returning audio sits against the concealment, in frames.
	 *
	 * A plain cross correlation on the 4kHz decimation, as NetEq does: the crossfade that follows is
	 * wide enough to absorb what the decimation misses.
	 */
	#align(expanded: Float32Array[], concealed: number, input: Float32Array[], returning: number): number {
		const ratio = this.rate / DECIMATED;
		const width = Math.min(this.#window, Math.floor(returning / ratio));
		const span = Math.min(this.#search + width, Math.floor(concealed / ratio));
		if (width === 0 || span <= width) return 0;

		const fresh = this.#new.subarray(0, width);
		const old = this.#old.subarray(0, span);
		decimate(input[0].subarray(0, Math.floor(width * ratio)), fresh);
		decimate(expanded[0].subarray(0, Math.floor(span * ratio)), old);

		let best = 0;
		let strongest = Number.NEGATIVE_INFINITY;
		for (let lag = 0; lag <= span - width; lag++) {
			let score = 0;
			for (let i = 0; i < width; i++) score += fresh[i] * old[lag + i];
			if (score > strongest) {
				strongest = score;
				best = lag;
			}
		}

		return Math.floor(best * ratio);
	}

	/**
	 * How far the returning audio is turned down to meet the concealment.
	 *
	 * Only ever down: concealment that faded toward the background must not be jumped back up to full
	 * scale media in one sample.
	 */
	#scale(expanded: Float32Array[], concealed: number, input: Float32Array[], returning: number): number {
		const count = Math.min(this.#scaling, concealed, returning);

		let old = 0;
		let fresh = 0;
		for (let i = 0; i < count; i++) {
			old += expanded[0][i] * expanded[0][i];
			fresh += input[0][i] * input[0][i];
		}

		return fresh > old && fresh > 0 ? Math.sqrt(old / fresh) : 1;
	}
}

import { Level } from "./level";
import { frames } from "./stretch";

/**
 * Which way to bend the next block of audio.
 *
 * Mirrors `decision_logic.cc`'s `ExpectedPacketAvailable`, which is the branch that runs whenever
 * the audio the engine wants is already buffered. The other branches are concealment, which is the
 * next stage.
 */

/** The engine's output block, in milliseconds. The granularity every decision is taken at. */
export const BLOCK = 20;

/**
 * How far the ring may sit above its target before the reader skips ahead instead of stretching,
 * in milliseconds.
 *
 * One operation moves at most one 15ms pitch period, and the cooldown lets one run every 100ms of
 * output, so five blocks is what the stretch can close in half a second. Past that a listener would
 * be waiting on the catch-up for longer than the jump costs, so the reader jumps.
 *
 * Also the stretch term of the audio age budget's headroom: it is exactly how much late arrival the
 * ring absorbs without dropping a sample. See `maxAgeHeadroom` in `../config`.
 */
export const STRETCH_BOUND = 75;

/**
 * Output a time stretch has to play before the next one is allowed, in milliseconds.
 *
 * NetEq's `kMinTimescaleInterval` is five calls of its 10ms `GetAudio`; ours is five of the 20ms
 * blocks this engine decides at. Without it the filter's lag lets one correction be applied twice.
 */
const COOLDOWN = 100;

/**
 * The slack above the target that is not a reason to accelerate, in milliseconds.
 *
 * NetEq's `kDelayAdjustmentGranularityMs`, added to the target and the widest arrival delay to form
 * the upper limit.
 */
const GRANULARITY = 20;

/**
 * Multiple of the upper limit at which one period at a time will never catch up, so the engine
 * folds the period and drops the correlation requirement. NetEq's `high_limit * 4`.
 */
const FAST = 4;

/**
 * Share of the target below which the engine stops holding audio back and lets the ring refill.
 *
 * NetEq's `kPostponeDecodingLevel`, which postpones *decoding* at half the target so playback does
 * not restart onto an empty buffer. We have no decode to postpone (the ring is fed from the main
 * thread), so the same hysteresis gates expansion instead: below half the target the ring is
 * refilling and stretching would only fight the refill.
 */
const POSTPONE = 0.5;

/** What to do with the next block. */
export type Operation = "normal" | "accelerate" | "fast-accelerate" | "expand";

/** Everything the decision reads about the moment it is taken. */
export interface Demand {
	/** Media samples the ring holds. */
	buffered: number;
	/** Media samples committed to the output block but not emitted yet. */
	queued: number;
	/** The playout target, in samples. */
	target: number;
	/** The most recent insert, in samples: one decoded chunk. */
	chunk: number;
	/** The output frame this block starts at, which is what the cooldown is measured in. */
	outputFrame: number;
}

/** The per-block state machine for one stream. */
export class Decision {
	readonly #rate: number;
	readonly #level = new Level();
	readonly #cooldown: number;
	readonly #granularity: number;

	// Samples the last operation moved, folded into the next update so it is not counted twice.
	#stretched = 0;
	// The output frame a time stretch is allowed again at.
	#ready = Number.NEGATIVE_INFINITY;
	// Whether the next observation replaces the filter rather than being folded into it.
	#seed = true;

	constructor(rate: number) {
		this.#rate = rate;
		this.#cooldown = frames(rate, COOLDOWN);
		this.#granularity = frames(rate, GRANULARITY);
	}

	/** The smoothed buffer level, in samples. Diagnostics and tests. */
	get level(): number {
		return this.#level.filtered;
	}

	/** Fold in the moment and pick the operation for the block about to be produced. */
	decide(demand: Demand): Operation {
		const observed = demand.buffered + demand.queued;
		this.#level.target((demand.target / this.#rate) * 1000);

		if (this.#seed) {
			// A flush, a re-stall, or a target that moved: the level did not drift there, so
			// filtering towards it would spend a second pretending the buffer is somewhere it is
			// not. NetEq reinitialises the filter on the same reasoning (`decision_logic.cc`).
			this.#level.set(observed);
			this.#seed = false;
		} else {
			this.#level.update(observed, this.#stretched);
		}
		this.#stretched = 0;

		const level = this.#level.filtered;
		const low = demand.target;
		const high = low + demand.chunk + this.#granularity;

		// Far enough above that one period at a time will never close it, and a listener is already
		// hearing every word late. No cooldown: this is the case the cooldown would prolong.
		if (level >= FAST * high) return "fast-accelerate";

		if (demand.outputFrame < this.#ready) return "normal";
		if (level >= high) return "accelerate";
		// Below half the target the ring is refilling and holding audio back would fight it.
		if (level < low && level >= low * POSTPONE) return "expand";

		return "normal";
	}

	/**
	 * Record what an operation moved: `shift` is positive for the samples an accelerate removed and
	 * negative for the samples an expansion inserted.
	 */
	applied(shift: number, outputFrame: number): void {
		this.#stretched += shift;
		this.#ready = outputFrame + this.#cooldown;
	}

	/** The timeline moved: forget the level and the cooldown, and adopt the next observation. */
	discontinuity(): void {
		this.#stretched = 0;
		this.#ready = Number.NEGATIVE_INFINITY;
		this.#seed = true;
	}
}

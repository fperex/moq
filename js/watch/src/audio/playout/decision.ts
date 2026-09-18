import { Level } from "./level";
import { frames } from "./stretch";

/**
 * Which way to bend the next block of audio, or what to put there when there is none.
 *
 * Mirrors `decision_logic.cc` and the Rust twin in `rs/moq-audio/src/playout/decision.rs`. Most
 * blocks take the `ExpectedPacketAvailable` branch, which is the one that runs whenever the audio
 * the engine wants is already buffered; the rest are the two concealment operations, which cover a
 * ring that ran dry and the return from it.
 */

/** The engine's output block, in milliseconds. The granularity every decision is taken at. */
export const BLOCK = 20;

/**
 * How far the ring may sit above the level it holds before the reader skips ahead instead of
 * stretching, in milliseconds.
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
 * The slack above the hold level that is not a reason to accelerate, in milliseconds.
 *
 * NetEq's `kDelayAdjustmentGranularityMs`, added to the level the ring holds to form the upper
 * limit.
 */
const GRANULARITY = 20;

/**
 * Multiple of the upper limit at which one period at a time will never catch up, so the engine
 * folds the period and drops the correlation requirement. NetEq's `high_limit * 4`.
 */
const FAST = 4;

/**
 * Share of the hold level below which the engine stops holding audio back and lets the ring refill.
 *
 * NetEq's `kPostponeDecodingLevel`, which postpones *decoding* at half the target so playback does
 * not restart onto an empty buffer. We have no decode to postpone (the ring is fed from the main
 * thread), so the same hysteresis gates expansion instead: below half the level the ring is
 * refilling and stretching would only fight the refill.
 *
 * The other half of that rule, not resuming from a concealment until the ring holds a cushion again,
 * is the ring's: it parks on an underrun and only un-parks once it holds that level again, which is
 * stricter than NetEq's half and is one mechanism rather than two.
 */
const POSTPONE = 0.5;

/** What to do with the next block. */
export type Operation = "normal" | "accelerate" | "fast-accelerate" | "expand" | "conceal" | "merge" | "silence";

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
	/** Whether there is no media to play: the ring is parked, mid-rebase, or empty. */
	starved: boolean;
	/** Whether a gap is concealed with synthesized audio rather than played as a ramp into silence. */
	conceal: boolean;
	/**
	 * Whether the reader should converge on the target, or play through everything it was given.
	 *
	 * Buffered playback holds a lookahead on purpose, so bending the media to reach a target it is
	 * deliberately far above would throw away the very lookahead that was asked for. It still conceals:
	 * a ring that ran dry sounds the same whichever mode asked for the audio.
	 */
	converge: boolean;
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
	// Whether the last block was concealed, so the next media is a splice rather than a play.
	#concealing = false;

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
		if (demand.starved) {
			// Nothing to play. The level is left alone rather than filtered toward zero: the ring
			// re-seeds it on the way out, and a filter walked to empty would ask for an expansion on
			// the first block back.
			this.#concealing = demand.conceal;
			return demand.conceal ? "conceal" : "silence";
		}

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

		if (this.#concealing) {
			// Media is back. It has to be spliced onto the concealment that stood in for it, whatever
			// the level says: an arbitrary join between the two is the click concealment was for.
			this.#concealing = false;
			return "merge";
		}

		if (!demand.converge) return "normal";

		const level = this.#level.filtered;
		// The level the ring holds: the target counts the frame in play, the way NetEq's does (the
		// `packet_buffer` span plus the sync buffer), so what is still waiting to be played is the
		// target plus one chunk. The ring un-stalls and refills to the same level, so a filter aimed at
		// the target alone would ask for an expansion on every block of a perfectly healthy stream.
		const low = demand.target + demand.chunk;
		const high = low + this.#granularity;

		// Far enough above that one period at a time will never close it, and a listener is already
		// hearing every word late. No cooldown: this is the case the cooldown would prolong.
		if (level >= FAST * high) return "fast-accelerate";

		if (demand.outputFrame < this.#ready) return "normal";
		if (level >= high) return "accelerate";
		// Below half the hold level the ring is refilling and holding audio back would fight it.
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

	/**
	 * The buffer moved somewhere the filter never walked to: forget the level and the cooldown, and
	 * adopt the next observation.
	 *
	 * A park, a skip-ahead, or a resume. Whether the last block was concealed survives it, because
	 * that is a fact about the output rather than about the buffer.
	 */
	reseed(): void {
		this.#stretched = 0;
		this.#ready = Number.NEGATIVE_INFINITY;
		this.#seed = true;
	}

	/** The timeline moved: {@link reseed}, and forget that anything was ever concealed. */
	discontinuity(): void {
		this.reseed();
		this.#concealing = false;
	}
}

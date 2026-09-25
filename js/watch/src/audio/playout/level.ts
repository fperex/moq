/**
 * How full the buffer is, smoothed.
 *
 * Mirrors `buffer_level_filter.cc` and the Rust twin in `rs/moq-audio/src/playout/level.rs`. The
 * decision loop must not chase every packet: a single late arrival is not a reason to speed the
 * stream up, and a single early one is not a reason to slow it down. So the raw level goes through
 * a one pole filter first, slower the larger the target is, because a large target is one that
 * expects a wide arrival spread.
 *
 * The one thing that bypasses the filter is a time stretch: samples it just removed or inserted are
 * subtracted outright, so the operation is not counted twice while the filter catches up and does
 * it again.
 */

/**
 * How much of the old level survives each update, by target in milliseconds.
 *
 * NetEq's Q8 factors of 251, 252, 253, and 254 out of 256.
 */
function factor(target: number): number {
	if (target <= 20) return 251 / 256;
	if (target <= 60) return 252 / 256;
	if (target <= 140) return 253 / 256;
	return 254 / 256;
}

/** The smoothed buffer level for one stream, in samples. */
export class Level {
	#filtered = 0;
	#factor = factor(100);

	/** Pick the smoothing for a new target delay, in milliseconds. */
	target(target: number): void {
		this.#factor = factor(target);
	}

	/** Fold in the buffer level, in samples, less whatever a time stretch just moved. */
	update(buffered: number, stretched: number): void {
		const filtered = this.#factor * this.#filtered + (1 - this.#factor) * buffered;
		this.#filtered = Math.max(0, filtered - stretched);
	}

	/**
	 * Jump straight to a level, for a change too large to filter: a flush, a re-stall, or a stream
	 * that restarted somewhere else. NetEq's `SetFilteredBufferLevel`.
	 */
	set(buffered: number): void {
		this.#filtered = buffered;
	}

	/** The smoothed level, in samples. */
	get filtered(): number {
		return Math.round(this.#filtered);
	}
}

/**
 * The smallest buffer depth seen over a sliding window, which is what says a surplus is real.
 *
 * A publisher that flushes several frames at once puts all of them in the ring together, so the
 * depth peaks by a whole flush and drains back to the target before the next one lands. Ruling on
 * that peak would throw away the flush the target was sized to hold. The trough between two flushes
 * is the depth that is actually surplus, so that is what the skip-ahead is measured against; the
 * time stretch handles everything above it.
 *
 * Two buckets rather than a ring of samples: whichever one is filling, the pair always covers at
 * least a whole window of history, and an observation costs two comparisons.
 */
export class Floor {
	#current = Number.POSITIVE_INFINITY;
	#previous = Number.POSITIVE_INFINITY;
	#until: number | undefined;

	/**
	 * Fold in a depth observed at output position `at`, and report the windowed minimum.
	 *
	 * `window` is in the same units as `at`, and both are read modulo 2^32, so a wrapping sample
	 * counter is fine. The first observation reports itself: with no history there is nothing to
	 * tell a peak from a surplus.
	 */
	observe(buffered: number, at: number, window: number): number {
		if (this.#until === undefined || ((at - this.#until) | 0) >= 0) {
			this.#previous = this.#current;
			this.#current = Number.POSITIVE_INFINITY;
			this.#until = (at + window) | 0;
		}
		this.#current = Math.min(this.#current, buffered);
		return Math.min(this.#current, this.#previous);
	}
}

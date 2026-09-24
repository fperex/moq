/**
 * Where a block lives between being decided and being played.
 *
 * Mirrors `sync_buffer.cc` and the Rust twin in `rs/moq-audio/src/playout/sync.rs`. Every operation
 * here writes whole pitch periods, none of which are the 128 frames the AudioWorklet asks for, so
 * something has to hold the remainder. This is that something: a run of planar PCM with a read
 * cursor, keeping a little already played audio behind the cursor because a preemptive expand
 * splices onto what has already been heard, and concealment will want the same history.
 *
 * Fixed capacity and no allocation after construction: this runs on the audio thread. That is why
 * the copies are loops rather than `set(subarray())`, since a view is an allocation too.
 */
export class Sync {
	readonly channels: number;
	/** Played frames kept behind the cursor, for an operation to splice onto. */
	readonly history: number;

	// Planar PCM: history, then the cursor, then what is still to play.
	#samples: Float32Array[];
	#length = 0;
	#cursor = 0;

	/**
	 * A buffer holding `history` frames of already played audio plus `block` frames of queued
	 * audio, both per channel.
	 */
	constructor(channels: number, history: number, block: number) {
		this.channels = Math.max(1, channels);
		this.history = history;
		this.#samples = [];
		for (let i = 0; i < this.channels; i++) this.#samples.push(new Float32Array(history + block));
	}

	/** Frames committed but not played yet. */
	get queued(): number {
		return this.#length - this.#cursor;
	}

	/** Frames of already played audio available to splice onto. */
	get played(): number {
		return this.#cursor;
	}

	/** Commit `count` frames of `pcm` to be played after everything already queued. */
	push(pcm: Float32Array[], offset: number, count: number): void {
		this.#compact(count);
		if (this.#length + count > this.#samples[0].length) {
			throw new RangeError(`audio playout: a ${count} frame block does not fit the output buffer`);
		}

		const at = this.#length;
		for (let channel = 0; channel < this.channels; channel++) {
			const src = pcm[Math.min(channel, pcm.length - 1)];
			const dst = this.#samples[channel];
			for (let i = 0; i < count; i++) dst[at + i] = src[offset + i];
		}
		this.#length += count;
	}

	/** Play `count` queued frames into `out` at `offset`. The caller checks {@link queued} first. */
	pull(out: Float32Array[], offset: number, count: number): void {
		if (count > this.queued) throw new RangeError("audio playout: pulled more than was queued");

		const from = this.#cursor;
		for (let channel = 0; channel < out.length; channel++) {
			const src = this.#samples[Math.min(channel, this.channels - 1)];
			const dst = out[channel];
			for (let i = 0; i < count; i++) dst[offset + i] = src[from + i];
		}
		this.#cursor += count;
	}

	/**
	 * Copy the most recent `count` frames of played audio into the front of `dst`.
	 *
	 * Returns how many it copied, which is short of `count` until that much has been played. An
	 * operation that splices onto already played audio starts from this and appends the new media.
	 */
	borrow(dst: Float32Array[], count: number): number {
		const take = Math.min(count, this.#cursor);
		const from = this.#cursor - take;
		for (let channel = 0; channel < dst.length; channel++) {
			const src = this.#samples[Math.min(channel, this.channels - 1)];
			const out = dst[channel];
			for (let i = 0; i < take; i++) out[i] = src[from + i];
		}
		return take;
	}

	/** Drop the queued audio, keeping the history a splice works from. */
	truncate(): void {
		this.#length = this.#cursor;
	}

	/** Drop everything, played and queued. */
	flush(): void {
		this.#length = 0;
		this.#cursor = 0;
	}

	/** Slide the window back so `count` more frames fit, forgetting played audio past the history. */
	#compact(count: number): void {
		if (this.#length + count <= this.#samples[0].length) return;

		const drop = Math.min(this.#cursor, Math.max(0, this.#cursor - this.history));
		if (drop === 0) return;

		for (const plane of this.#samples) plane.copyWithin(0, drop, this.#length);
		this.#length -= drop;
		this.#cursor -= drop;
	}
}

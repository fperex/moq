import type { Time } from "@moq/net";

interface SampleSpan {
	readonly timestamp: number;
	readonly sampleRate: number;
	readonly numberOfFrames: number;
}

interface Update {
	readonly discontinuity: number;
	readonly group: number;
	readonly end?: Time.Micro;
	readonly frame?: { readonly timestamp: Time.Micro };
}

/** The portion of decoded audio that belongs to the source timeline. */
export interface DecodedSpan {
	/** Source timestamp of the first retained frame. */
	readonly timestamp: Time.Micro;
	/** Decoded frames to skip before copying. */
	readonly frameOffset: number;
	/** Decoded frames to retain after the offset. */
	readonly frames: number;
}

/** Track codec epochs and map decoded output onto the source timeline. */
export class Terminal {
	#discontinuity = 0;
	#end?: Time.Micro;
	// The group that carried `#end`. It bounds only the terminal packets that follow it there.
	#endGroup?: number;
	#epoch?: Time.Micro;
	#preSkip = 0;
	#preSkipRemaining?: number;

	// The source timestamp of the last frame handed to the decoder, and the media duration of one
	// decoded frame, learned from the decoder's own output. Together they say whether the next frame
	// continues the run the decoder is anchored on. See `continues`.
	#fed?: Time.Micro;
	#frame?: Time.Micro;

	/** The exclusive source endpoint most recently received. */
	get end(): Time.Micro | undefined {
		return this.#end;
	}

	/** Reset state for a new container consumer with Opus pre-skip in 48 kHz frames. */
	clear(preSkip = 0): void {
		this.#discontinuity = 0;
		this.#end = undefined;
		this.#preSkip = preSkip;
		this.#frame = undefined;
		this.#fed = undefined;
		this.reanchor();
	}

	/** Apply one ordered consumer result and report whether its codec epoch changed. */
	update(next: Update): boolean {
		const reset = next.discontinuity !== this.#discontinuity;
		if (reset) {
			this.#discontinuity = next.discontinuity;
			this.#end = undefined;
			// The caller re-anchors the decoder on an epoch change, so the frame that opens the new
			// epoch starts the run rather than being measured against the one before the break.
			this.#fed = undefined;
			this.reanchor();
		}
		// A frame from a later group is new media, e.g. resuming after a discontinuity marker.
		if (next.frame && next.group !== this.#endGroup) this.#end = undefined;
		if (next.frame && this.#epoch === undefined) this.#epoch = next.frame.timestamp;
		if (next.end !== undefined) {
			this.#end = next.end;
			this.#endGroup = next.group;
		}
		return reset;
	}

	/**
	 * Note a frame on its way to the decoder, and report whether it continues the run the decoder is
	 * anchored on.
	 *
	 * A decoder timestamps its output by accumulating decoded frame durations from the chunk that
	 * opened the run rather than by copying each chunk's own timestamp, so a hole it is not told
	 * about is swallowed: a subscription that restarts at the live edge after a mute, or a group the
	 * age budget skipped, and every sample after it lands on the media timeline that far in the
	 * past. A `false` means the caller has to drain the decoder and re-anchor it (`reanchor`), which
	 * puts this frame's own timestamp back on the output.
	 */
	continues(timestamp: Time.Micro): boolean {
		const previous = this.#fed;
		this.#fed = timestamp;

		// Nothing to measure a hole against until a run is under way and one frame has decoded.
		if (previous === undefined || this.#frame === undefined) return true;

		// Consecutive frames sit exactly one frame duration apart, so anything past the midpoint of
		// the next slot is a hole rather than the container's timestamp rounding. Forward only: a
		// repeated frame costs the decoder nothing, and a real rewind arrives as a discontinuity.
		return timestamp - previous < this.#frame * 1.5;
	}

	/**
	 * Forget the run the decoder was anchored on, so the next decoded sample opens a new one.
	 *
	 * Called after draining a decoder that is about to be reset: a restarted decoder emits the
	 * codec's pre-skip again, and its output timeline starts over at the next chunk's timestamp.
	 */
	reanchor(): void {
		this.#epoch = undefined;
		this.#preSkipRemaining = undefined;
	}

	/** Remove codec pre-skip and terminal padding from one decoded sample. */
	span(sample: SampleSpan): DecodedSpan {
		const epoch = this.#epoch ?? (sample.timestamp as Time.Micro);
		this.#epoch = epoch;

		// The decoder's own frame duration, which is what a hole in the source is measured against.
		this.#frame = ((sample.numberOfFrames * 1_000_000) / sample.sampleRate) as Time.Micro;

		const delayFrames = Math.floor((this.#preSkip * sample.sampleRate) / 48_000);
		const remaining = this.#preSkipRemaining ?? delayFrames;
		const frameOffset = Math.min(remaining, sample.numberOfFrames);
		this.#preSkipRemaining = remaining - frameOffset;

		const delay = Math.round((delayFrames * 1_000_000) / sample.sampleRate);
		const timestamp = Math.max(epoch, sample.timestamp - delay) as Time.Micro;
		let frames = sample.numberOfFrames - frameOffset;
		if (this.#end !== undefined) {
			if (this.#end <= timestamp) {
				frames = 0;
			} else {
				const duration = this.#end - timestamp;
				const terminalFrames = Math.round((duration * sample.sampleRate) / 1_000_000);
				frames = Math.min(frames, terminalFrames);
			}
		}

		return { timestamp, frameOffset, frames };
	}
}

import type { Time } from "@moq/net";

interface SampleSpan {
	readonly timestamp: number;
	readonly sampleRate: number;
	readonly numberOfFrames: number;
}

interface EncodedSpan {
	readonly timestamp: Time.Micro;
	readonly duration?: Time.Micro;
}

interface PendingSpan {
	readonly duration: Time.Micro;
	readonly run: TimingRun;
	range?: FrameRange;
	consumed: number;
}

interface FrameRange {
	readonly start: number;
	readonly frames: number;
}

interface TimingRun {
	readonly timestamp: Time.Micro;
	nextFrame: number;
	delayFrames: number;
}

const CONTIGUITY_TOLERANCE = 1_000;

interface Update {
	readonly discontinuity: number;
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
	#epoch?: Time.Micro;
	#preSkip = 0;
	#preSkipRemaining?: number;
	#pending: PendingSpan[] = [];
	#pendingHead = 0;
	#mode?: "native" | "mapped";
	#sampleRate?: number;
	#lastInputEnd?: Time.Micro;
	#run?: TimingRun;

	/** The exclusive source endpoint most recently received. */
	get end(): Time.Micro | undefined {
		return this.#end;
	}

	/** Reset state for a new container consumer with Opus pre-skip in 48 kHz frames. */
	clear(preSkip = 0): void {
		this.#discontinuity = 0;
		this.#end = undefined;
		this.#preSkip = preSkip;
		this.#resetEpoch();
	}

	/** Apply one ordered consumer result and report whether its codec epoch changed. */
	update(next: Update): boolean {
		const reset = next.discontinuity !== this.#discontinuity;
		if (reset) {
			this.#discontinuity = next.discontinuity;
			this.#end = undefined;
			this.#resetEpoch();
		}
		if (next.frame && this.#epoch === undefined) this.#epoch = next.frame.timestamp;
		if (next.end !== undefined) this.#end = next.end;
		return reset;
	}

	/** Queue one encoded source span before submitting it to the decoder. */
	push(span: EncodedSpan): void {
		if (span.duration !== undefined && span.duration <= 0) {
			throw new Error("encoded audio duration must be positive");
		}
		this.#mode ??= span.duration === undefined ? "native" : "mapped";
		if (this.#mode === "native") return;
		if (span.duration === undefined) {
			throw new Error("encoded audio duration became unknown within a mapped codec epoch");
		}

		if (
			this.#run === undefined ||
			(this.#lastInputEnd !== undefined && Math.abs(span.timestamp - this.#lastInputEnd) > CONTIGUITY_TOLERANCE)
		) {
			this.#run = { timestamp: span.timestamp, nextFrame: 0, delayFrames: 0 };
		}
		this.#pending.push({ duration: span.duration, run: this.#run, consumed: 0 });
		this.#lastInputEnd = (span.timestamp + span.duration) as Time.Micro;
	}

	/** Map sequential decoder output across queued source spans. */
	spans(sample: SampleSpan): DecodedSpan[] {
		this.#mode ??= "native";
		if (this.#mode === "native") return [this.span(sample)];
		if (this.#sampleRate !== undefined && sample.sampleRate !== this.#sampleRate) {
			throw new Error("decoded audio sample rate changed within one codec epoch");
		}
		this.#sampleRate = sample.sampleRate;

		const delayFrames = Math.floor((this.#preSkip * sample.sampleRate) / 48_000);
		this.#preSkipRemaining ??= delayFrames;
		let frameOffset = 0;

		const decoded: DecodedSpan[] = [];
		while (frameOffset < sample.numberOfFrames) {
			if (this.#pendingHead >= this.#pending.length) {
				throw new Error("decoded audio exceeds queued source duration");
			}
			const pending = this.#pending[this.#pendingHead];
			let range = pending.range;
			if (range === undefined) {
				range = {
					start: pending.run.nextFrame,
					frames: Math.round((pending.duration * sample.sampleRate) / 1_000_000),
				};
				pending.range = range;
				pending.run.nextFrame += range.frames;
			}
			if (pending.consumed >= range.frames) {
				this.#pendingHead++;
				continue;
			}

			let frames = Math.min(sample.numberOfFrames - frameOffset, range.frames - pending.consumed);
			const skipped = Math.min(this.#preSkipRemaining, frames);
			this.#preSkipRemaining -= skipped;
			pending.run.delayFrames += skipped;
			frameOffset += skipped;
			pending.consumed += skipped;
			frames -= skipped;
			if (frames === 0) {
				if (pending.consumed >= range.frames) this.#pendingHead++;
				continue;
			}

			const frame = range.start + pending.consumed - pending.run.delayFrames;
			const mapped = pending.run.timestamp + (frame * 1_000_000) / sample.sampleRate;
			const epoch = this.#epoch ?? pending.run.timestamp;
			this.#epoch = epoch;
			const timestamp = Math.max(epoch, mapped) as Time.Micro;
			let retained = frames;
			if (this.#end !== undefined) {
				if (this.#end <= timestamp) {
					retained = 0;
				} else {
					const terminalFrames = Math.round(((this.#end - timestamp) * sample.sampleRate) / 1_000_000);
					retained = Math.min(retained, terminalFrames);
				}
			}
			if (retained > 0) decoded.push({ timestamp, frameOffset, frames: retained });

			frameOffset += frames;
			pending.consumed += frames;
			if (pending.consumed >= range.frames) this.#pendingHead++;
		}

		this.#compactPending();
		return decoded;
	}

	/** Remove codec pre-skip and terminal padding from one decoded sample. */
	span(sample: SampleSpan): DecodedSpan {
		const epoch = this.#epoch ?? (sample.timestamp as Time.Micro);
		this.#epoch = epoch;

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

	#resetEpoch(): void {
		this.#epoch = undefined;
		this.#preSkipRemaining = undefined;
		this.#pending = [];
		this.#pendingHead = 0;
		this.#mode = undefined;
		this.#sampleRate = undefined;
		this.#lastInputEnd = undefined;
		this.#run = undefined;
	}

	#compactPending(): void {
		if (this.#pendingHead < 64 || this.#pendingHead * 2 < this.#pending.length) return;
		this.#pending = this.#pending.slice(this.#pendingHead);
		this.#pendingHead = 0;
	}
}

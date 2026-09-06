import { Time } from "@moq/net";

export class AudioRingBuffer {
	#buffer: Float32Array[];
	#writeIndex = 0;
	#readIndex = 0;

	readonly rate: number;
	readonly channels: number;
	#stalled = true;

	// Buffered mode: play through everything buffered without skipping ahead.
	readonly #buffered: boolean;
	// Un-stall threshold in samples (how much to buffer before playback starts).
	#latencySamples: number;
	// Whether the read/write indices have been anchored to the first inserted sample.
	#anchored = false;
	// F2 (rtprobe prototype): mode bits and the largest write seen, the slack held above the target.
	#mode = 0;
	#slack = 0;
	// rtprobe (throwaway): skip accounting, read by the worklet.
	skips = 0;
	skipped = 0;
	lastSkip?: { samples: number; buffered: number; latency: number };

	constructor(props: {
		rate: number;
		channels: number;
		latency: Time.Milli;
		buffered?: boolean;
		mode?: number;
	}) {
		if (props.channels <= 0) throw new Error("invalid channels");
		if (props.rate <= 0) throw new Error("invalid sample rate");
		if (props.latency <= 0) throw new Error("invalid latency");

		this.#latencySamples = Math.ceil(props.rate * Time.Second.fromMilli(props.latency));
		if (this.#latencySamples === 0) throw new Error("empty buffer");

		this.rate = props.rate;
		this.channels = props.channels;
		this.#buffered = props.buffered ?? false;
		this.#mode = props.mode ?? 0;

		// The ring holds the latency floor as PCM. Buffered mode gives it headroom above the floor
		// so the backpressure-paced decode loop (on the main thread) doesn't overflow-drop; the rest
		// of the lookahead stays encoded upstream.
		const capacity = this.#capacityFor(this.#latencySamples);

		this.#buffer = [];
		for (let i = 0; i < this.channels; i++) {
			this.#buffer[i] = new Float32Array(capacity);
		}
	}

	#capacityFor(latencySamples: number): number {
		// With hysteresis the ring must hold the target plus a chunk of slack plus one write.
		return this.#buffered || this.#hysteresis ? latencySamples * 2 : latencySamples;
	}

	get #hysteresis(): boolean {
		return (this.#mode & 1) !== 0;
	}

	/** rtprobe: the current target depth in samples. */
	get latency(): number {
		return this.#latencySamples;
	}
	get stalled(): boolean {
		return this.#stalled;
	}

	get timestamp(): Time.Micro {
		return Time.Micro.fromSecond((this.#readIndex / this.rate) as Time.Second);
	}

	get length(): number {
		return this.#writeIndex - this.#readIndex;
	}

	get capacity(): number {
		return this.#buffer[0]?.length;
	}

	resize(latency: Time.Milli): void {
		this.#latencySamples = Math.ceil(this.rate * Time.Second.fromMilli(latency));

		const newCapacity = this.#capacityFor(this.#latencySamples);
		if (newCapacity === this.capacity) return;
		if (newCapacity === 0) throw new Error("empty buffer");

		const newBuffer: Float32Array[] = [];
		for (let i = 0; i < this.channels; i++) {
			newBuffer[i] = new Float32Array(newCapacity);
		}

		// Copy existing data, preserving the most recent samples
		const samplesToKeep = Math.min(this.length, newCapacity);
		if (samplesToKeep > 0) {
			// Copy the most recent samples (closest to writeIndex)
			const copyStart = this.#writeIndex - samplesToKeep;
			for (let channel = 0; channel < this.channels; channel++) {
				const src = this.#buffer[channel];
				const dst = newBuffer[channel];
				for (let i = 0; i < samplesToKeep; i++) {
					const srcPos = (copyStart + i) % src.length;
					const dstPos = (copyStart + i) % dst.length;
					dst[dstPos] = src[srcPos];
				}
			}
		}

		// Update state for the new buffer, only stall if empty.
		this.#buffer = newBuffer;
		this.#readIndex = this.#writeIndex - samplesToKeep;
		if (samplesToKeep === 0) this.#stalled = true;
	}

	write(timestamp: Time.Micro, data: Float32Array[]): void {
		if (data.length !== this.channels) throw new Error("wrong number of channels");

		const absolute = Math.round(Time.Second.fromMicro(timestamp) * this.rate);
		// Anchor both indices to the first sample so we play from its timestamp instead of
		// gap-filling silence from index 0 to a large timestamp, which would both waste the
		// ring on zeros and report a playhead a floor behind the first real sample.
		if (!this.#anchored) {
			this.#readIndex = absolute;
			this.#writeIndex = absolute;
			this.#anchored = true;
		}

		const trimmed = this.#trimOld(absolute, data[0].length);
		if (trimmed === undefined) return;
		const { start, samples } = trimmed;
		const end = start + samples;

		this.#overflow(end);
		this.#gapFill(start);
		this.#copyIn(start, data, samples);

		// Update write index, but only if we're moving forward
		if (end > this.#writeIndex) this.#writeIndex = end;
		this.#slack = Math.max(this.#slack, data[0].length);
		this.#settle();
	}

	/** Ignore samples that are too old (before the read index). Undefined when nothing is left. */
	#trimOld(start: number, samples: number): { start: number; samples: number } | undefined {
		const offset = this.#readIndex - start;
		if (offset > samples) return undefined;
		if (offset > 0) return { start: start + offset, samples: samples - offset };
		return { start, samples };
	}

	/** Discard old samples to prevent overflow, which also exits stalled mode (the legacy un-stall). */
	#overflow(end: number): void {
		const overflow = end - this.#readIndex - this.#buffer[0].length;
		if (overflow < 0) return;
		this.#stalled = false;
		if (overflow === 0) return; // exactly full: nothing discarded
		this.#readIndex += overflow;
		this.skips++;
		this.skipped += overflow;
		this.lastSkip = {
			samples: overflow,
			buffered: this.#writeIndex - this.#readIndex,
			latency: this.#latencySamples,
		};
	}

	/** Fill gaps with zeros if there's a discontinuity. */
	#gapFill(start: number): void {
		if (start <= this.#writeIndex) return;
		const gapSize = Math.min(start - this.#writeIndex, this.#buffer[0].length);
		if (gapSize === 1) console.warn("floating point inaccuracy detected");
		for (let channel = 0; channel < this.channels; channel++) {
			const dst = this.#buffer[channel];
			for (let i = 0; i < gapSize; i++) {
				dst[(this.#writeIndex + i) % dst.length] = 0;
			}
		}
	}

	#copyIn(start: number, data: Float32Array[], samples: number): void {
		for (let channel = 0; channel < this.channels; channel++) {
			let src = data[channel];
			src = src.subarray(src.length - samples);
			const dst = this.#buffer[channel];
			if (src.length !== samples) throw new Error("mismatching number of samples");
			for (let i = 0; i < samples; i++) {
				dst[(start + i) % dst.length] = src[i];
			}
		}
	}

	/**
	 * Start playback once we've buffered the latency target, and with hysteresis (F2) skip ahead
	 * only once more than target + one chunk is held. Buffered mode starts at the target too and
	 * never skips. Without either, the legacy path relies on the overflow branch above.
	 */
	#settle(): void {
		const length = this.length;
		if (this.#buffered || this.#hysteresis) {
			if (length >= this.#latencySamples) this.#stalled = false;
		}
		if (!this.#hysteresis || this.#buffered) return;
		if (length <= this.#latencySamples + this.#slack) return;
		const skip = length - this.#latencySamples;
		this.#readIndex += skip;
		this.skips++;
		this.skipped += skip;
		this.lastSkip = { samples: skip, buffered: length, latency: this.#latencySamples };
	} /**
	 * Drop buffered samples at or after `timestamp`, keeping whatever is already due.
	 *
	 * A successor track overwrites the slots its own samples land on, but anything the previous
	 * track wrote beyond them would otherwise still play once the successor runs out.
	 */
	truncate(timestamp: Time.Micro): void {
		const target = Math.round(Time.Second.fromMicro(timestamp) * this.rate);
		if (target >= this.#writeIndex) return;
		// Never retreat past the playhead: those samples are already due.
		this.#writeIndex = Math.max(target, this.#readIndex);
	}

	// Flush all buffered samples and re-stall, ready to anchor the next utterance.
	reset(): void {
		this.#readIndex = 0;
		this.#writeIndex = 0;
		this.#stalled = true;
		this.#anchored = false;
	}

	read(output: Float32Array[]): number {
		if (output.length !== this.channels) throw new Error("wrong number of channels");
		if (this.#stalled) return 0;

		const samples = Math.min(this.#writeIndex - this.#readIndex, output[0].length);
		// F2: an underrun re-stalls the ring so it refills to the target before resuming.
		if (samples < output[0].length && this.#hysteresis) this.#stalled = true;
		if (samples === 0) return 0;

		for (let channel = 0; channel < this.channels; channel++) {
			const dst = output[channel];
			const src = this.#buffer[channel];

			if (dst.length !== output[0].length) throw new Error("mismatching number of samples");

			for (let i = 0; i < samples; i++) {
				const readPos = (this.#readIndex + i) % src.length;
				dst[i] = src[readPos];
			}
		}

		this.#readIndex += samples;
		return samples;
	}
}

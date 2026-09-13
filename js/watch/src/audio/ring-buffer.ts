import { Time } from "@moq/net";
import type { Playhead } from "./playhead";
import { type Counters, Floor, frames, type RingReader, type RingView, type Snapshot, STRETCH_BOUND } from "./playout";

export class AudioRingBuffer implements RingReader {
	#buffer: Float32Array[];
	#writeIndex = 0;
	#readIndex = 0;

	readonly rate: number;
	readonly channels: number;
	#stalled = true;
	#underruns = 0;

	// Samples in the most recent write, i.e. one decoded chunk. The overflow band tolerates this
	// much above the target before dropping, so a ring sitting exactly on the target doesn't drop
	// audio the moment the next chunk lands. The most recent write rather than a running maximum:
	// one oversized decode would otherwise widen the band for the life of the ring.
	#chunk = 0;

	// Buffered mode: play through everything buffered without skipping ahead.
	readonly #buffered: boolean;
	// Un-stall threshold in samples (how much to buffer before playback starts).
	#latencySamples: number;
	// Whether the read/write indices have been anchored to the first inserted sample.
	#anchored = false;

	// Bumped whenever the media timeline is replaced, so a reader holding a block from the previous
	// one knows to drop it. The shared transport reads its mutation epoch for the same purpose.
	#generation = 0;

	// How far above `latency + chunk` the ring may sit before the reader skips ahead. A property of
	// the reader's time stretch rather than of this stream: everything inside the band is something
	// the stretch closes without dropping a sample.
	readonly #skip: number;

	// What the playout engine is holding, plus what the writer threw away. The shared transport
	// keeps the same numbers in its control array; here the worklet owns both ends, so they are
	// plain fields shipped to the main thread in the state message.
	#counters: Counters = {
		queued: 0,
		stretched: 0,
		output: 0,
		concealed: 0,
		accelerates: 0,
		expands: 0,
		merges: 0,
		short: 0,
	};
	#skips = 0;
	#skipped = 0;
	#discarded = 0;
	// Samples the writer dropped out from under the reader since its last view, which the playout
	// engine has to treat as a step rather than as the buffer draining.
	#jumped = 0;

	// The depth the ring keeps between flushes, which is the one that says a surplus is real.
	#floor = new Floor();
	#lastOutput = 0;
	#lastStretched = 0;
	#lastConcealed = 0;

	constructor(props: {
		rate: number;
		channels: number;
		latency: Time.Milli;
		buffered?: boolean;
	}) {
		if (props.channels <= 0) throw new Error("invalid channels");
		if (props.rate <= 0) throw new Error("invalid sample rate");
		if (props.latency <= 0) throw new Error("invalid latency");

		this.#latencySamples = Math.ceil(props.rate * Time.Second.fromMilli(props.latency));
		if (this.#latencySamples === 0) throw new Error("empty buffer");

		this.rate = props.rate;
		this.channels = props.channels;
		this.#buffered = props.buffered ?? false;
		this.#skip = frames(props.rate, STRETCH_BOUND);

		// The ring holds the latency floor as PCM, with headroom above it. Sizing capacity to the
		// floor exactly makes the ring physically incapable of holding the slack the overflow band
		// wants, so every chunk that arrives while the ring is on target drops the oldest samples.
		// In buffered mode the headroom is also what keeps the backpressure-paced decode loop (on
		// the main thread) from overflow-dropping; the rest of the lookahead stays encoded upstream.
		const capacity = this.#capacityFor(this.#latencySamples);

		this.#buffer = [];
		for (let i = 0; i < this.channels; i++) {
			this.#buffer[i] = new Float32Array(capacity);
		}
	}

	// Twice the target, plus the stretch band the reader converges across so the ring can physically
	// hold it however shallow the target is. `resize` keeps this true as the target moves, which is
	// what stops a rising adaptive target from being silently capped by the `Math.min(..., capacity)`
	// in `write`. Buffered mode never skips ahead, so it has no band to hold.
	#capacityFor(latencySamples: number): number {
		return latencySamples * 2 + (this.#buffered ? 0 : this.#skip);
	}

	get stalled(): boolean {
		return this.#stalled;
	}

	/** How many times the reader has run dry mid-playback. */
	get underruns(): number {
		return this.#underruns;
	}

	/**
	 * Current playback timestamp: READ less what the reader is still holding.
	 *
	 * A time stretch makes those two diverge, and it is the media position, not the output frame
	 * count, that video has to be paced against.
	 */
	get timestamp(): Time.Micro {
		return Time.Micro.fromSecond(((this.#readIndex - this.#counters.queued) / this.rate) as Time.Second);
	}

	/**
	 * Where the reader is on the media timeline and how fast it is moving, or undefined until the
	 * first write anchors the ring.
	 *
	 * Read in the worklet and posted to the main thread, which extrapolates between messages, so it
	 * is stateful: the rate is measured between reads of this getter.
	 *
	 * The rate is the reader's own, `1 + (dSTRETCHED - dCONCEALED)/dOUTPUT`: it consumes a sample of
	 * media per output frame while playing normally, a few percent more or less while a time stretch
	 * converges on the target, and none at all while concealment covers a gap or while parked, so
	 * whoever follows this playhead waits with the audio rather than running away from it.
	 */
	get playhead(): Playhead | undefined {
		if (!this.#anchored) return undefined;

		const elapsed = this.#counters.output - this.#lastOutput;
		const moved = this.#counters.stretched - this.#lastStretched - (this.#counters.concealed - this.#lastConcealed);
		this.#lastOutput = this.#counters.output;
		this.#lastStretched = this.#counters.stretched;
		this.#lastConcealed = this.#counters.concealed;

		return { timestamp: this.timestamp, rate: elapsed > 0 ? 1 + moved / elapsed : 0 };
	}

	/**
	 * Every counter at once, for the quality harness and the stats panel.
	 *
	 * @internal
	 */
	debug(): Snapshot {
		return {
			...this.#counters,
			buffered: this.length,
			target: this.#latencySamples,
			chunk: this.#chunk,
			skip: this.#skip,
			stalled: this.#stalled,
			underruns: this.#underruns,
			skips: this.#skips,
			skipped: this.#skipped,
			discarded: this.#discarded,
		};
	}

	get length(): number {
		return this.#writeIndex - this.#readIndex;
	}

	get capacity(): number {
		return this.#buffer[0]?.length;
	}

	resize(latency: Time.Milli): void {
		this.#latencySamples = Math.ceil(this.rate * Time.Second.fromMilli(latency));

		if (this.#latencySamples === 0) throw new Error("empty buffer");

		const newCapacity = this.#capacityFor(this.#latencySamples);
		if (newCapacity === this.capacity) return;

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
		this.#generation++;
	}

	write(timestamp: Time.Micro, data: Float32Array[]): void {
		if (data.length !== this.channels) throw new Error("wrong number of channels");

		let start = Math.round(Time.Second.fromMicro(timestamp) * this.rate);
		let samples = data[0].length;

		// Anchor both indices to the first sample so we play from its timestamp instead of
		// gap-filling silence from index 0 to a large timestamp, which would both waste the
		// ring on zeros and report a playhead a floor behind the first real sample.
		if (!this.#anchored) {
			this.#readIndex = start;
			this.#writeIndex = start;
			this.#anchored = true;
			this.#generation++;
		}

		// Ignore samples that are too old (before the read index)
		let offset = this.#readIndex - start;
		if (offset > samples) {
			// All samples are too old, ignore them
			this.#discarded += samples;
			return;
		} else if (offset > 0) {
			// Some samples are too old, skip them
			this.#discarded += offset;
			samples -= offset;
			start += offset;
		} else {
			offset = 0;
		}

		const end = start + samples;
		this.#chunk = data[0].length;

		// Bound the ring. While playing, drop the oldest once it holds a whole chunk plus the stretch
		// band more than the target and land back on the target: frames arrive one chunk at a time,
		// so a ring sitting exactly on the target is a chunk above it the moment the next one lands,
		// and dropping on that overshoot discards audio on every single write. The band on top is
		// what the reader's time stretch closes on its own, so everything inside it plays rather
		// than being thrown away. While stalled the reader is not consuming, so only the hard
		// capacity applies; the band would throw away the very audio the refill is accumulating.
		// Buffered mode plays through everything, so it is capacity-bound too.
		const playing = !this.#stalled && !this.#buffered;
		const slack = this.#chunk + this.#skip;
		const band = playing ? Math.min(this.#latencySamples + slack, this.capacity) : this.capacity;
		const depth = end - this.#readIndex;
		// A flush lands several frames at once, so the depth peaks by a whole flush and drains back
		// before the next one: the trough between two flushes is the part that is actually surplus.
		const sustained = playing ? this.#floor.observe(depth, this.#readIndex, this.#latencySamples) : depth;
		// While stalled or buffered the reader is not consuming, so only the hard capacity applies;
		// the band would throw away the very audio the refill is accumulating.
		const surplus = playing && sustained > band;
		if (surplus || depth > this.capacity) {
			const to = end - (surplus ? Math.min(this.#latencySamples, this.capacity) : this.capacity);
			const dropped = Math.max(0, to - this.#readIndex);
			this.#discarded += dropped;
			this.#jumped += dropped;
			this.#readIndex = to;
		}

		if (start > this.#writeIndex) {
			if (!this.#buffered && this.#readIndex >= this.#writeIndex) {
				// Nothing left to play, so the hole is media that was never sent and the reader is
				// already covering for it: queueing it as silence would make a listener wait for the
				// same missing audio a second time. Step the playhead over it instead. Buffered
				// playback keeps the silence, because a producer writing ahead of the playhead means
				// the pause it wrote.
				const hole = start - this.#writeIndex;
				this.#skips++;
				this.#skipped += hole;
				this.#jumped += hole;
				this.#readIndex = start;
				this.#writeIndex = start;
			} else {
				// Fill the gap with zeros: there is audio behind it that still has to play in place.
				const gapSize = Math.min(start - this.#writeIndex, this.#buffer[0].length);
				if (gapSize === 1) {
					console.warn("floating point inaccuracy detected");
				}

				for (let channel = 0; channel < this.channels; channel++) {
					const dst = this.#buffer[channel];
					for (let i = 0; i < gapSize; i++) {
						const writePos = (this.#writeIndex + i) % dst.length;
						dst[writePos] = 0;
					}
				}
			}
		}

		// Write the actual samples
		for (let channel = 0; channel < this.channels; channel++) {
			let src = data[channel];
			src = src.subarray(src.length - samples);

			const dst = this.#buffer[channel];
			if (src.length !== samples) throw new Error("mismatching number of samples");

			for (let i = 0; i < samples; i++) {
				const writePos = (start + i) % dst.length;
				dst[writePos] = src[i];
			}
		}

		// Update write index, but only if we're moving forward
		if (end > this.#writeIndex) {
			this.#writeIndex = end;
		}

		// Start playback once we've buffered the latency target. This is the only way out of a
		// stall, so an underrun mid-playback refills to the target before resuming rather than
		// playing the next chunk on an empty cushion.
		if (this.length >= this.#latencySamples) {
			this.#stalled = false;
		}
	}

	/**
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
		this.#generation++;
	}

	/**
	 * Hold playback until the ring holds the target again, keeping everything buffered.
	 *
	 * Used when the target deepens: `resize` alone only raises the bar a future refill has to clear,
	 * so a ring already playing keeps draining at its old depth and audio runs that much ahead of
	 * video. Parking the playhead spends exactly the deficit as silence and resumes on the same
	 * timeline, where `reset` would throw the buffer away and re-anchor.
	 */
	stall(): void {
		this.#stalled = true;
	}

	// Flush all buffered samples and re-stall, ready to anchor the next utterance.
	reset(): void {
		this.#readIndex = 0;
		this.#writeIndex = 0;
		this.#stalled = true;
		this.#anchored = false;
		this.#generation++;
	}

	/**
	 * Sample the ring, and remember what was sampled. The first of the three calls a read is made of.
	 *
	 * This transport has no writer racing the reader (the worklet owns both ends), so there is
	 * nothing to skip ahead over here: `write` bounds the ring on the way in. The band is reported
	 * so the reader sees the same shape it does on the shared transport.
	 */
	view(): RingView {
		const buffered = this.#writeIndex - this.#readIndex;
		return {
			buffered: this.#stalled ? 0 : buffered,
			target: this.#latencySamples,
			chunk: this.#chunk,
			skip: this.#skip,
			stalled: this.#stalled,
			unstable: false,
			converge: !this.#buffered,
			// The writer bounds this ring on the way in, so the jump is on its side rather than here.
			skipped: this.#jumped,
			generation: this.#generation,
		};
	}

	/** Copy `count` buffered samples into `dst` at `offset`, without advancing the playhead. */
	peek(dst: Float32Array[], count: number, offset = 0): void {
		for (let channel = 0; channel < dst.length; channel++) {
			const src = this.#buffer[Math.min(channel, this.channels - 1)];
			const out = dst[channel];
			for (let i = 0; i < count; i++) {
				out[offset + i] = src[(this.#readIndex + i) % src.length];
			}
		}
	}

	/**
	 * Advance the playhead by `count` samples past what {@link view} sampled.
	 *
	 * Always succeeds: the writer is the worklet's own message handler, so it cannot move the
	 * timeline part way through a read the way the shared transport's main thread can.
	 */
	commit(count: number): boolean {
		this.#readIndex += count;
		this.#jumped = 0;
		return true;
	}

	/**
	 * The reader ran dry mid-playback: count the underrun and park until the ring holds the target.
	 * Only once the caller has seen an empty {@link view}.
	 */
	starve(): void {
		this.#stalled = true;
		this.#underruns++;
	}

	/** Record what the reader's playout engine is holding, so the state message can carry it. */
	report(counters: Counters): void {
		this.#counters = counters;
	}

	/**
	 * Read audio samples into the output buffers. Returns the number of samples read.
	 *
	 * {@link view}, {@link peek}, and {@link commit} in a row, which is what a reader that plays
	 * the media exactly as it arrives does.
	 */
	read(output: Float32Array[]): number {
		if (output.length !== this.channels) throw new Error("wrong number of channels");

		const view = this.view();
		if (view.stalled) return 0;

		const samples = Math.min(view.buffered, output[0].length);
		if (samples <= 0) {
			// Ran dry mid-playback: re-stall so write() refills to the target before resuming.
			this.starve();
			return 0;
		}

		this.peek(output, samples);
		this.commit(samples);

		// This reader holds nothing back and stretches nothing, so every sample it takes is a frame
		// it emits. Recorded so the playhead reads the same whichever reader drives the ring.
		this.#counters.output += samples;

		// A short quantum ends in silence, so it counts as an underrun even if a chunk lands before
		// the next read. It does not park playback: the shortfall is under one quantum, and a
		// refill would spend the whole target as silence to cover it.
		if (samples < output[0].length) {
			this.#underruns++;
			this.#counters.short++;
		}

		return samples;
	}
}

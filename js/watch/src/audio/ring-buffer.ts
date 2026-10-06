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

	// Buffered mode: play through everything buffered without skipping ahead.
	readonly #buffered: boolean;
	// Un-stall threshold in samples (how much to buffer before playback starts), and the level the
	// ring holds while it plays.
	#latencySamples: number;
	// Whether the read/write indices have been anchored to the first inserted sample.
	#anchored = false;

	// Bumped whenever the ring re-anchors to a new media timeline, so a reader holding a block from
	// the previous one knows to drop it. The shared transport reads its TIMELINE slot for the same
	// purpose.
	#generation = 0;

	// How far above the target the ring may sit before it drops audio. See SKIP in
	// `shared-ring-buffer.ts`.
	readonly #skip: number;

	// What the playout engine is holding, plus what the writer threw away. The shared transport
	// keeps the same numbers in its control array; here the worklet owns both ends, so they are
	// plain fields shipped to the main thread in the state message.
	readonly #counters: Counters = {
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

	// The widest chunk written so far, which capacity has to hold on top of the target. A high-water
	// mark rather than the current chunk, because shrinking the array back can leave samples behind,
	// which replaces the timeline: a publisher alternating two frame durations would otherwise risk
	// that on every other write. It only costs memory.
	#largest = 0;

	// The depth the ring keeps between flushes, which is the one that says a surplus is real.
	#floor = new Floor();
	#lastOutput = 0;
	#lastStretched = 0;
	#lastConcealed = 0;

	// What `view` and `debug` hand back, filled in place: both run on the audio thread, where an
	// object per call is garbage for its collector. The main thread only ever sees the copy the
	// state message makes.
	readonly #view: RingView = {
		buffered: 0,
		target: 0,
		skip: 0,
		stalled: true,
		unstable: false,
		converge: true,
		skipped: 0,
		generation: 0,
	};
	readonly #playhead: Playhead = { timestamp: Time.Micro.zero, rate: 0 };
	readonly #snapshot: Snapshot = {
		backend: "message",
		queued: 0,
		stretched: 0,
		output: 0,
		concealed: 0,
		accelerates: 0,
		expands: 0,
		merges: 0,
		short: 0,
		buffered: 0,
		target: 0,
		skip: 0,
		stalled: true,
		underruns: 0,
		skips: 0,
		skipped: 0,
		discarded: 0,
	};

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

	// The level the ring holds, plus the stretch band the reader converges across, so the ring can
	// physically hold both however shallow the target is. `resize` keeps this true as the target
	// moves and {@link write} keeps it true as the chunk does, which is what stops a rising adaptive
	// target or a publisher with frames longer than its own advertised jitter from being silently
	// capped by the `Math.min(..., capacity)` in `write`. Buffered mode never skips ahead, so it has
	// no band to hold.
	#capacityFor(latencySamples: number): number {
		if (this.#buffered) return latencySamples * 2;
		return latencySamples + Math.max(latencySamples, this.#largest) + this.#skip;
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
	 * is stateful: the rate is measured between reads of this getter. The same object every read,
	 * so copy it to keep it. The rate is the reader's own; see `SharedRingBuffer.playhead`.
	 */
	get playhead(): Playhead | undefined {
		if (!this.#anchored) return undefined;

		const elapsed = this.#counters.output - this.#lastOutput;
		const moved = this.#counters.stretched - this.#lastStretched - (this.#counters.concealed - this.#lastConcealed);
		this.#lastOutput = this.#counters.output;
		this.#lastStretched = this.#counters.stretched;
		this.#lastConcealed = this.#counters.concealed;

		const playhead = this.#playhead;
		playhead.timestamp = this.timestamp;
		playhead.rate = elapsed > 0 ? 1 + moved / elapsed : 0;
		return playhead;
	}

	/**
	 * Every counter at once, for the quality harness and the stats panel. The same object every
	 * call, so copy it to keep it.
	 *
	 * @internal
	 */
	debug(): Snapshot {
		const snapshot = this.#snapshot;
		const counters = this.#counters;
		snapshot.queued = counters.queued;
		snapshot.stretched = counters.stretched;
		snapshot.output = counters.output;
		snapshot.concealed = counters.concealed;
		snapshot.accelerates = counters.accelerates;
		snapshot.expands = counters.expands;
		snapshot.merges = counters.merges;
		snapshot.short = counters.short;
		snapshot.buffered = this.length;
		snapshot.target = this.#latencySamples;
		snapshot.skip = this.#skip;
		snapshot.stalled = this.#stalled;
		snapshot.underruns = this.#underruns;
		snapshot.skips = this.#skips;
		snapshot.skipped = this.#skipped;
		snapshot.discarded = this.#discarded;
		return snapshot;
	}

	get length(): number {
		return this.#writeIndex - this.#readIndex;
	}

	get capacity(): number {
		return this.#buffer[0]?.length;
	}

	resize(latency: Time.Milli): void {
		const latencySamples = Math.ceil(this.rate * Time.Second.fromMilli(latency));

		// A deeper floor parks playback until it refills. Video holds the extra delay on its own, so
		// audio that kept draining at the old depth would run ahead by the difference. Parking keeps
		// what is buffered, so a rise costs only its own size in silence, and none if the buffer
		// already covers the new floor.
		if (latencySamples > this.#latencySamples) this.#stalled = true;
		this.#latencySamples = latencySamples;

		if (this.#latencySamples === 0) throw new Error("empty buffer");

		this.#reallocate();

		// Resume a refill that the buffer already covers, which `write` would only notice on the
		// next frame, never for a source that has stopped.
		if (latencySamples > 0 && this.length >= latencySamples) this.#stalled = false;
	}

	// Move the ring into an array sized for what it now has to hold, keeping the newest samples that
	// fit. A no-op when the size did not change, which is every write of a well behaved stream.
	#reallocate(): void {
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
	}

	write(timestamp: Time.Micro, data: Float32Array[]): void {
		if (data.length !== this.channels) throw new Error("wrong number of channels");

		// A chunk wider than the target needs a wider ring, or the level this one holds plus the
		// stretch band would not fit in it and the hard capacity would start dropping audio the band
		// was meant to keep. Nothing to do for the streams whose frames are no longer than the delay
		// their catalog advertises, which is every one the catalog describes correctly.
		if (data[0].length > this.#largest) {
			this.#largest = data[0].length;
			this.#reallocate();
		}

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
			this.#floor.reset();
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

		// A hole ahead of the write cursor, handled before bounding: a hole holds no samples, so
		// bounding first would charge the part of it past capacity to `#discarded`.
		if (start > this.#writeIndex) {
			if (!this.#buffered && this.#readIndex >= this.#writeIndex) {
				// Nothing left to play, so the hole is media that was never sent and the reader is
				// already covering for it: queueing it as silence would make a listener wait for the
				// same missing audio a second time. Step the playhead over it instead.
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

		// Bound the ring. While playing, drop the oldest once it has held the stretch band more than
		// the target for a whole window and land back on the target. The band is exactly what the
		// reader's time stretch closes on its own, so everything inside it plays rather than being
		// thrown away. While stalled the reader is not consuming, so only the hard capacity applies;
		// the band would throw away the very audio the refill is accumulating. Buffered mode plays
		// through everything, so it is capacity-bound too.
		const playing = !this.#stalled && !this.#buffered;
		const band = playing ? Math.min(this.#latencySamples + this.#skip, this.capacity) : this.capacity;
		const depth = end - this.#readIndex;
		// A flush lands several frames at once, so the depth peaks by a whole flush and drains back
		// before the next one: the trough between two flushes is the part that is actually surplus.
		const sustained = playing ? this.#floor.observe(depth, this.#readIndex, this.#latencySamples) : depth;
		const surplus = playing && sustained > band;
		if (surplus || depth > this.capacity) {
			const to = end - (surplus ? Math.min(this.#latencySamples, this.capacity) : this.capacity);
			const dropped = Math.max(0, to - this.#readIndex);
			this.#discarded += dropped;
			this.#jumped += dropped;
			this.#readIndex = to;
		}

		// Write the actual samples: the last `samples` of each channel, read in place rather than
		// through a `subarray` view, because this runs on the audio thread.
		for (let channel = 0; channel < this.channels; channel++) {
			const src = data[channel];
			const from = src.length - samples;

			const dst = this.#buffer[channel];
			if (from < 0) throw new Error("mismatching number of samples");

			for (let i = 0; i < samples; i++) {
				const writePos = (start + i) % dst.length;
				dst[writePos] = src[from + i];
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
	}

	// Flush all buffered samples and re-stall, ready to anchor the next utterance.
	reset(): void {
		this.#readIndex = 0;
		this.#writeIndex = 0;
		this.#stalled = true;
		this.#anchored = false;
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
		const view = this.#view;
		view.buffered = this.#stalled ? 0 : buffered;
		view.target = this.#latencySamples;
		view.skip = this.#skip;
		view.stalled = this.#stalled;
		view.unstable = false;
		view.converge = !this.#buffered;
		// The writer bounds this ring on the way in, so the jump is on its side rather than here.
		view.skipped = this.#jumped;
		view.generation = this.#generation;
		return view;
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
	 * The reader ran dry mid-playback: count the underrun and park until the ring holds its level.
	 * Only once the caller has seen an empty {@link view}.
	 */
	starve(): void {
		this.#stalled = true;
		this.#underruns++;
	}

	/**
	 * Record what the reader's playout engine is holding, so the state message can carry it.
	 *
	 * Copied rather than kept, because the engine refills the same object every quantum.
	 */
	report(counters: Counters): void {
		const own = this.#counters;
		own.queued = counters.queued;
		own.stretched = counters.stretched;
		own.output = counters.output;
		own.concealed = counters.concealed;
		own.accelerates = counters.accelerates;
		own.expands = counters.expands;
		own.merges = counters.merges;
		own.short = counters.short;
	}

	/** Read samples into `output`, returning how many. See `SharedRingBuffer.read`. */
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

		this.#counters.output += samples;
		if (samples < output[0].length) {
			this.#underruns++;
			this.#counters.short++;
		}

		return samples;
	}
}

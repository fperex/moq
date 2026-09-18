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
	// Whether the publisher declared the timeline finished, so nothing more is coming. Cleared by
	// the next write. A stall says the ring is refilling and an empty ring says media is late; this
	// says neither is true, so the reader renders silence rather than concealing a gap nobody left.
	#ended = false;
	#underruns = 0;

	// Samples in the most recent write, i.e. one decoded chunk. The term on top of the target that
	// makes the level this ring holds: the target counts the frame in play, so the audio still
	// waiting to be played is the target plus one chunk. The most recent write rather than a running
	// maximum: one oversized decode would otherwise deepen the ring for the life of the stream, and a
	// publisher that changes its frame duration is described within one write.
	#chunk = 0;

	// Buffered mode: play through everything buffered without skipping ahead.
	readonly #buffered: boolean;
	// Un-stall threshold in samples (how much to buffer before playback starts).
	#latencySamples: number;
	// Whether the read/write indices have been anchored to the first inserted sample, and the sample
	// index that anchored them, which is where this timeline's playhead started.
	#anchored = false;
	#anchor = 0;

	// Bumped whenever the media timeline is replaced, so a reader holding a block from the previous
	// one knows to drop it. The shared transport reads its mutation epoch for the same purpose.
	#generation = 0;

	// How far above the hold level the ring may sit before the reader skips ahead. A property of the
	// reader's time stretch rather than of this stream: everything inside the band is something the
	// stretch closes without dropping a sample.
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
	// Samples dropped off the front of the first fill on a timeline, which no listener waited on.
	#trimmed = 0;
	// Whether nothing on this timeline has been played yet, so what is buffered is still free to
	// drop. Set by {@link reset} and cleared by the reader's first {@link commit}. See {@link #trim}.
	#fresh = true;
	// Samples the writer dropped out from under the reader since its last view, which the playout
	// engine has to treat as a step rather than as the buffer draining.
	#jumped = 0;

	// The widest chunk written so far, which capacity has to hold on top of the target. A high-water
	// mark rather than the current chunk, because growing the array replaces the timeline and the
	// reader drops the block it was holding: a publisher alternating two frame durations would
	// otherwise pay that on every other write. It only costs memory, since the band is measured
	// against the current chunk either way.
	#largest = 0;

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
		// floor exactly makes the ring physically incapable of holding the chunk on top of it or the
		// slack the overflow band wants, so every chunk arriving on target drops the oldest samples.
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
			trimmed: this.#trimmed,
			// `#fresh` stands until the reader commits a sample from this timeline, which is exactly
			// what "nothing has been played yet" means; an unanchored ring has no timeline at all.
			fresh: !this.#anchored || this.#fresh,
			anchor: this.#anchor,
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

		this.#reallocate();
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
		this.#generation++;
	}

	write(timestamp: Time.Micro, data: Float32Array[]): void {
		if (data.length !== this.channels) throw new Error("wrong number of channels");

		// Media is back, so the declared pause is over. A pause the reader played out leaves nothing
		// to resume: this is a fresh fill, so start it over rather than writing onto a timeline
		// whose playhead sits at the endpoint. The insert below then re-anchors, arms the trim and
		// refills to the target, exactly as at a cold start.
		if (this.#ended) {
			if (this.length <= 0) this.reset();
			this.#ended = false;
		}

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
			this.#anchor = start;
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

		// A hole in front of the write cursor is dealt with before the ring is bounded, because it
		// holds no samples: bounding first charges the part of the hole that overflows capacity to
		// `discarded`, and the step-over below then counts the whole hole again as skipped.
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

		// Bound the ring. While playing, drop the oldest once it holds the stretch band more than the
		// hold level and land back on the hold level. The band is exactly what the reader's time
		// stretch closes on its own, so everything inside it plays rather than being thrown away.
		// While stalled the reader is not consuming, so only the hard capacity applies; the band would
		// throw away the very audio the refill is accumulating. Buffered mode plays through
		// everything, so it is capacity-bound too.
		const playing = !this.#stalled && !this.#buffered;
		const hold = this.#latencySamples + this.#chunk;
		const band = playing ? Math.min(hold + this.#skip, this.capacity) : this.capacity;
		const depth = end - this.#readIndex;
		// A flush lands several frames at once, so the depth peaks by a whole flush and drains back
		// before the next one: the trough between two flushes is the part that is actually surplus.
		const sustained = playing ? this.#floor.observe(depth, this.#readIndex, this.#latencySamples) : depth;
		const surplus = playing && sustained > band;
		if (surplus || depth > this.capacity) {
			const to = end - (surplus ? Math.min(hold, this.capacity) : this.capacity);
			const dropped = Math.max(0, to - this.#readIndex);
			this.#discarded += dropped;
			this.#jumped += dropped;
			this.#readIndex = to;
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

		// Start playback once the ring holds the target and the chunk being played on top of it. The
		// target counts the frame in play, the way NetEq's does (the `packet_buffer` span plus the
		// sync buffer), so a ring holding the target alone holds nothing unplayed and runs dry on the
		// first arrival that is a millisecond late. This is the only way out of a stall, so an
		// underrun mid-playback refills to the same level before resuming. Bounded by what the ring
		// physically holds, or a chunk wider than the ring would name a level no refill could reach.
		const keep = Math.min(hold, this.capacity);
		this.#trim(keep);
		if (this.length >= keep) {
			this.#stalled = false;
		}
	}

	/**
	 * Start the playhead at the newest sample less `keep`, rather than at the oldest one.
	 *
	 * Until the reader has taken a sample nothing on this timeline has been heard, so audio above the
	 * level the ring holds is audio nobody is waiting on and dropping it is silent. Only once playback
	 * has started does a surplus have to be closed by the reader's time stretch, which is seconds of
	 * bent speech for the tens of milliseconds a resubscription admits past the hold: a fresh
	 * subscription is served the live edge and then whatever the relay still had inside the age
	 * budget, and all of it decodes before the first render quantum. NetEq reaches its target the same
	 * way, by where playout starts rather than by accelerating into it, and does not adjust the buffer
	 * at the start of a stream (`decision_logic.cc`, `delay_manager.cc`).
	 *
	 * The first fill only. A refill after an underrun resumes a timeline the listener is already
	 * following, and there a publisher's flush burst is audio that will have drained again by the next
	 * one, which is why the reader waits it out rather than dropping it.
	 *
	 * A whole chunk or more, because a fill lands a chunk at a time: a level that crossed the hold by
	 * part of one is the ring sitting where it is meant to sit, and a trim that landed it anywhere but
	 * on the hold would leave it on the very threshold the reader accelerates at. Buffered playback is
	 * asked to hold a lookahead, so it keeps everything.
	 */
	#trim(keep: number): void {
		if (!this.#fresh || this.#buffered) return;

		const excess = this.length - keep;
		if (excess < this.#chunk) return;

		this.#readIndex += excess;
		this.#trimmed += excess;
		this.#jumped += excess;
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
	 * Hold playback until the ring holds its level again, keeping everything buffered.
	 *
	 * Used when the target deepens: `resize` alone only raises the bar a future refill has to clear,
	 * so a ring already playing keeps draining at its old depth and audio runs that much ahead of
	 * video. Parking the playhead spends exactly the deficit as silence and resumes on the same
	 * timeline, where `reset` would throw the buffer away and re-anchor.
	 */
	stall(): void {
		this.#stalled = true;
	}

	/**
	 * The publisher declared the timeline finished here: play out what is buffered, then silence.
	 *
	 * The next write takes it back, so a publisher that pauses and resumes needs no second call.
	 */
	end(): void {
		this.#ended = true;
		// A stall waits for a refill, and there is no refill coming: releasing it is what lets the
		// tail play out instead of being held against a target nothing will ever reach. An empty
		// ring is released too, since `view` parks the reader on the endpoint itself and a stall
		// nothing can clear would outlive the pause.
		this.#stalled = false;
	}

	// Flush all buffered samples and re-stall, ready to anchor the next utterance.
	reset(): void {
		this.#readIndex = 0;
		this.#writeIndex = 0;
		this.#stalled = true;
		this.#ended = false;
		this.#anchored = false;
		this.#fresh = true;
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
			// A declared endpoint only reaches the output once everything written before it has
			// played; until then there is real audio to hand over.
			ended: this.#ended && buffered <= 0,
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
		// Something of this timeline has now been heard, so the rest stops being free to drop.
		if (count > 0) this.#fresh = false;
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
		if (view.stalled || view.ended) return 0;

		const samples = Math.min(view.buffered, output[0].length);
		if (samples <= 0) {
			// Ran dry mid-playback: re-stall so write() refills to the hold level before resuming.
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

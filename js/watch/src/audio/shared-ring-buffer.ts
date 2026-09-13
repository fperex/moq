import { Time } from "@moq/net";
import type { Playhead } from "./playhead";
import { type Counters, Floor, frames, type RingReader, type RingView, type Snapshot, STRETCH_BOUND } from "./playout";

// Control array slot indices. The playhead is not here: see `state`.
const WRITE = 0;
const LATENCY = 1;
/**
 * Whether playback is held while the ring refills. The one slot both threads write.
 *
 * The writer clears it once the ring holds the target, the reader raises it when the ring runs
 * dry. Neither needs a compare-exchange. The reader only raises it having observed an empty ring,
 * which means it already drained everything the writer published, and the writer only clears it
 * having published enough to cover the target. A raise landing after a clear costs one quantum of
 * silence and the next insert undoes it, since every insert re-checks. A clear landing after a
 * raise is correct on its face: the samples are there.
 */
const STALLED = 2;
// Timeline identity changes only on re-anchor, independently of the packed mutation epoch.
const TIMELINE = 3;
// The size of the most recent insert, i.e. one decoded chunk. See `read`.
const CHUNK = 4;
// How many times the reader ran dry mid-playback. Diagnostics only.
const UNDERRUN = 5;
/**
 * How far above `LATENCY + CHUNK` the ring may sit before the reader skips ahead, in samples.
 *
 * Written once by the writer, because it is a property of the reader's time stretch rather than of
 * this stream: everything inside the band is something the stretch closes without dropping a sample.
 */
const SKIP = 6;
// Media samples the reader has committed to its output block but not emitted yet. Reader only.
const QUEUED = 7;
// Samples an accelerate removed less the samples an expansion inserted, cumulative. Reader only.
const STRETCHED = 8;
// Frames the reader has emitted to the device, cumulative. Reader only.
const OUTPUT = 9;
// Blocks an accelerate shortened, blocks an expansion lengthened, quanta that ended short.
const ACCELERATES = 10;
const EXPANDS = 11;
const SHORT = 12;
// Skip-aheads, and the samples they threw away. Reader only.
const SKIPS = 13;
const SKIPPED = 14;
// Samples the writer dropped: too old for the playhead, or past the ring's capacity. Writer only.
const DISCARDED = 15;
// Frames of OUTPUT the reader synthesized to cover a gap, so they carried no media. Reader only.
const CONCEALED = 16;
// Times media returning after a concealment was spliced back on. Reader only.
const MERGES = 17;
const CONTROL_SLOTS = 18;

/**
 * The playhead and its mutation epoch, packed into one 64-bit word: epoch in the high
 * half, read cursor in the low half.
 *
 * They have to move together. The reader samples the ring, copies, and only then publishes, and
 * the writer can rebase the timeline anywhere in between. Checking an epoch and then writing a
 * cursor leaves a window between the two no ordering closes, which is how a stale cursor ends up
 * on a fresh timeline: the playhead lands past WRITE, `read` returns nothing, and `insert` drops
 * everything as too old until WRITE catches up. Packed, the check *is* the write: the reader
 * compare-exchanges the whole word, so a rebase makes its publish fail rather than land.
 */
const CURSOR_MASK = 0xffffffffn;

function pack(epoch: number, read: number): bigint {
	return (BigInt(epoch >>> 0) << 32n) | BigInt(read >>> 0);
}

/**
 * The mutation epoch. Even while settled, odd while `truncate` retreats WRITE.
 *
 * WRITE lives in a different word, so a retreat cannot move it and the epoch together. Marking
 * the epoch on either side of the retreat is what covers the gap: a reader that snapshotted
 * before the mark finds the word moved and its exchange fails, one that snapshots between the
 * marks sees the odd epoch and renders silence, and one that snapshots after already reads the
 * retreated WRITE. So the writer steps by two on a re-anchor, keeping odd for the retreat alone.
 */
function epochOf(state: bigint): number {
	return Number(state >> 32n) | 0;
}

/** Whether a `truncate` is mid-retreat, so WRITE may still describe samples it is dropping. */
function retreating(state: bigint): boolean {
	return (epochOf(state) & 1) !== 0;
}

/** The playhead half, back as an i32 so the modular comparisons elsewhere still hold. */
function readOf(state: bigint): number {
	return Number(state & CURSOR_MASK) | 0;
}

export interface SharedRingBufferInit {
	channels: number;
	capacity: number; // samples per channel, always a power of two
	rate: number;
	samples: SharedArrayBuffer; // channels * capacity * Float32Array.BYTES_PER_ELEMENT bytes
	control: SharedArrayBuffer; // CONTROL_SLOTS * Int32Array.BYTES_PER_ELEMENT bytes
	state: SharedArrayBuffer; // one BigInt64Array element: epoch and read cursor, packed
	// Buffered mode: never skip ahead on read, so we play through everything buffered.
	buffered: boolean;
}

/** Rounds up to a power of two, which is what makes `slot` wrap-invariant. */
function ceilPow2(n: number): number {
	return n <= 1 ? 1 : 1 << (32 - Math.clz32(n - 1));
}

/**
 * Allocate the shared memory for a ring holding at least `capacity` samples per channel.
 *
 * The capacity is rounded up to a power of two so `slot` can mask instead of taking a
 * remainder; read `init.capacity` back rather than assuming the requested value.
 */
export function allocSharedRingBuffer(
	channels: number,
	capacity: number,
	rate: number,
	buffered = false,
): SharedRingBufferInit {
	if (channels <= 0) throw new Error("invalid channels");
	if (capacity <= 0 || capacity > 2 ** 30) throw new Error("invalid capacity");
	if (rate <= 0) throw new Error("invalid sample rate");

	capacity = ceilPow2(capacity);

	const samples = new SharedArrayBuffer(channels * capacity * Float32Array.BYTES_PER_ELEMENT);
	const control = new SharedArrayBuffer(CONTROL_SLOTS * Int32Array.BYTES_PER_ELEMENT);
	const state = new SharedArrayBuffer(BigInt64Array.BYTES_PER_ELEMENT);

	// Initialize STALLED to 1
	const ctrl = new Int32Array(control);
	Atomics.store(ctrl, STALLED, 1);
	// The reader's time stretch closes this much without dropping a sample, so nothing inside it is
	// late audio. See STRETCH_BOUND.
	Atomics.store(ctrl, SKIP, frames(rate, STRETCH_BOUND));

	return { channels, capacity, rate, samples, control, state, buffered };
}

/** Modular i32 max: returns a if a is ahead of b, else b. */
function i32Max(a: number, b: number): number {
	return ((a - b) | 0) > 0 ? a : b;
}

/**
 * Maps a sample index to a [0, capacity) array slot.
 *
 * `capacity` is a power of two, so masking is exact for negative indexes and, unlike a
 * remainder, survives the i32 wrap: consecutive indexes stay consecutive slots across
 * 0x7fffffff -> 0x80000000, which is what keeps unread samples from aliasing there.
 */
function slot(idx: number, capacity: number): number {
	return idx & (capacity - 1);
}

export class SharedRingBuffer implements RingReader {
	readonly channels: number;
	readonly capacity: number;
	readonly rate: number;
	readonly buffered: boolean;
	readonly init: SharedRingBufferInit;

	#control: Int32Array;
	#state: BigInt64Array;
	#samples: Float32Array[];

	// Whether READ/WRITE have been anchored to the first inserted sample.
	#anchored = false;

	// What the last `view` sampled: the packed word its exchange has to match, and the cursor the
	// skip-ahead left it on. Reader thread only, since only the worklet reads.
	#snapshot = 0n;
	#cursor = 0;
	// Samples the skip-ahead in `view` passed over, counted once `commit` publishes it.
	#pending = 0;
	// The depth the ring keeps between flushes, which is the one that says a surplus is real.
	#floor = new Floor();

	// Where the last `commit` left the cursor, or undefined before the first one. Anything past it
	// is the writer having dropped the oldest samples out from under the reader, which the playout
	// engine has to treat as a step rather than as the buffer draining.
	#expected: number | undefined;

	// Absolute sample index of that first sample. READ/WRITE are stored relative to it, so
	// `timestamp` adds it back to recover media time. Main-thread only: the worklet reads by
	// difference and never needs an absolute position.
	#anchor = 0;

	// Unwrapped READ, in anchor-relative samples, plus the raw i32 it was last derived from.
	// READ is Int32 and wraps every ~13.5h at 44.1kHz. That is harmless for the modular
	// comparisons the ring runs on, but reading the negative half as a magnitude would report
	// the playhead jumping back 2^32 samples, so accumulate deltas here instead. Main-thread
	// only, and only accurate while `timestamp` is observed more often than READ can advance
	// 2^31 samples, which the 50ms poll in `buffer.ts` satisfies by six orders of magnitude.
	#position = 0;
	#lastRead = 0;

	// The media playhead last reported, and the counters the rate was last measured against. Main
	// thread only, and stateful for the same reason `#position` is.
	#lastMedia = Number.NEGATIVE_INFINITY;
	#lastOutput = 0;
	#lastStretched = 0;
	#lastConcealed = 0;

	/**
	 * Wrap the shared memory described by `init`.
	 *
	 * Pass `previous` in the worklet when this ring replaces one already being read. `resize`
	 * snapshots the playhead on the main thread and hands the replacement over by message, so the
	 * reader keeps draining the old ring in the meantime. Carrying its cursor across means those
	 * samples are not played twice.
	 */
	constructor(init: SharedRingBufferInit, previous?: SharedRingBuffer) {
		this.channels = init.channels;
		this.capacity = init.capacity;
		this.rate = init.rate;
		this.buffered = init.buffered;
		this.init = init;

		this.#control = new Int32Array(init.control);
		this.#state = new BigInt64Array(init.state);
		this.#samples = [];
		for (let i = 0; i < this.channels; i++) {
			this.#samples.push(
				new Float32Array(init.samples, i * this.capacity * Float32Array.BYTES_PER_ELEMENT, this.capacity),
			);
		}

		if (previous !== undefined) this.#handoff(previous);
	}

	/**
	 * Carry `source`'s playhead across, if the replacement is still the timeline it belongs to.
	 *
	 * Truncation changes the mutation epoch but preserves timeline identity. Sample state before
	 * identity: a re-anchor publishes identity first, then replaces state. Either the identity
	 * check rejects the old cursor, the exchange fails, or the re-anchor overwrites the carried
	 * cursor. A truncate only forces a retry, preserving audio consumed since the resize.
	 */
	#handoff(source: SharedRingBuffer): void {
		if (source.channels !== this.channels || source.rate !== this.rate) return;

		const timeline = Atomics.load(source.#control, TIMELINE);
		const from = Atomics.load(source.#state, 0);

		for (;;) {
			const state = Atomics.load(this.#state, 0);
			if (Atomics.load(this.#control, TIMELINE) !== timeline) return;
			if (((readOf(from) - readOf(state)) | 0) <= 0) return;

			const next = pack(epochOf(state), readOf(from));
			if (Atomics.compareExchange(this.#state, 0, state, next) === state) return;
		}
	}

	/**
	 * Move the playhead forward to `candidate`, staying on whatever timeline is current.
	 *
	 * Retries while the word changes under it, and never steps backwards. Used by the writer's
	 * overflow path; the reader publishes with its own exchange so it can tell a rebase apart
	 * from losing a race.
	 */
	#advance(candidate: number): void {
		for (;;) {
			const state = Atomics.load(this.#state, 0);
			if (((candidate - readOf(state)) | 0) <= 0) return;

			const next = pack(epochOf(state), candidate);
			if (Atomics.compareExchange(this.#state, 0, state, next) === state) return;
		}
	}

	/**
	 * Step the epoch by one, leaving the playhead wherever the reader has taken it.
	 *
	 * Retries while the word changes under it: only the epoch half is the writer's to move.
	 */
	#step(): void {
		for (;;) {
			const state = Atomics.load(this.#state, 0);
			const next = pack((epochOf(state) + 1) | 0, readOf(state));
			if (Atomics.compareExchange(this.#state, 0, state, next) === state) return;
		}
	}

	/**
	 * Insert audio samples at the given timestamp.
	 * Main thread only. Handles out-of-order writes, gap filling, and overflow.
	 */
	insert(timestamp: Time.Micro, data: Float32Array[]): void {
		if (data.length !== this.channels) throw new Error("wrong number of channels");

		let start = Math.round(Time.Second.fromMicro(timestamp) * this.rate);
		const originalLength = data[0].length;
		let offset = 0;

		// Anchor to the first sample so playback starts at its timestamp rather than gap-filling
		// from index 0.
		if (!this.#anchored) {
			this.#anchor = start;
			// One store rebases both halves, so a reader's compare-exchange against the old word
			// cannot land afterwards. Two, because odd epochs belong to `truncate`.
			const epoch = epochOf(Atomics.load(this.#state, 0));
			// Publish identity first so a handoff cannot apply an old cursor to the new state.
			Atomics.add(this.#control, TIMELINE, 1);
			Atomics.store(this.#state, 0, pack((epoch + 2) | 0, 0));
			Atomics.store(this.#control, WRITE, 0);
			this.#anchored = true;
			this.#position = 0;
			this.#lastRead = 0;
			this.#lastMedia = Number.NEGATIVE_INFINITY;
			Atomics.store(this.#control, QUEUED, 0);
		}

		// Positions are relative to the anchor. READ/WRITE are Int32, so an absolute sample index
		// wraps once a stream has been broadcasting a while, and the wrapped value reads as far
		// ahead of READ, so every insert would be discarded as too old and the ring would go
		// silent for good. Relative positions start at 0 instead. They still wrap, after ~13.5h at
		// 44.1kHz, but nothing here reads them as magnitudes: the comparisons are modular, `slot`
		// masks a power-of-two capacity, and `timestamp` keeps its own unwrapped position.
		start = (start - this.#anchor) | 0;

		const end = (start + originalLength) | 0;

		// Trim old: discard samples before the read index
		const read = readOf(Atomics.load(this.#state, 0));
		const behind = (read - start) | 0;
		if (behind > 0) {
			Atomics.add(this.#control, DISCARDED, Math.min(behind, originalLength) | 0);
			if (behind >= originalLength) {
				// All samples are too old
				return;
			}
			offset = behind;
			start = (start + behind) | 0;
		}

		const samples = originalLength - offset;

		// Overflow: if the write would exceed capacity from current READ, advance READ.
		// Use CAS so a concurrent reader advance isn't clobbered backward.
		if (((end - read) | 0) > this.capacity) {
			const to = (end - this.capacity) | 0;
			Atomics.add(this.#control, DISCARDED, (to - read) | 0);
			this.#advance(to);
		}

		// Gap fill: zero-fill from current WRITE to start if there's a discontinuity
		const write = Atomics.load(this.#control, WRITE);
		const gap = (start - write) | 0;
		if (gap > 0) {
			if (!this.buffered && ((readOf(Atomics.load(this.#state, 0)) - write) | 0) >= 0) {
				// Nothing left to play, so the hole is media that was never sent and the reader is
				// already covering for it: queueing it as silence would make a listener wait for the
				// same missing audio a second time. Step the playhead over it instead. Buffered
				// playback keeps the silence, because a producer writing ahead of the playhead means
				// the pause it wrote.
				Atomics.add(this.#control, SKIPS, 1);
				Atomics.add(this.#control, SKIPPED, gap);
				// The playhead moves first. The other order leaves a window where WRITE describes
				// the hole and READ does not, and a reader landing in it would play whatever those
				// slots still hold.
				this.#advance(start);
				Atomics.store(this.#control, WRITE, start);
			} else {
				// Fill the gap with zeros: there is audio behind it that still has to play in place.
				const gapSize = Math.min(gap, this.capacity);
				for (let channel = 0; channel < this.channels; channel++) {
					const dst = this.#samples[channel];
					for (let i = 0; i < gapSize; i++) {
						dst[slot((write + i) | 0, this.capacity)] = 0;
					}
				}
			}
		}

		// Write sample data
		for (let channel = 0; channel < this.channels; channel++) {
			const src = data[channel];
			const dst = this.#samples[channel];
			for (let i = 0; i < samples; i++) {
				dst[slot((start + i) | 0, this.capacity)] = src[offset + i];
			}
		}

		// Publish the chunk size for the reader's skip band before the samples it describes become
		// visible. The two stores are not one transaction, so the reader can land between them:
		// this way it sees the wider band with the old cursor, which only makes it skip less, where
		// the other order would have it measure a longer span against a narrower band and cut audio
		// that is not actually late. The most recent insert, not a running maximum: one oversized
		// decode would otherwise widen the band for the life of the ring, and a publisher that
		// changes its frame duration is described within one insert.
		Atomics.store(this.#control, CHUNK, originalLength);

		// Advance WRITE (only forward)
		Atomics.store(this.#control, WRITE, i32Max(Atomics.load(this.#control, WRITE), end));

		// Un-stall: if buffered data >= LATENCY
		const currentRead = readOf(Atomics.load(this.#state, 0));
		const currentWrite = Atomics.load(this.#control, WRITE);
		const latency = Atomics.load(this.#control, LATENCY);
		if (((currentWrite - currentRead) | 0) >= latency && latency > 0) {
			Atomics.store(this.#control, STALLED, 0);
		}
	}

	/**
	 * Sample the ring, applying the skip-ahead, and remember what was sampled.
	 * AudioWorklet only, and the first of the three calls a read is made of.
	 *
	 * The word is sampled before admission, not after. A re-anchor publishes the new state and only
	 * then clears WRITE, so a reader admitted in between would pair a fresh epoch with the previous
	 * timeline's WRITE and its exchange would succeed. Taken first, a reader admitted before the
	 * rebase still holds the old word and its exchange fails, while one arriving after sees the
	 * STALLED that `reset` raised and never starts.
	 */
	view(): RingView {
		const state = Atomics.load(this.#state, 0);
		this.#snapshot = state;

		const stalled = Atomics.load(this.#control, STALLED) === 1;
		// A retreat is in flight, so WRITE still describes samples `truncate` is dropping and a
		// later exchange could not tell them apart. Render the quantum as silence instead.
		const unstable = retreating(state);

		let read = readOf(state);
		const jumped = this.#expected === undefined ? 0 : Math.max(0, (read - this.#expected) | 0);
		const write = Atomics.load(this.#control, WRITE);
		const target = Atomics.load(this.#control, LATENCY);
		const chunk = Atomics.load(this.#control, CHUNK);
		const skip = Atomics.load(this.#control, SKIP);

		// Latency skip: skip ahead only once the ring holds a whole chunk plus the stretch band more
		// than the target, landing back on the target. Frames arrive one chunk at a time, so a ring
		// sitting exactly on the target is a chunk above it the moment the next one lands; skipping
		// on that overshoot discards audio on every single insert. The band on top is what the
		// reader's time stretch closes on its own, so everything inside it plays rather than being
		// thrown away.
		// The advance is published by `commit`, so a concurrent writer advance is never stepped back.
		// Disabled in buffered mode, where we deliberately play through the whole buffer.
		this.#pending = 0;
		if (!stalled && !unstable && !this.buffered && target > 0) {
			const sustained = this.#floor.observe((write - read) | 0, read, target);
			if (sustained > ((target + chunk + skip) | 0)) {
				const skipTo = (write - target) | 0;
				if (((skipTo - read) | 0) > 0) {
					this.#pending = (skipTo - read) | 0;
					read = skipTo;
				}
			}
		}

		this.#cursor = read;

		return {
			buffered: stalled || unstable ? 0 : (write - read) | 0,
			target,
			chunk,
			skip,
			stalled,
			unstable,
			converge: !this.buffered,
			skipped: jumped + this.#pending,
			generation: epochOf(state),
		};
	}

	/**
	 * Copy `count` buffered samples into `dst` at `offset`, without advancing the playhead.
	 * AudioWorklet only, after a {@link view}.
	 */
	peek(dst: Float32Array[], count: number, offset = 0): void {
		for (let channel = 0; channel < this.channels; channel++) {
			const src = this.#samples[channel];
			const out = dst[channel];
			for (let i = 0; i < count; i++) {
				out[offset + i] = src[slot((this.#cursor + i) | 0, this.capacity)];
			}
		}
	}

	/**
	 * Publish an advance of `count` samples past what {@link view} sampled.
	 * AudioWorklet only. Returns false when the writer moved the timeline in between.
	 *
	 * The exchange fails if anything moved the word since the snapshot, which covers both a rebase
	 * and a concurrent overflow, so samples are only ever counted as played on the timeline they
	 * came from. A skip-ahead with nothing to read still has to be published, which is why zero is
	 * a meaningful count.
	 */
	commit(count: number): boolean {
		const state = this.#snapshot;
		const next = (this.#cursor + count) | 0;
		if (((next - readOf(state)) | 0) !== 0) {
			if (Atomics.compareExchange(this.#state, 0, state, pack(epochOf(state), next)) !== state) return false;
		}
		if (this.#pending > 0) {
			Atomics.add(this.#control, SKIPS, 1);
			Atomics.add(this.#control, SKIPPED, this.#pending);
			this.#pending = 0;
		}
		this.#expected = next;
		return true;
	}

	/**
	 * Publish what the reader's playout engine is holding.
	 * AudioWorklet only, once per render quantum.
	 *
	 * Diagnostics, except for QUEUED: the media playhead the main thread reports is READ less that,
	 * so a stale value would put video ahead of the audio a listener can hear.
	 */
	report(counters: Counters): void {
		Atomics.store(this.#control, QUEUED, counters.queued | 0);
		Atomics.store(this.#control, STRETCHED, counters.stretched | 0);
		Atomics.store(this.#control, OUTPUT, counters.output | 0);
		Atomics.store(this.#control, CONCEALED, counters.concealed | 0);
		Atomics.store(this.#control, ACCELERATES, counters.accelerates | 0);
		Atomics.store(this.#control, EXPANDS, counters.expands | 0);
		Atomics.store(this.#control, MERGES, counters.merges | 0);
		Atomics.store(this.#control, SHORT, counters.short | 0);
	}

	/**
	 * The reader ran dry mid-playback: count the underrun and park until the ring holds the target.
	 * AudioWorklet only, and only once the caller has seen an empty {@link view}.
	 *
	 * A park is how `insert` gets to refill to the target before playback resumes: the alternative
	 * is playing the next chunk on an empty cushion, which underruns again on the very next
	 * quantum. See STALLED for the write discipline.
	 */
	starve(): void {
		Atomics.store(this.#control, STALLED, 1);
		Atomics.add(this.#control, UNDERRUN, 1);
	}

	/**
	 * Read audio samples into the output buffers.
	 * AudioWorklet only. Returns the number of samples read.
	 *
	 * {@link view}, {@link peek}, and {@link commit} in a row, which is what a reader that plays
	 * the media exactly as it arrives does.
	 */
	read(output: Float32Array[]): number {
		const view = this.view();
		if (view.stalled || view.unstable) return 0;

		const count = Math.min(view.buffered, output[0].length);
		if (view.buffered <= 0) this.starve();
		if (count <= 0) {
			// A latency skip still has to be published, and still only if nothing moved.
			this.commit(0);
			return 0;
		}

		this.peek(output, count);

		if (!this.commit(count)) {
			// The worklet takes the return value as an underflow count rather than clearing the
			// buffer it handed over, so silence the prefix or the discarded audio renders anyway.
			for (let channel = 0; channel < this.channels; channel++) output[channel].fill(0, 0, count);
			return 0;
		}

		// This reader holds nothing back and stretches nothing, so every sample it takes is a frame
		// it emits. Published so the playhead reads the same whichever reader drives the ring.
		Atomics.add(this.#control, OUTPUT, count);

		// A short quantum ends in silence, so it counts as an underrun even if a chunk lands before
		// the next read. It does not park playback: the shortfall is under one quantum, and a
		// refill would spend the whole target as silence to cover it.
		if (count < output[0].length) {
			Atomics.add(this.#control, UNDERRUN, 1);
			Atomics.add(this.#control, SHORT, 1);
		}

		return count;
	}

	/**
	 * Update the target latency in samples.
	 *
	 * Refuses a target the ring cannot physically hold rather than capping it. The overflow path
	 * advances READ before the buffer could ever reach such a target, so the ring would sit stalled
	 * for good instead of playing deeper, and nothing upstream would say why. The owner sizes
	 * capacity for the estimator's ceiling at construction, so reaching this is a bug.
	 */
	setLatency(samples: number): void {
		if (samples > this.capacity) {
			throw new Error(`audio ring: target of ${samples} samples exceeds its ${this.capacity} sample capacity`);
		}
		Atomics.store(this.#control, LATENCY, samples);
	}

	/**
	 * Drop buffered samples at or after `timestamp`, keeping whatever is already due.
	 * Main thread only.
	 *
	 * A successor track overwrites the slots its own samples land on, but anything the previous
	 * track wrote beyond them would otherwise still play once the successor runs out.
	 */
	truncate(timestamp: Time.Micro): void {
		const target = (Math.round(Time.Second.fromMicro(timestamp) * this.rate) - this.#anchor) | 0;
		if (((Atomics.load(this.#control, WRITE) - target) | 0) <= 0) return; // nothing past the new timeline

		// Bracket the retreat with epoch steps, so a reader is never left holding a WRITE this
		// dropped the tail of. See `epochOf`.
		this.#step();
		for (;;) {
			const write = Atomics.load(this.#control, WRITE);
			// Never retreat past the playhead: those samples are already due. The worklet can still
			// advance READ past the value read here, leaving READ ahead of WRITE. That reads as an
			// empty ring (read() returns nothing, insert() trims what the worklet already played) and
			// heals on the first successor sample past the playhead, so it costs a quantum of silence
			// rather than replaying anything.
			const clamped = i32Max(target, readOf(Atomics.load(this.#state, 0)));
			if (((write - clamped) | 0) <= 0) break;
			if (Atomics.compareExchange(this.#control, WRITE, write, clamped) === write) break;
		}
		this.#step();
	}

	/**
	 * Hold playback until the ring holds the target again, keeping everything buffered.
	 * Main thread only.
	 *
	 * Used when the target deepens: `setLatency` alone only raises the bar a future refill has to
	 * clear, so a ring already playing keeps draining at its old depth and audio runs that much
	 * ahead of video. Parking the playhead spends exactly the deficit as silence and resumes on the
	 * same timeline, where `reset` would throw the buffer away and re-anchor.
	 */
	stall(): void {
		Atomics.store(this.#control, STALLED, 1);
	}

	/**
	 * Flush buffered samples and re-stall, ready to anchor the next utterance (buffered mode).
	 * Main thread only. The worklet reader sees STALLED and stops until the next insert.
	 */
	reset(): void {
		this.#anchored = false;
		Atomics.store(this.#control, STALLED, 1);
		const write = Atomics.load(this.#control, WRITE);
		const state = Atomics.load(this.#state, 0);
		Atomics.store(this.#state, 0, pack(epochOf(state), write));
	}

	/**
	 * Allocate a new ring with `newCapacity` samples and copy the unread window
	 * [READ, WRITE) plus control state into it. Used when growing capacity so
	 * we don't drop buffered audio. If `newCapacity` is smaller than the unread
	 * span, the oldest samples are truncated.
	 *
	 * Main thread only. `resize()` reads from the source `SharedRingBuffer` and
	 * writes into a freshly allocated buffer from `allocSharedRingBuffer`, so it
	 * relies on the same invariant as `insert()`: no concurrent main-thread
	 * writers. The AudioWorklet reader is tolerated via the CAS discipline used
	 * by READ/WRITE elsewhere.
	 */
	resize(newCapacity: number): SharedRingBuffer {
		const init = allocSharedRingBuffer(this.channels, newCapacity, this.rate, this.buffered);
		const dst = new SharedRingBuffer(init);
		dst.#anchored = this.#anchored;
		dst.#anchor = this.#anchor;

		const state = Atomics.load(this.#state, 0);
		const read = readOf(state);
		const write = Atomics.load(this.#control, WRITE);
		const latency = Atomics.load(this.#control, LATENCY);
		const stalled = Atomics.load(this.#control, STALLED);

		const available = (write - read) | 0;
		const copyCount = Math.max(0, Math.min(available, dst.capacity));
		const copyStart = (write - copyCount) | 0;

		for (let channel = 0; channel < this.channels; channel++) {
			const src = this.#samples[channel];
			const out = dst.#samples[channel];
			for (let i = 0; i < copyCount; i++) {
				const idx = (copyStart + i) | 0;
				out[slot(idx, dst.capacity)] = src[slot(idx, this.capacity)];
			}
		}

		Atomics.store(dst.#control, TIMELINE, Atomics.load(this.#control, TIMELINE));
		Atomics.store(dst.#state, 0, pack(epochOf(state), copyStart));
		Atomics.store(dst.#control, WRITE, write);
		Atomics.store(dst.#control, LATENCY, latency);
		Atomics.store(dst.#control, STALLED, stalled);
		for (const control of [
			CHUNK,
			UNDERRUN,
			SKIP,
			QUEUED,
			STRETCHED,
			OUTPUT,
			CONCEALED,
			ACCELERATES,
			EXPANDS,
			MERGES,
			SHORT,
			SKIPS,
			SKIPPED,
			DISCARDED,
		]) {
			Atomics.store(dst.#control, control, Atomics.load(this.#control, control));
		}

		// Carry the unwrapped playhead over, rebased onto dst's READ. Fold the same `read`
		// snapshot the copy used so both sides agree on one observation; `copyStart` is at or
		// ahead of it whenever the copy dropped the oldest samples.
		dst.#position = this.#foldRead(read) + ((copyStart - read) | 0);
		dst.#lastRead = copyStart;
		dst.#lastMedia = this.#lastMedia;
		dst.#lastOutput = this.#lastOutput;
		dst.#lastStretched = this.#lastStretched;
		dst.#lastConcealed = this.#lastConcealed;

		return dst;
	}

	/**
	 * Fold an observed READ into `#position`, so the returned offset keeps counting up across
	 * the i32 wrap. Idempotent: folding the same value twice adds a zero delta.
	 */
	#foldRead(read: number): number {
		this.#position += (read - this.#lastRead) | 0;
		this.#lastRead = read;
		return this.#position;
	}

	/** `#foldRead` against the current READ. */
	#unwrapRead(): number {
		return this.#foldRead(readOf(Atomics.load(this.#state, 0)));
	}

	/**
	 * The media position the reader has played up to, in anchor-relative samples.
	 *
	 * READ less what the reader is still holding: a time stretch makes those two diverge, and it is
	 * the media position, not the output frame count, that video has to be paced against.
	 *
	 * READ and QUEUED live in separate words, so a poll can land between the reader's two stores and
	 * pair a fresh cursor with a stale queue. The error is bounded by one output block and only
	 * happens at a commit, but a playhead that stepped backwards would make video wait for audio
	 * that has already been heard, so this never reports less than it did last time.
	 */
	#media(): number {
		const queued = Atomics.load(this.#control, QUEUED);
		this.#lastMedia = Math.max(this.#lastMedia, this.#unwrapRead() - queued);
		return this.#lastMedia;
	}

	/**
	 * Current playback timestamp derived from the media playhead.
	 *
	 * Main thread only, and stateful: it advances the unwrapped read position, so it has to be
	 * polled rather than sampled once. See `#position`.
	 */
	get timestamp(): Time.Micro {
		return Time.Micro.fromSecond(((this.#anchor + this.#media()) / this.rate) as Time.Second);
	}

	/**
	 * Where the reader is on the media timeline and how fast it is moving, or undefined until the
	 * first insert anchors the ring.
	 *
	 * Main thread only, and stateful for the same reason {@link timestamp} is: the rate is measured
	 * between polls.
	 *
	 * The rate is the reader's own, `1 + (dSTRETCHED - dCONCEALED)/dOUTPUT`: it consumes a sample of
	 * media per output frame while playing normally, a few percent more or less while a time stretch
	 * converges on the target, and none at all while concealment covers a gap or while parked, so
	 * whoever follows this playhead waits with the audio rather than running away from it.
	 */
	get playhead(): Playhead | undefined {
		if (!this.#anchored) return undefined;

		const timestamp = this.timestamp;
		const output = Atomics.load(this.#control, OUTPUT);
		const stretched = Atomics.load(this.#control, STRETCHED);
		const concealed = Atomics.load(this.#control, CONCEALED);
		const elapsed = (output - this.#lastOutput) | 0;
		const moved = ((stretched - this.#lastStretched) | 0) - ((concealed - this.#lastConcealed) | 0);
		this.#lastOutput = output;
		this.#lastStretched = stretched;
		this.#lastConcealed = concealed;

		return { timestamp, rate: elapsed > 0 ? 1 + moved / elapsed : 0 };
	}

	/**
	 * Every control slot at once, for the quality harness and the stats panel.
	 * Main thread only.
	 *
	 * @internal
	 */
	debug(): Snapshot {
		const load = (index: number) => Atomics.load(this.#control, index);
		return {
			buffered: this.length,
			target: load(LATENCY),
			chunk: load(CHUNK),
			skip: load(SKIP),
			stalled: this.stalled,
			underruns: load(UNDERRUN),
			queued: load(QUEUED),
			stretched: load(STRETCHED),
			output: load(OUTPUT),
			concealed: load(CONCEALED),
			accelerates: load(ACCELERATES),
			expands: load(EXPANDS),
			merges: load(MERGES),
			short: load(SHORT),
			skips: load(SKIPS),
			skipped: load(SKIPPED),
			discarded: load(DISCARDED),
		};
	}

	/** Whether the buffer is stalled (waiting to fill). */
	get stalled(): boolean {
		return Atomics.load(this.#control, STALLED) === 1;
	}

	/** How many times the reader has run dry mid-playback. */
	get underruns(): number {
		return Atomics.load(this.#control, UNDERRUN);
	}

	/**
	 * Number of buffered samples (WRITE - READ).
	 *
	 * Non-atomic: WRITE and READ are loaded separately, so a concurrent
	 * writer/reader can make the two loads inconsistent. Intended for
	 * tests and diagnostics, not control-flow decisions.
	 */
	get length(): number {
		return (Atomics.load(this.#control, WRITE) - readOf(Atomics.load(this.#state, 0))) | 0;
	}
}

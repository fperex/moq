import type { Time } from "@moq/net";
import { BLOCK, Decision } from "./decision";
import { Expand } from "./expand";
import { Merge } from "./merge";
import { Noise } from "./noise";
import { frames, MAX_LAG, SEARCH, Stretch } from "./stretch";
import { Sync } from "./sync";

export * from "./decision";
export * from "./expand";
export * from "./level";
export * from "./merge";
export * from "./noise";
export * from "./stretch";
export * from "./sync";

/**
 * The DSP an audio ring needs when the network does not hand over exactly one block of audio per
 * block of playout.
 *
 * Shaped after WebRTC's NetEq (`modules/audio_coding/neteq` in Chromium) and mirroring the Rust
 * twin in `rs/moq-audio/src/playout/`, adapted to the AudioWorklet: the worklet's 128 frame render
 * quantum is NetEq's `GetAudio` pull, decoding stays on the main thread so the engine is PCM in and
 * PCM out, and the ring the main thread writes is the packet buffer.
 *
 * Nothing here imports `@moq/signals` or `@moq/hang`: it is bundled into the worklet blob.
 */

/** What the reader can see of the ring's state, the same on both transports. */
export interface RingView {
	/** Media samples available to read. */
	buffered: number;
	/** The playout target, in samples. */
	target: number;
	/**
	 * The most recent insert, in samples: one decoded chunk.
	 *
	 * The target counts the frame in play, so the level the ring holds is `target + chunk` and the
	 * skip band sits on top of that.
	 */
	chunk: number;
	/** How far above `target + chunk` the ring may sit before the reader skips ahead, in samples. */
	skip: number;
	/** Whether playback is parked while the ring refills. */
	stalled: boolean;
	/**
	 * Whether the publisher declared the timeline finished and everything it published has played.
	 *
	 * A stall is a refill and an empty ring is a gap, so both are covered with concealment. This is
	 * neither: the pause is on the wire, so there is nothing to conceal and nothing to wait for.
	 */
	ended: boolean;
	/** Whether the writer is mid-rebase, so nothing buffered can be trusted this quantum. */
	unstable: boolean;
	/**
	 * Whether the reader should converge on the target, or play through everything it was given.
	 *
	 * Buffered playback is asked to hold a lookahead, so bending the media to reach a target it is
	 * deliberately far above would throw away the very lookahead that was requested.
	 */
	converge: boolean;
	/** Media samples this view's skip-ahead passed over, which is a step in the playhead. */
	skipped: number;
	/** Changes whenever the media timeline was replaced: a truncate, a reset, or a re-anchor. */
	generation: number;
}

/**
 * The reader surface both rings expose, split so the engine can look before it commits.
 *
 * {@link view} samples the ring and applies the skip-ahead, {@link peek} copies without advancing,
 * and {@link commit} publishes the advance, failing if the writer moved the timeline in between.
 * The `read` both rings still have is these three in a row.
 */
export interface RingReader {
	readonly rate: number;
	readonly channels: number;

	/** Sample the ring. Must be called before {@link peek} or {@link commit}. */
	view(): RingView;

	/** Copy `count` buffered samples into `dst` at `offset`, without advancing the playhead. */
	peek(dst: Float32Array[], count: number, offset?: number): void;

	/** Advance the playhead by `count`, returning false when the timeline moved since {@link view}. */
	commit(count: number): boolean;

	/** The reader could not fill a block: count the underrun, and park if the ring is empty. */
	starve(): void;

	/** Publish what the playout engine is holding, for the main thread's diagnostics. */
	report(counters: Counters): void;
}

/** What the playout engine has done, cumulative, as published to the main thread. */
export interface Counters {
	/** Media samples committed to the output block but not emitted yet. */
	queued: number;
	/** Media samples an accelerate removed less the samples an expansion inserted, cumulative. */
	stretched: number;
	/** Frames emitted to the device, cumulative. */
	output: number;
	/** Frames of those that were synthesized to cover a gap, so they carried no media. */
	concealed: number;
	/** Blocks an accelerate shortened. */
	accelerates: number;
	/** Blocks an expansion lengthened. */
	expands: number;
	/** Times media returning after a concealment was spliced back on. */
	merges: number;
	/** Render quanta that ended short of a full block. */
	short: number;
}

/**
 * The whole control surface of one ring, as the main thread reads it for diagnostics.
 *
 * See `AudioBuffer.debug()`. Every field is a control slot on the shared transport and a field of
 * the worklet's state message on the postMessage one.
 */
export interface Snapshot extends Counters {
	/** Media samples the ring holds. */
	buffered: number;
	/** The playout target, in samples. */
	target: number;
	/** The most recent insert, in samples. */
	chunk: number;
	/** The skip-ahead band above the level the ring holds, in samples. */
	skip: number;
	/** Whether playback is parked while the ring refills. */
	stalled: boolean;
	/** Times the reader ran dry mid-playback. */
	underruns: number;
	/** Times the reader skipped ahead because the ring sat past the band. */
	skips: number;
	/** Samples those skips threw away. */
	skipped: number;
	/** Samples the writer dropped: too old for the playhead, or past the ring's capacity. */
	discarded: number;
	/**
	 * Samples the writer dropped off the first fill on a timeline, before anything had been played.
	 *
	 * Separate from {@link skipped} and {@link discarded} because it is the one drop no listener
	 * can hear and no time stretch had to close: the playhead simply started further in.
	 */
	trimmed: number;
	/**
	 * Whether nothing on the ring's current timeline has been played yet.
	 *
	 * A ring reports one stalled flag for filling and for stopping, and this is what tells them
	 * apart: a fresh ring is filling, whatever it holds, and only a ring that stops after it has
	 * played has interrupted anything.
	 */
	fresh: boolean;
	/** The sample index the ring's timeline is anchored at, i.e. where its playhead started. */
	anchor: number;
}

/**
 * A ring {@link Snapshot} plus what the decoder feeding it is doing.
 *
 * What `Decoder.out.debug` carries: the ring cannot see the budget its own supply is skipped
 * against, and reading the two apart would leave them describing different instants.
 *
 * @internal
 */
export interface Debug extends Snapshot {
	/** How stale a group may get before the container consumer skips it, in milliseconds. */
	budget: Time.Milli;
}

/**
 * The playout engine: one decision per output block, one time stretch when it asks for one, and
 * synthesized audio when the ring has nothing to give.
 *
 * Owned by the render worklet, which calls {@link render} once per render quantum. It reads the
 * ring through {@link RingReader}, so the isolated and postMessage transports run the same code.
 *
 * The media playhead is `READ - queued`, and every quantum holds
 * `READ == output - concealed + stretched + queued + skipped + trimmed`: what the ring handed over
 * is what was played, less the frames that were made up rather than read, plus what a stretch
 * moved, plus what is still in flight, plus what a skip threw away, plus what the writer trimmed
 * off the front before playback started.
 */
export class Stretcher {
	readonly rate: number;
	readonly channels: number;

	readonly #stretch: Stretch;
	readonly #expand: Expand;
	readonly #merge: Merge;
	readonly #noise: Noise;
	readonly #decision: Decision;
	readonly #sync: Sync;
	/** Whether a gap is concealed with synthesized audio rather than played as a ramp into silence. */
	readonly conceal: boolean;

	// Scratch: the block handed to an operation, the block it produced, the played audio a
	// concealment studies, and the concealment a merge is aligned against. Sized once, because this
	// runs on the audio thread.
	readonly #input: Float32Array[] = [];
	readonly #result: Float32Array[] = [];
	readonly #history: Float32Array[] = [];
	readonly #concealment: Float32Array[] = [];
	readonly #block: number;

	// Media samples committed to the output block, cumulative, and the value it held when the
	// block in flight was committed. What has actually been heard is prorated between them.
	#committed = 0;
	#base = 0;
	#blockConsumed = 0;
	#blockProduced = 0;
	#blockPlayed = 0;
	// Frames at the front of the block in flight that were synthesized rather than read.
	#blockConcealed = 0;

	#output = 0;
	#concealed = 0;
	#accelerates = 0;
	#expands = 0;
	#merges = 0;
	#short = 0;

	#generation: number | undefined;
	#stalled = true;
	// Whether the last block the engine tried to produce was refused because the publisher had
	// declared the timeline finished, so the quantum that came up short is a declared pause.
	#ended = false;

	/**
	 * An engine for planar `channels` channel PCM at `rate`.
	 *
	 * `conceal` off renders a gap as a ramp into silence instead of synthesizing audio over it, which
	 * is the boundary the time stretch was written to.
	 */
	constructor(rate: number, channels: number, conceal = true) {
		this.rate = rate;
		this.channels = Math.max(1, channels);
		this.conceal = conceal;
		this.#stretch = new Stretch(rate, this.channels);
		this.#expand = new Expand(rate, this.channels, BLOCK);
		this.#merge = new Merge(rate, this.channels);
		this.#noise = new Noise(this.channels);
		this.#decision = new Decision(rate);
		this.#block = frames(rate, BLOCK);

		// An expansion splices onto audio already played, so the output block keeps one splice
		// point plus one correlation window of history behind the cursor, and concealment needs the
		// window it studies the signal over on top of that.
		const history = Math.max(frames(rate, MAX_LAG + SEARCH), this.#expand.history);
		// A merge keeps up to one splice point of concealment ahead of the media it splices on.
		this.#sync = new Sync(this.channels, history, this.#block + this.#stretch.maxLag);

		// The widest block an operation reads: the history it borrows plus one block, or the 30ms
		// an accelerate needs, whichever is larger.
		const widest = Math.max(this.#block + this.#stretch.maxLag, this.#stretch.required);
		for (let i = 0; i < this.channels; i++) {
			this.#input.push(new Float32Array(widest));
			this.#result.push(new Float32Array(widest + this.#stretch.maxLag));
			this.#history.push(new Float32Array(history));
			this.#concealment.push(new Float32Array(this.#expand.block));
		}
	}

	/** The smoothed buffer level the decision runs on, in samples. Diagnostics and tests. */
	get level(): number {
		return this.#decision.level;
	}

	/** What the engine has done, for the ring to publish. */
	counters(): Counters {
		const emitted = this.#emitted();
		return {
			queued: this.#committed - emitted,
			// Concealed frames carried no media, so they are taken off the output before the two are
			// compared: what is left is the media a time stretch moved.
			stretched: emitted - (this.#output - this.#concealed),
			output: this.#output,
			concealed: this.#concealed,
			accelerates: this.#accelerates,
			expands: this.#expands,
			merges: this.#merges,
			short: this.#short,
		};
	}

	/**
	 * The media timeline was replaced: drop the block in flight and forget everything learned about
	 * the stream.
	 *
	 * The counters survive, because they describe the reader rather than the timeline.
	 */
	discontinuity(): void {
		this.#sync.flush();
		this.#noise.reset();
		this.#expand.reset();
		this.#rebase();
		this.#decision.discontinuity();
	}

	/**
	 * Fill one render quantum from `ring`, stretching the media if the buffer level asks for it.
	 *
	 * Returns the frames written, which is short of `out[0].length` when the ring ran dry or is
	 * parked; the caller ramps the tail and renders the rest as silence.
	 */
	render(ring: RingReader, out: Float32Array[], outputFrame: number): number {
		const quantum = out[0].length;
		let offset = 0;

		while (offset < quantum) {
			if (this.#sync.queued === 0 && !this.#produce(ring, outputFrame + offset)) break;

			const take = Math.min(quantum - offset, this.#sync.queued);
			if (take === 0) break;

			this.#sync.pull(out, offset, take);
			// The synthesized part of a block is its front, so what this pull heard of it is whatever
			// of the two runs overlap.
			const played = this.#blockPlayed;
			this.#concealed += Math.max(0, Math.min(played + take, this.#blockConcealed) - played);
			this.#blockPlayed += take;
			this.#output += take;
			offset += take;
		}

		// The ring ran dry or is parked with concealment turned off, so the caller ramps what it got
		// down to the silence that follows. A declared endpoint is not that: the silence is the
		// audio, so it is not counted against the reader.
		if (offset < quantum && !this.#ended) this.#short++;

		ring.report(this.counters());
		return offset;
	}

	/** Media samples the engine has walked through, prorated inside the block in flight. */
	#emitted(): number {
		if (this.#blockProduced === 0) return this.#base;
		return this.#base + Math.round((this.#blockConsumed * this.#blockPlayed) / this.#blockProduced);
	}

	/** Start counting a fresh timeline from wherever the ring now is. */
	#rebase(): void {
		this.#base = this.#committed;
		this.#blockConsumed = 0;
		this.#blockProduced = 0;
		this.#blockPlayed = 0;
		this.#blockConcealed = 0;
		this.#decision.reseed();
	}

	/** Decide and commit one block of media. Returns whether anything was queued. */
	#produce(ring: RingReader, outputFrame: number): boolean {
		const view = ring.view();

		if (view.generation !== this.#generation) {
			// A truncate, a reset, or the first insert anchoring the ring: the queued block belongs
			// to a timeline that is gone.
			if (this.#generation !== undefined) this.discontinuity();
			this.#generation = view.generation;
		}

		this.#ended = view.ended;
		if (view.ended) {
			// The publisher declared the timeline finished and the ring has played everything it
			// published. There is no gap to cover, so concealment would be inventing audio nobody
			// sent: park and render silence until frames return.
			this.#park();
			// And drop the played history with it. What the ring resumes with belongs to the far
			// side of a declared pause, so splicing it onto the last thing heard before the pause,
			// or concealing with it while the ring refills, would be inventing a join that is not
			// there.
			this.#sync.flush();
			this.#expand.reset();
			return false;
		}

		if (view.stalled || view.unstable) {
			// A park is not an underrun: the writer is refilling and the reader waits with it. Drop
			// the block in flight so playback resumes from where the refill lands.
			this.#park();
		} else {
			if (this.#stalled) {
				// Resumed on the same timeline, at whatever depth the refill reached: the level did
				// not drift there, so adopt it rather than filtering towards it.
				this.#stalled = false;
				this.#rebase();
			}

			if (view.skipped > 0) {
				// The reader just jumped the playhead, which is a delay adjustment rather than a
				// drift: the filter never walked to where the buffer now is, so adopt it. NetEq
				// reinitialises its own filter on the same reasoning (`decision_logic.cc`).
				this.#decision.reseed();
			}

			if (view.buffered <= 0) {
				// Ran dry mid-playback. The ring re-stalls so the writer refills to the target before
				// playback resumes, rather than underrunning again on the very next quantum.
				ring.starve();
				this.#park();
			}
		}

		// Concealment repeats the tail of what was played, so it needs one: a ring that has not
		// started yet has nothing to repeat and renders the ramp instead, however the option is set.
		if (this.#stalled) this.#prepare();

		const operation = this.#decision.decide({
			buffered: this.#stalled ? 0 : view.buffered,
			// Always zero here: a block is drained before the next is produced. Passed anyway
			// because the level is defined on what the engine holds, not on the ring alone.
			queued: this.#committed - this.#emitted(),
			target: view.target,
			chunk: view.chunk,
			outputFrame,
			starved: this.#stalled,
			conceal: this.conceal && this.#expand.ready,
			converge: view.converge,
		});

		// Nothing to play and concealment is off, so the caller ramps into silence.
		if (operation === "silence") return false;
		if (operation === "conceal") return this.#hide();
		if (operation === "merge") return this.#splice(ring, view, outputFrame);

		if (operation === "accelerate" || operation === "fast-accelerate") {
			const want = Math.min(view.buffered, Math.max(this.#block, this.#stretch.required));
			if (want >= this.#stretch.required) {
				ring.peek(this.#input, want);
				const removed = this.#stretch.accelerate(
					this.#input,
					want,
					this.#noise,
					operation === "fast-accelerate",
					this.#result,
				);
				if (removed > 0) {
					if (!this.#commit(ring, want, want - removed, removed, outputFrame)) return false;
					this.#accelerates++;
					return true;
				}
			}
		} else if (operation === "expand") {
			const peeked = Math.min(view.buffered, this.#block);
			// An expansion splices onto what has already been heard, so borrow up to one splice
			// point of it: past that NetEq refuses the operation outright.
			const old = this.#sync.borrow(this.#input, this.#stretch.maxLag);
			ring.peek(this.#input, peeked, old);
			const inserted = this.#stretch.preemptiveExpand(this.#input, old + peeked, old, this.#noise, this.#result);
			if (inserted > 0) {
				// The borrowed prefix has already been played; only what follows it is new.
				this.#drop(old);
				if (!this.#commit(ring, peeked, peeked + inserted, -inserted, outputFrame)) return false;
				this.#expands++;
				return true;
			}
		}

		// Normal: play the media as it stands, and let the background estimate learn from it.
		const want = Math.min(view.buffered, this.#block);
		ring.peek(this.#input, want);
		this.#noise.update(this.#input, want);
		return this.#commit(ring, want, want, 0, outputFrame, this.#input);
	}

	/** Hold playback, dropping the block in flight so it resumes from wherever the refill lands. */
	#park(): void {
		if (this.#stalled) return;
		this.#sync.truncate();
		this.#rebase();
		this.#stalled = true;
	}

	/**
	 * Let concealment study the tail of the real signal, once per run and once there is a tail.
	 *
	 * A run that starts before that much has been played (a stream that never began, or one that just
	 * re-anchored) plays comfort noise instead, which is silence until the background estimate has
	 * heard a quiet window.
	 */
	#prepare(): void {
		if (this.#expand.started || this.#sync.played < this.#expand.history) return;

		const took = this.#sync.borrow(this.#history, this.#expand.history);
		this.#expand.analyse(this.#history, took);
	}

	/** Nothing to play: make one block up. */
	#hide(): boolean {
		this.#expand.process(this.#result, 0);
		this.#queue(this.#result, this.#expand.block, this.#expand.block);
		return true;
	}

	/** Media is back: splice it onto the concealment that covered for it. */
	#splice(ring: RingReader, view: RingView, outputFrame: number): boolean {
		const want = Math.min(view.buffered, this.#block);
		ring.peek(this.#input, want);
		this.#noise.update(this.#input, want);

		// One more block of concealment for the returning media to be aligned and crossfaded
		// against, which is what makes the splice inaudible.
		this.#expand.process(this.#concealment, 0);
		const kept = this.#merge.merge(this.#concealment, this.#expand.block, this.#input, want, this.#result);

		// The kept concealment lengthens the block without consuming media, exactly as a preemptive
		// expansion does, so the level filter is told the same thing.
		if (!this.#commit(ring, want, kept + want, -kept, outputFrame, this.#result, kept)) return false;

		this.#merges++;
		this.#expand.reset();
		return true;
	}

	/** Queue a block that consumed no media, because the ring had none to give. */
	#queue(from: Float32Array[], produced: number, concealed: number): void {
		this.#base = this.#committed;
		this.#blockConsumed = 0;
		this.#blockProduced = produced;
		this.#blockPlayed = 0;
		this.#blockConcealed = concealed;
		this.#sync.push(from, 0, produced);
	}

	/** Drop the first `count` frames of the operation's result, which the caller had already played. */
	#drop(count: number): void {
		if (count === 0) return;
		for (const plane of this.#result) plane.copyWithin(0, count);
	}

	/** Publish the advance, then queue what the block produced. Returns false if the timeline moved. */
	#commit(
		ring: RingReader,
		consumed: number,
		produced: number,
		shift: number,
		outputFrame: number,
		from: Float32Array[] = this.#result,
		concealed = 0,
	): boolean {
		if (!ring.commit(consumed)) {
			// The writer rebased between the peek and here, so this block describes audio that is
			// no longer due. Nothing was queued, so nothing has to be unpicked.
			this.discontinuity();
			return false;
		}

		this.#base = this.#committed;
		this.#committed += consumed;
		this.#blockConsumed = consumed;
		this.#blockProduced = produced;
		this.#blockPlayed = 0;
		this.#blockConcealed = concealed;
		this.#sync.push(from, 0, produced);

		if (shift !== 0) this.#decision.applied(shift, outputFrame);
		return true;
	}
}

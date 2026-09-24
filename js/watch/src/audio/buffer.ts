import * as Container from "@moq/hang/container";
import { Time } from "@moq/net";
import { Effect, type Getter, Signal } from "@moq/signals";
import type { Clock } from "../sync";
import type { Playhead } from "./playhead";
import type { Snapshot } from "./playout";
import type { Data, End, InitPost, InitShared, Latency, Reset, Stall, State, Truncate } from "./render";
import { allocSharedRingBuffer, SharedRingBuffer } from "./shared-ring-buffer";

/**
 * How long a parked playhead may go without media arriving and still be the clock.
 *
 * A park is a refill, and a refill has frames landing in it: playback pauses with it so video does
 * not run away from the audio a listener can hear, however deep the target is. A playhead that has
 * neither moved nor been written to for this long is not refilling (a muted track that drained, a
 * download that stopped, a track that ended with its ring still alive), and holding video against
 * it would freeze the picture, so the ring gives up the clock and `Sync` carries on at wall speed
 * from where the playhead stopped.
 */
const PARK_LIMIT = Time.Milli(1000);

/**
 * Turns ring playhead samples into the clock `Sync` follows.
 *
 * Stamps each sample with the time it was taken, which is what `Sync` extrapolates from, and gives
 * up the clock once a park stops looking like a refill. See {@link PARK_LIMIT}.
 */
export class ClockSource {
	// When the playhead stopped, with nothing written since. Undefined while it is moving or being
	// fed, which is the whole of normal playback.
	#parked: Time.Milli | undefined;
	// Whether the publisher declared the timeline finished, so the park is not a refill and waiting
	// out PARK_LIMIT would only freeze the picture for a second first.
	#ended = false;

	/** Note that media reached the ring, so a park is a refill rather than an abandoned playhead. */
	filling(): void {
		this.#parked = undefined;
		this.#ended = false;
	}

	/** Note that the publisher declared the timeline finished, so nothing is coming to fill it. */
	ended(): void {
		this.#ended = true;
	}

	/** Stamp `playhead`, or return undefined when it should not be driving playback. */
	sample(playhead: Playhead | undefined, reference = Time.Milli.now()): Clock | undefined {
		const now = Time.Milli.now();

		if (!playhead) {
			this.#parked = undefined;
			return undefined;
		}

		if (playhead.rate !== 0) {
			this.#parked = undefined;
		} else {
			if (this.#ended) return undefined;
			this.#parked ??= now;
			if (Time.Milli.sub(now, this.#parked) > PARK_LIMIT) return undefined;
		}

		return { timestamp: playhead.timestamp, reference, rate: playhead.rate };
	}
}

/**
 * Samples the shared ring is sized for up front, so an "auto" target rising to the estimator's
 * ceiling never reallocates.
 *
 * A resize hands the worklet a replacement ring by message and the reader keeps draining the old
 * one until it lands, so it is the one operation worth paying memory to avoid: 2s at 48kHz stereo
 * is under a megabyte after the power-of-two round.
 */
function ceilingSamples(rate: number): number {
	return Math.ceil(rate * Time.Second.fromMilli(Time.Milli(Container.Jitter.CEILING)));
}

/**
 * Timestamp-based backpressure for buffered playback. The decoded PCM ring only holds the latency
 * floor; everything above it (the buffered lookahead, up to the ceiling) stays upstream as encoded
 * Opus. `wait(timestamp)` stays pending until the playhead is within `headroom` (the floor) of
 * `timestamp`, so the decode loop holds a frame as Opus instead of decoding it too far ahead of the
 * floor-sized ring. Both transports share this; they differ only in how they observe the playhead
 * (Atomics poll vs worklet state messages). A no-op when not buffered (the ring bounds itself).
 */
class Backpressure {
	readonly #enabled: boolean;
	#headroom: Time.Micro;
	#waiters: Array<{ timestamp: Time.Micro; resolve: () => void }> = [];

	constructor(enabled: boolean, headroom: Time.Micro) {
		this.#enabled = enabled;
		this.#headroom = headroom;
	}

	// Move the gate as the floor changes (e.g. "auto" tracking the measured arrival spread).
	setHeadroom(headroom: Time.Micro): void {
		this.#headroom = headroom;
	}

	wait(timestamp: Time.Micro, playhead: Time.Micro): Promise<void> {
		if (!this.#enabled) return Promise.resolve();
		if (playhead >= ((timestamp - this.#headroom) | 0)) return Promise.resolve();
		return new Promise((resolve) => this.#waiters.push({ timestamp, resolve }));
	}

	// Resolve every waiter the playhead has reached. Thresholds are recomputed live so a changed
	// headroom takes effect on queued waiters too.
	advance(playhead: Time.Micro): void {
		if (this.#waiters.length === 0) return;
		this.#waiters = this.#waiters.filter(({ timestamp, resolve }) => {
			if (playhead < ((timestamp - this.#headroom) | 0)) return true;
			resolve();
			return false;
		});
	}

	// Resolve everything unconditionally (reset/close): never strand a decode loop.
	flush(): void {
		for (const { resolve } of this.#waiters) resolve();
		this.#waiters = [];
	}
}

/** Convert a sample count to a Time.Micro duration at the given sample rate. */
function samplesToMicro(samples: number, rate: number): Time.Micro {
	return Time.Micro.fromSecond((samples / rate) as Time.Second);
}

/**
 * Unified interface for the audio buffer between the thread that decodes (the page, or a dedicated
 * worker) and the AudioWorklet.
 *
 * Two implementations exist:
 *   - `SharedAudioBuffer`: backed by SharedArrayBuffer, lock-free writes via Atomics.
 *   - `PostAudioBuffer`: backed by postMessage transfer (the fallback when SAB is unavailable).
 *
 * Use `createAudioBuffer()` to pick the right implementation automatically.
 */
export interface AudioBuffer {
	readonly rate: number;
	readonly channels: number;

	/** Insert audio samples at the given timestamp. Handles out-of-order writes. */
	insert(timestamp: Time.Micro, data: Float32Array[]): void;

	/** Update the target latency in samples. */
	setLatency(samples: number): void;

	/** Flush buffered samples and re-stall, ready to anchor the next utterance (buffered mode). */
	reset(): void;

	/**
	 * Hold playback until the ring holds the target again, keeping everything buffered.
	 *
	 * Used when the target deepens: `setLatency` alone only raises the bar a future refill has to
	 * clear, so a ring already playing keeps draining at its old depth.
	 */
	stall(): void;

	/**
	 * The publisher declared the timeline finished: play out what is buffered, then silence.
	 *
	 * A publisher that stops sending leaves a gap the reader conceals, because nothing on the wire
	 * says whether the audio is late or over. An endpoint does say so, and this is how it reaches
	 * the reader: no concealment, no underrun, and the clock hands over to wall time rather than
	 * holding video against a playhead that will not move. The next `insert` takes it back.
	 */
	end(): void;

	/**
	 * Drop buffered samples at or after `timestamp`, keeping what is already due.
	 *
	 * Used when a new track takes over the timeline: its samples overwrite the slots they land on,
	 * but the previous track's write-ahead tail would otherwise play once the new audio runs out.
	 * Unlike `reset()` this keeps playing, so there's no gap at the handover.
	 */
	truncate(timestamp: Time.Micro): void;

	/**
	 * Resolve once the playhead is near enough to decode a frame at `timestamp`. In buffered mode this
	 * applies backpressure: it stays pending while decoding `timestamp` would run more than the latency
	 * floor ahead of the playhead, so the caller holds the (encoded) frame instead of decoding it too
	 * far ahead of the floor-sized ring. Resolves immediately when not buffered (the ring bounds itself).
	 */
	wait(timestamp: Time.Micro): Promise<void>;

	/**
	 * Where the reader has played up to, or undefined while the ring has no playhead.
	 *
	 * The playhead's own timestamp, so it is undefined for exactly as long as {@link clock} is: before
	 * the first insert anchors the ring, and from a flush until the next insert re-anchors it. Holding
	 * the position the flush threw away would report a playhead the reader is never going to resume
	 * from, which reads as the whole flushed interval's worth of A/V skew.
	 */
	readonly timestamp: Getter<Time.Micro | undefined>;

	/**
	 * The playhead as a clock for `Sync`, or undefined while it is not one.
	 *
	 * Republished as the reader moves, so `Sync` re-anchors rather than drifting; it extrapolates
	 * between samples, so video paces against main-thread memory instead of the ring itself.
	 */
	readonly clock: Getter<Clock | undefined>;

	/** Whether the buffer is stalled (waiting to fill). */
	readonly stalled: Getter<boolean>;

	/** How many times the ring has run dry mid-playback, cumulative. */
	readonly underruns: Getter<number>;

	/**
	 * Every control slot at once: what the ring holds, what the playout engine did with it, and what
	 * either end threw away. Undefined until the first sample lands.
	 *
	 * @internal
	 */
	readonly debug: Getter<Snapshot | undefined>;

	/** Release any resources (event listeners, intervals, etc.). */
	close(): void;
}

/** Returns true when SharedArrayBuffer is available and usable in the current context. */
export function supportsSharedArrayBuffer(): boolean {
	if (typeof SharedArrayBuffer === "undefined") return false;
	// In browsers, SharedArrayBuffer requires cross-origin isolation (COOP/COEP).
	// crossOriginIsolated is a browser global; in Node/Bun it's undefined.
	if (typeof crossOriginIsolated !== "undefined" && !crossOriginIsolated) return false;
	return true;
}

/** How the ring behind the worklet is built. */
export interface AudioBufferProps {
	/** Maps render time to the audio device's output clock. */
	context: Pick<AudioContext, "getOutputTimestamp">;
	/** Channels of planar PCM the graph runs at. */
	channels: number;
	/** Samples per second per channel. */
	rate: number;
	/** The initial playout target, in samples. */
	latency: number;
	/** Buffered mode: play through the whole lookahead instead of converging on the target. */
	buffered: boolean;
	/** Whether the reader conceals a gap with synthesized audio or plays it as a ramp into silence. */
	conceal: boolean;
}

/**
 * Where a ring's writes go: the render worklet's node, or any port the worklet takes ring writes from
 * (see `Port` in `render.ts`), which is how a writer off the main thread reaches it.
 */
export type RingTarget = Pick<AudioWorkletNode, "port">;

/**
 * Create the best audio buffer implementation for the current environment.
 * Picks `SharedAudioBuffer` when possible, falling back to `PostAudioBuffer`.
 */
export function createAudioBuffer(worklet: RingTarget, props: AudioBufferProps): AudioBuffer {
	const shared = supportsSharedArrayBuffer();
	reportTransport(shared);
	return shared ? new SharedAudioBuffer(worklet, props) : new PostAudioBuffer(worklet, props);
}

// Whether the transport has been named already, since it is the same answer for the rest of the
// document's life.
let reported = false;

/**
 * Say which transport this document got, once.
 *
 * Cross-origin isolation is a property of the page, so every player on it lands on the same
 * transport and each one saying so is the same line repeated. Neither answer is a fault: a page
 * that is not isolated cannot have shared memory and the postMessage ring is what it runs on, so
 * this is a note about the page rather than a warning about the player.
 */
function reportTransport(shared: boolean): void {
	if (reported) return;
	reported = true;

	if (shared) {
		console.info("[audio] using the SharedArrayBuffer audio buffer");
		return;
	}

	console.info(
		"[audio] using the postMessage audio buffer, which holds a little more latency. " +
			"Serve the page cross-origin isolated (Cross-Origin-Opener-Policy: same-origin, Cross-Origin-Embedder-Policy: require-corp) for the SharedArrayBuffer one.",
	);
}

/** SharedArrayBuffer-backed implementation. Writes go directly into shared memory. */
class SharedAudioBuffer implements AudioBuffer {
	readonly rate: number;
	readonly channels: number;
	#worklet: RingTarget;
	#ring: SharedRingBuffer;

	readonly #timestamp = new Signal<Time.Micro | undefined>(undefined);
	readonly timestamp: Getter<Time.Micro | undefined> = this.#timestamp;

	readonly #stalled = new Signal<boolean>(true);
	readonly stalled: Getter<boolean> = this.#stalled;

	readonly #underruns = new Signal<number>(0);
	readonly underruns: Getter<number> = this.#underruns;

	readonly #debug = new Signal<Snapshot | undefined>(undefined);
	readonly debug: Getter<Snapshot | undefined> = this.#debug;

	readonly #clock = new Signal<Clock | undefined>(undefined);
	readonly clock: Getter<Clock | undefined> = this.#clock;
	readonly #clockSource = new ClockSource();

	#backpressure: Backpressure;
	// Carried so a resize hands the replacement ring the same answer.
	readonly #conceal: boolean;

	#signals = new Effect();

	constructor(worklet: RingTarget, props: AudioBufferProps) {
		const { channels, rate, latency, buffered } = props;
		this.#worklet = worklet;
		this.channels = channels;
		this.rate = rate;
		this.#conceal = props.conceal;

		// The ring holds the latency floor as decoded PCM (headroom above it for overflow). In
		// buffered mode the lookahead above the floor stays encoded upstream, held back by `wait()`.
		// Sized for the estimator's ceiling from the start: an "auto" target climbing past the
		// initial delay would otherwise hit the overflow path's `capacity` bound and be silently
		// capped there, which is the one place a deeper target does not deepen the buffer.
		const capacity = Math.max(rate, ceilingSamples(rate), latency * 2);
		this.#backpressure = new Backpressure(buffered, samplesToMicro(latency, rate));

		const init = allocSharedRingBuffer(channels, capacity, rate, buffered);
		this.#ring = new SharedRingBuffer(init);
		this.#ring.setLatency(latency);

		const msg: InitShared = { type: "init-shared", ...init, conceal: this.#conceal };
		worklet.port.postMessage(msg);

		// Poll the shared control array and reflect it into signals. Also the clock's cadence: video
		// re-anchors to the audio playhead once per poll and extrapolates in between, so a per-frame
		// wait costs no shared-memory read at all.
		this.#signals.interval(() => {
			const stalled = this.#ring.stalled;
			// One read: the getter is stateful (it measures the reader's rate between polls) and it
			// is the only thing that knows whether the ring is anchored, so the timestamp published
			// here is its timestamp rather than a second, unguarded read of the same position.
			const playhead = this.#ring.playhead;
			this.#timestamp.set(playhead?.timestamp);
			this.#stalled.set(stalled);
			this.#underruns.set(this.#ring.underruns);
			this.#debug.set(this.#ring.debug());
			this.#clock.set(this.#clockSource.sample(playhead));
			// While stalled the playhead is parked, so release the decode loop to refill the floor;
			// once playing, hold it to ~the floor ahead.
			if (stalled || !playhead) this.#backpressure.flush();
			else this.#backpressure.advance(playhead.timestamp);
		}, 50);
	}

	insert(timestamp: Time.Micro, data: Float32Array[]): void {
		this.#clockSource.filling();
		this.#ring.insert(timestamp, data);
	}

	setLatency(samples: number): void {
		this.#backpressure.setHeadroom(samplesToMicro(samples, this.rate));

		// Grow the ring (preserving the unread window) if it's too small for the new latency. Only a
		// fixed or buffered delay past the estimator's ceiling gets here; "auto" is sized for at
		// construction.
		if (this.#ring.capacity < samples * 1.5) {
			const newCapacity = Math.max(this.rate, ceilingSamples(this.rate), samples * 2);
			this.#ring = this.#ring.resize(newCapacity);
			this.#ring.setLatency(samples);

			const msg: InitShared = { type: "init-shared", ...this.#ring.init, conceal: this.#conceal };
			this.#worklet.port.postMessage(msg);
		} else {
			this.#ring.setLatency(samples);
		}
	}

	truncate(timestamp: Time.Micro): void {
		this.#ring.truncate(timestamp);
	}

	reset(): void {
		this.#ring.reset();
		// A flushed ring has no playhead until the next insert anchors it. Publishing the one it had
		// would leave `Sync` extrapolating from a position the reader is never going to resume from,
		// and leave every consumer of the timestamp a flush's worth of media behind.
		this.#timestamp.set(undefined);
		this.#clock.set(undefined);
		this.#backpressure.flush(); // the old timeline is gone; let the decode loop re-anchor
	}

	stall(): void {
		this.#ring.stall();
		this.#backpressure.flush(); // let the decode loop fill the deeper target
	}

	end(): void {
		this.#ring.end();
		this.#clockSource.ended();
		this.#backpressure.flush(); // nothing is coming, so nothing should be waiting on the playhead
	}

	wait(timestamp: Time.Micro): Promise<void> {
		// Stalled = still filling the floor (bootstrap, an underrun the reader re-stalled on, or an
		// explicit reset): let frames through so the ring refills to the floor. This is the single
		// re-buffer path; the ring un-stalls itself on the insert that reaches the floor, so the
		// gate closes again within one frame rather than draining the whole lookahead.
		//
		// A ring with no playhead is one the next insert re-anchors, so it is the same case: gating
		// on the position a flush threw away would hold the frame that would have re-anchored it.
		if (this.#ring.stalled || this.#timestamp.peek() === undefined) return Promise.resolve();
		return this.#backpressure.wait(timestamp, this.#ring.timestamp);
	}

	close(): void {
		this.#backpressure.flush(); // never leave a decode loop awaiting a closed buffer
		this.#timestamp.set(undefined); // a closed buffer has no playhead
		this.#clock.set(undefined); // a closed buffer is not a clock
		this.#signals.close();
	}
}

/** postMessage-backed fallback implementation. Samples are transferred, not shared. */
class PostAudioBuffer implements AudioBuffer {
	readonly rate: number;
	readonly channels: number;
	#worklet: RingTarget;

	readonly #timestamp = new Signal<Time.Micro | undefined>(undefined);
	readonly timestamp: Getter<Time.Micro | undefined> = this.#timestamp;

	readonly #stalled = new Signal<boolean>(true);
	readonly stalled: Getter<boolean> = this.#stalled;

	readonly #underruns = new Signal<number>(0);
	readonly underruns: Getter<number> = this.#underruns;

	readonly #debug = new Signal<Snapshot | undefined>(undefined);
	readonly debug: Getter<Snapshot | undefined> = this.#debug;

	readonly #clock = new Signal<Clock | undefined>(undefined);
	readonly clock: Getter<Clock | undefined> = this.#clock;
	readonly #clockSource = new ClockSource();

	// Backpressure runs off the playhead the worklet reports in its state messages.
	#backpressure: Backpressure;

	// Which timeline this end is on, bumped by every flush and echoed by the worklet. A state message
	// is already on the port when `reset` posts, so it describes the ring the flush threw away: this
	// is what tells the two apart. See `State.timeline`.
	#timeline = 0;

	#signals = new Effect();

	constructor(worklet: RingTarget, props: AudioBufferProps) {
		const { channels, rate, buffered, conceal } = props;
		this.#worklet = worklet;
		this.channels = channels;
		this.rate = rate;

		this.#backpressure = new Backpressure(buffered, samplesToMicro(props.latency, rate));

		const latency = Time.Milli.fromSecond((props.latency / rate) as Time.Second);
		const msg: InitPost = { type: "init-post", channels, rate, latency, buffered, conceal };
		worklet.port.postMessage(msg);

		// Listen for state updates from the worklet.
		this.#signals.event(worklet.port, "message", (ev: Event) => {
			const data = (ev as MessageEvent<State>).data;
			if (data?.type === "state") {
				// Composed before the worklet saw our flush, so everything in it describes the ring
				// the flush threw away. The next one is a few quanta behind it.
				if (data.timeline !== this.#timeline) return;

				// A flushed ring has no playhead until the next insert anchors it, and neither does
				// one that has never been written to. Publishing undefined is what keeps every
				// consumer off a position the reader is never going to resume from.
				const timestamp = data.playhead?.timestamp;
				this.#timestamp.set(timestamp);
				this.#stalled.set(data.debug.stalled);
				this.#underruns.set(data.debug.underruns);
				this.#debug.set(data.debug);
				const { contextTime, performanceTime } = props.context.getOutputTimestamp();
				if (contextTime === undefined || performanceTime === undefined) {
					throw new Error("Audio output timestamp is missing");
				}
				// Message delivery varies with main-thread load. Anchor the playhead to when its
				// samples reach the output device so that delivery jitter does not pace video.
				const reference = Time.Milli(performanceTime + (data.contextTime - contextTime) * 1000);
				this.#clock.set(
					contextTime === 0 && performanceTime === 0
						? undefined
						: this.#clockSource.sample(data.playhead, reference),
				);
				// While stalled the playhead is parked, so release the decode loop to refill the floor;
				// once playing, hold it to ~the floor ahead.
				if (data.debug.stalled || timestamp === undefined) this.#backpressure.flush();
				else this.#backpressure.advance(timestamp);
			}
		});
		// addEventListener on a MessagePort requires start() to begin delivery.
		worklet.port.start();
	}

	insert(timestamp: Time.Micro, data: Float32Array[]): void {
		this.#clockSource.filling();
		const msg: Data = { type: "data", data, timestamp };
		// Transfer the ArrayBuffers to avoid a copy. This is why samples can be dropped
		// under load: the main thread loses access until the worklet drains the message queue.
		this.#worklet.port.postMessage(
			msg,
			data.map((d) => d.buffer),
		);
	}

	setLatency(samples: number): void {
		this.#backpressure.setHeadroom(samplesToMicro(samples, this.rate));

		const latency = Time.Milli.fromSecond((samples / this.rate) as Time.Second);
		const msg: Latency = { type: "latency", latency };
		this.#worklet.port.postMessage(msg);
	}

	truncate(timestamp: Time.Micro): void {
		const msg: Truncate = { type: "truncate", timestamp };
		this.#worklet.port.postMessage(msg);
	}

	reset(): void {
		this.#timeline++;
		const msg: Reset = { type: "reset", timeline: this.#timeline };
		this.#worklet.port.postMessage(msg);
		// A flushed ring has no playhead until the next insert anchors it. Mirror it locally rather
		// than waiting for the worklet's next state message, which still describes the old one.
		this.#stalled.set(true);
		this.#timestamp.set(undefined);
		this.#clock.set(undefined);
		this.#backpressure.flush(); // the old timeline is gone; let the decode loop re-anchor
	}

	stall(): void {
		const msg: Stall = { type: "stall" };
		this.#worklet.port.postMessage(msg);
		// Mirror it locally rather than waiting for the worklet's next state message, so `wait()`
		// releases the decode loop now.
		this.#stalled.set(true);
		this.#backpressure.flush(); // let the decode loop fill the deeper target
	}

	end(): void {
		const msg: End = { type: "end" };
		this.#worklet.port.postMessage(msg);
		this.#clockSource.ended();
		// Hand the clock over now rather than at the worklet's next state message: `Sync` should
		// not hold video against a playhead the publisher has already said will not move.
		this.#clock.set(undefined);
		this.#backpressure.flush(); // nothing is coming, so nothing should be waiting on the playhead
	}

	wait(timestamp: Time.Micro): Promise<void> {
		// Stalled = still filling the floor (bootstrap, an underrun the reader re-stalled on, or an
		// explicit reset): let frames through so the ring refills to the floor. See SharedAudioBuffer.
		const playhead = this.#timestamp.peek();
		if (this.#stalled.peek() || playhead === undefined) return Promise.resolve();
		// Uses the worklet-reported playhead, which lags by a state-message interval; the floor's
		// headroom covers that. The worklet still drops the oldest if a frame slips through.
		return this.#backpressure.wait(timestamp, playhead);
	}

	close(): void {
		this.#backpressure.flush(); // never leave a decode loop awaiting a closed buffer
		this.#timestamp.set(undefined); // a closed buffer has no playhead
		this.#clock.set(undefined); // a closed buffer is not a clock
		this.#signals.close();
	}
}

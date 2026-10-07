import { Time } from "@moq/net";
import { Effect, type Getter, Signal } from "@moq/signals";
import type { Clock } from "../sync";
import type { Playhead } from "./playhead";
import type { Snapshot } from "./playout";
import type { Data, InitPost, InitShared, Latency, Reset, State, Truncate } from "./render";
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

	/** Note that media reached the ring, so a park is a refill rather than an abandoned playhead. */
	filling(): void {
		this.#parked = undefined;
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
			this.#parked ??= now;
			if (Time.Milli.sub(now, this.#parked) > PARK_LIMIT) return undefined;
		}

		return { timestamp: playhead.timestamp, reference, rate: playhead.rate };
	}
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
	#enabled: boolean;
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

	// Stop gating for good. Nothing advances a closed buffer, so a later wait would never settle.
	close(): void {
		this.#enabled = false;
		this.flush();
	}
}

/** Convert a sample count to a Time.Micro duration at the given sample rate. */
function samplesToMicro(samples: number, rate: number): Time.Micro {
	return Time.Micro.fromSecond((samples / rate) as Time.Second);
}

/**
 * Unified interface for the audio buffer between the main thread and the AudioWorklet.
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

	/** Current playback timestamp (derived from reader position). */
	readonly timestamp: Getter<Time.Micro>;

	/**
	 * The playhead as a clock for `Sync`, or undefined while it is not one.
	 *
	 * Republished as the reader moves, so `Sync` re-anchors rather than drifting; it extrapolates
	 * between samples, so video paces against main-thread memory instead of the ring itself. It is
	 * undefined before the first insert anchors the ring and from a flush until the next insert
	 * re-anchors it: holding the position the flush threw away would report a playhead the reader is
	 * never going to resume from.
	 */
	readonly clock: Getter<Clock | undefined>;

	/** Whether the buffer is stalled (waiting to fill). */
	readonly stalled: Getter<boolean>;

	/** How many times the ring has run dry mid-playback, cumulative. */
	readonly underruns: Getter<number>;

	/**
	 * Every control slot at once: what the ring holds, what the playout engine did with it, and what
	 * either end threw away. Undefined until the ring has reported once.
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

/** Read the device clock once it has a complete timestamp. */
export function outputTimestamp(
	context: Pick<AudioContext, "getOutputTimestamp">,
): Required<AudioTimestamp> | undefined {
	const { contextTime, performanceTime } = context.getOutputTimestamp?.() ?? {};
	// Chromium can expose context time before the device has produced a performance timestamp.
	if (contextTime === undefined || performanceTime === undefined || performanceTime === 0) return undefined;
	return { contextTime, performanceTime };
}

/**
 * Where a ring's writes go: the render worklet's node, or any port the worklet takes ring writes from
 * (see `Port` in `render.ts`), which is how a writer off the main thread reaches it.
 */
export type RingTarget = Pick<AudioWorkletNode, "port">;

/** How the ring behind the worklet is built. */
export interface AudioBufferProps {
	/** Maps render time to the audio device's output clock. */
	context: Pick<AudioContext, "getOutputTimestamp"> & Partial<Pick<AudioContext, "currentTime">>;
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
	/**
	 * Whether the ring is shared memory rather than messages. Shared memory needs
	 * {@link supportsSharedArrayBuffer}, and the graph's builder decides: see `Graph.shared` in `supply.ts`.
	 */
	shared: boolean;
}

/** Create the audio buffer `props.shared` asks for: `SharedAudioBuffer`, or `PostAudioBuffer`. */
export function createAudioBuffer(worklet: RingTarget, props: AudioBufferProps): AudioBuffer {
	return props.shared ? new SharedAudioBuffer(worklet, props) : new PostAudioBuffer(worklet, props);
}

// Whether the transport has been named already, since it is the same answer for the rest of the
// document's life.
let reported = false;

/**
 * Say which transport the page's own ring writes run on, once per document: isolation is the page's,
 * so every player lands on the same one. A note, not a warning, since neither answer is a fault. The
 * audio worker writes by message whatever the page is, so this describes the page's own writes only.
 */
export function reportTransport(shared: boolean): void {
	if (reported) return;
	reported = true;

	if (shared) {
		console.info("[audio] using the SharedArrayBuffer audio buffer");
		return;
	}

	console.warn(
		"[audio] SharedArrayBuffer unavailable, falling back to the higher latency postMessage audio buffer. " +
			"Serve the page cross-origin isolated (Cross-Origin-Opener-Policy: same-origin, Cross-Origin-Embedder-Policy: require-corp) to avoid this.",
	);
}

/** SharedArrayBuffer-backed implementation. Writes go directly into shared memory. */
class SharedAudioBuffer implements AudioBuffer {
	readonly rate: number;
	readonly channels: number;
	#worklet: RingTarget;
	#ring: SharedRingBuffer;

	readonly #timestamp = new Signal<Time.Micro>(0 as Time.Micro);
	readonly timestamp: Getter<Time.Micro> = this.#timestamp;

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
		const { channels, rate, buffered, latency: latencySamples } = props;
		this.#worklet = worklet;
		this.channels = channels;
		this.rate = rate;
		this.#conceal = props.conceal;

		// The ring holds the latency floor as decoded PCM (headroom above it for overflow). In
		// buffered mode the lookahead above the floor stays encoded upstream, held back by `wait()`.
		const capacity = Math.max(rate, latencySamples * 2);
		this.#backpressure = new Backpressure(buffered, samplesToMicro(latencySamples, rate));

		const init = allocSharedRingBuffer(channels, capacity, rate, buffered);
		this.#ring = new SharedRingBuffer(init);
		this.#ring.setLatency(latencySamples);

		const msg: InitShared = { type: "init-shared", ...init, conceal: this.#conceal };
		worklet.port.postMessage(msg);

		// Poll the shared control array and reflect it into signals. Also the clock's cadence: video
		// re-anchors to the audio playhead once per poll and extrapolates in between, so a per-frame
		// wait costs no shared-memory read at all.
		this.#signals.interval(() => {
			const stalled = this.#ring.stalled;
			// One read: the getter is stateful (it measures the reader's rate between polls) and it
			// is the only thing that knows whether the ring is anchored.
			const playhead = this.#ring.playhead;
			const timestamp = playhead?.timestamp ?? this.#ring.timestamp;
			this.#timestamp.set(timestamp);
			this.#stalled.set(stalled);
			this.#underruns.set(this.#ring.underruns);
			this.#debug.set(this.#ring.debug());
			const output = outputTimestamp(props.context);
			const rendered = props.context.currentTime;
			this.#clock.set(
				output && rendered !== undefined
					? this.#clockSource.sample(
							playhead,
							Time.Milli(output.performanceTime + (rendered - output.contextTime) * 1000),
						)
					: undefined,
			);
			// While stalled the playhead is parked, so release the decode loop to refill the floor;
			// once playing, hold it to ~the floor ahead.
			if (stalled) this.#backpressure.flush();
			else this.#backpressure.advance(timestamp);
		}, 50);
	}

	insert(timestamp: Time.Micro, data: Float32Array[]): void {
		this.#clockSource.filling();
		this.#ring.insert(timestamp, data);
	}

	setLatency(samples: number): void {
		this.#backpressure.setHeadroom(samplesToMicro(samples, this.rate));

		// Park the current ring before any resize: the worklet keeps reading it until `init-shared`
		// lands, and `resize` carries the floor and the park over to the copy.
		this.#ring.setLatency(samples);

		// Grow the ring (preserving the unread window) if it's too small for the new latency.
		if (this.#ring.capacity < samples * 1.5) {
			const newCapacity = Math.max(this.rate, samples * 2);
			this.#ring = this.#ring.resize(newCapacity);

			const msg: InitShared = { type: "init-shared", ...this.#ring.init, conceal: this.#conceal };
			this.#worklet.port.postMessage(msg);
		}
	}

	truncate(timestamp: Time.Micro): void {
		this.#ring.truncate(timestamp);
	}

	reset(): void {
		this.#ring.reset();
		// A flushed ring has no playhead until the next insert anchors it. Publishing the one it had
		// would leave `Sync` extrapolating from a position the reader is never going to resume from.
		this.#clock.set(undefined);
		this.#backpressure.flush(); // the old timeline is gone; let the decode loop re-anchor
	}

	wait(timestamp: Time.Micro): Promise<void> {
		// Stalled = still filling the floor (bootstrap, an underrun the reader re-stalled on, or an
		// explicit reset): let frames through so the ring refills to the floor. This is the single
		// re-buffer path; the ring un-stalls itself on the insert that reaches the floor, so the
		// gate closes again within one frame rather than draining the whole lookahead.
		if (this.#ring.stalled) return Promise.resolve();
		return this.#backpressure.wait(timestamp, this.#ring.timestamp);
	}

	close(): void {
		this.#backpressure.close(); // never leave a decode loop awaiting a closed buffer
		this.#clock.set(undefined); // a closed buffer is not a clock
		this.#signals.close();
	}
}

/** postMessage-backed fallback implementation. Samples are transferred, not shared. */
class PostAudioBuffer implements AudioBuffer {
	readonly rate: number;
	readonly channels: number;
	#worklet: RingTarget;

	readonly #timestamp = new Signal<Time.Micro>(0 as Time.Micro);
	readonly timestamp: Getter<Time.Micro> = this.#timestamp;

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
		const { channels, rate, buffered, conceal, latency: latencySamples } = props;
		this.#worklet = worklet;
		this.channels = channels;
		this.rate = rate;

		this.#backpressure = new Backpressure(buffered, samplesToMicro(latencySamples, rate));

		const latency = Time.Milli.fromSecond((latencySamples / rate) as Time.Second);
		const msg: InitPost = { type: "init-post", channels, rate, latency, buffered, conceal };
		worklet.port.postMessage(msg);

		// Listen for state updates from the worklet.
		this.#signals.event(worklet.port, "message", (ev: Event) => {
			const data = (ev as MessageEvent<State>).data;
			if (data?.type === "state") {
				// Composed before the worklet saw our flush, so everything in it describes the ring
				// the flush threw away. The next one is a few quanta behind it.
				if (data.timeline !== this.#timeline) return;

				this.#timestamp.set(data.timestamp);
				this.#stalled.set(data.stalled);
				this.#underruns.set(data.underruns);
				this.#debug.set(data.debug);
				const output = outputTimestamp(props.context);
				// Message delivery varies with main-thread load. Anchor the playhead to when its
				// samples reach the output device so that delivery jitter does not pace video.
				this.#clock.set(
					output &&
						this.#clockSource.sample(
							data.playhead,
							Time.Milli(output.performanceTime + (data.contextTime - output.contextTime) * 1000),
						),
				);
				// While stalled the playhead is parked, so release the decode loop to refill the floor;
				// once playing, hold it to ~the floor ahead.
				if (data.stalled) this.#backpressure.flush();
				else this.#backpressure.advance(data.timestamp);
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
		this.#clock.set(undefined);
		this.#backpressure.flush(); // the old timeline is gone; let the decode loop re-anchor
	}

	wait(timestamp: Time.Micro): Promise<void> {
		// Stalled = still filling the floor (bootstrap, an underrun the reader re-stalled on, or an
		// explicit reset): let frames through so the ring refills to the floor. See SharedAudioBuffer.
		if (this.#stalled.peek()) return Promise.resolve();
		// Uses the worklet-reported playhead, which lags by a state-message interval; the floor's
		// headroom covers that. The worklet still drops the oldest if a frame slips through.
		return this.#backpressure.wait(timestamp, this.#timestamp.peek());
	}

	close(): void {
		this.#backpressure.close(); // never leave a decode loop awaiting a closed buffer
		this.#clock.set(undefined); // a closed buffer is not a clock
		this.#signals.close();
	}
}

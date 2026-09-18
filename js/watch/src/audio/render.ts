import type { Time } from "@moq/net";
import type { Playhead } from "./playhead";
import type { Snapshot } from "./playout";
import type { SharedRingBufferInit } from "./shared-ring-buffer";

/** Everything the main thread sends the render worklet over its port. */
export type Message = InitShared | InitPost | Data | End | Latency | Reset | Stall | Truncate;
export type ToMain = State;

/** Init message when SharedArrayBuffer is available. */
export interface InitShared extends SharedRingBufferInit {
	type: "init-shared";
	// Whether a gap is concealed with synthesized audio or played as a ramp into silence. A property
	// of the reader rather than of the ring, so a resize hands the replacement the same answer.
	conceal: boolean;
}

/** Init message for the postMessage fallback path. */
export interface InitPost {
	type: "init-post";
	channels: number;
	rate: number;
	latency: Time.Milli;
	// Buffered mode: anchor to the first frame and play through; the ring is sized to the floor and
	// the lookahead above it is held back upstream (the main thread applies the backpressure).
	buffered: boolean;
	// Whether a gap is concealed with synthesized audio or played as a ramp into silence.
	conceal: boolean;
}

/** Flush the buffer and re-stall (fallback path only; shared path resets via Atomics). */
export interface Reset {
	type: "reset";
	/** Which timeline the flush starts. See {@link State.timeline}. */
	timeline: number;
}

/**
 * Hold playback until the buffer holds the target again, keeping what is buffered (fallback path
 * only; the shared path stalls via Atomics).
 */
export interface Stall {
	type: "stall";
}

/**
 * The publisher declared the timeline finished: play out what is buffered, then silence rather than
 * concealment (fallback path only; the shared path ends via Atomics).
 */
export interface End {
	type: "end";
}

/**
 * Drop buffered samples at or after `timestamp`, keeping what is already due (fallback path only;
 * the shared path truncates via Atomics).
 */
export interface Truncate {
	type: "truncate";
	timestamp: Time.Micro;
}

/** Audio samples sent via postMessage (fallback path only). */
export interface Data {
	type: "data";
	data: Float32Array[];
	timestamp: Time.Micro;
}

/** Latency update sent via postMessage (fallback path only). */
export interface Latency {
	type: "latency";
	latency: Time.Milli;
}

/** State update from the worklet back to main thread (fallback path only). */
export interface State {
	type: "state";
	/**
	 * Which timeline this describes: the {@link Reset.timeline} of the last flush the worklet applied.
	 *
	 * A state message is composed a port hop before the main thread reads it, so one sent while a
	 * flush was in flight describes the ring the flush threw away. Carrying the timeline is what lets
	 * the main thread drop it, rather than publishing a playhead from before the flush and pacing
	 * video against a position the reader will never resume from.
	 */
	timeline: number;
	// Where the reader is and how fast it is moving, or undefined until the first write anchors the
	// ring. The main thread stamps it with its arrival and extrapolates until the next one.
	playhead: Playhead | undefined;
	// Every counter the shared transport keeps in its control array, since the main thread cannot
	// read this ring's memory directly.
	debug: Snapshot;
}

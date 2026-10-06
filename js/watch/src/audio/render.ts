import type { Time } from "@moq/net";
import type { Playhead } from "./playhead";
import type { Snapshot } from "./playout";
import type { SharedRingBufferInit } from "./shared-ring-buffer";

/** Everything a writer sends the render worklet: over the node's own port, or over one handed to it as a {@link Port}. */
export type Message = InitShared | InitPost | Data | Latency | Reset | Truncate | Port | Close;
/** Playback reports and errors, sent by the render worklet. */
export type ToMain = State | Unreadable;

/**
 * A message reached the worklet and could not be deserialized, so whatever it carried never arrived:
 * a ring, samples, a flush. Sent once, the first time any port reports one.
 *
 * The ring cannot say so itself: it just plays silence.
 */
export interface Unreadable {
	type: "unreadable";
}

/**
 * Another port the worklet takes every other {@link Message} from, exactly as it takes them from its own.
 *
 * A writer that is not on the main thread (a dedicated worker) cannot reach the node's port, so the
 * page hands the worklet one end of a channel and the writer the other, and the ring's writes never
 * wait on the page's event loop. The writer gets every {@link State}; the page gets the first playback report.
 */
export interface Port {
	type: "port";
	port: MessagePort;
}

/**
 * The node is done with: the processor stops rendering and lets the browser collect it. A processor
 * whose `process` keeps returning true keeps running after its node is disconnected, for as long as the
 * context is open, and the decoder rebuilds nodes in a context that stays open.
 */
export interface Close {
	type: "close";
}

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
	timestamp: Time.Micro;
	/** Audio context time at the end of the rendered quantum. */
	contextTime: Time.Second;
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
	// ring. The main thread maps contextTime to the output clock and extrapolates from it.
	playhead: Playhead | undefined;
	stalled: boolean;
	// How many times the ring has run dry mid-playback, cumulative.
	underruns: number;
	// Every counter the shared transport keeps in its control array, since the main thread cannot
	// read this ring's memory directly.
	debug: Snapshot;
}

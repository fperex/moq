/**
 * What an audio ring's reader needs to see before it decides what to do with the media.
 *
 * The reader runs in the AudioWorklet and both transports hand it the same surface, so whatever
 * consumes it is written once. Nothing here imports `@moq/signals` or `@moq/hang`: it is bundled
 * into the worklet blob.
 */

/** What the reader can see of the ring's state, the same on both transports. */
export interface RingView {
	/** Media samples available to read. */
	buffered: number;
	/** The playout target, in samples. */
	target: number;
	/** The most recent insert, in samples: one decoded chunk. */
	chunk: number;
	/** How far above `target + chunk` the ring may sit before the reader skips ahead, in samples. */
	skip: number;
	/** Whether playback is parked while the ring refills. */
	stalled: boolean;
	/** Whether the writer is mid-rebase, so nothing buffered can be trusted this quantum. */
	unstable: boolean;
	/** Changes whenever the media timeline was replaced: a truncate, a reset, or a re-anchor. */
	generation: number;
}

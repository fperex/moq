import type { Time } from "@moq/net";

/**
 * Where a ring's reader sits on the media timeline, and how fast it is moving.
 *
 * Sampled on the main thread (shared transport) or posted by the worklet (postMessage transport),
 * and stamped with the time it was read to become the clock `Sync` follows. Both transports report
 * the same two fields so the main thread extrapolates between samples the same way either way.
 */
export interface Playhead {
	/**
	 * The media position the reader has played up to.
	 *
	 * A media position, not an output frame count: the two differ once the reader can hold a block
	 * back or stretch one, and it is the media position video has to be paced against.
	 */
	timestamp: Time.Micro;

	/**
	 * Media time per unit of wall time: 1 while playing, 0 while the ring is parked.
	 *
	 * A field rather than an assumed 1 because the reader does not always consume media at wall
	 * speed: a stall holds it at zero today, and a time-stretched block moves it off 1.
	 */
	rate: number;
}

/**
 * Tells a ring filling from empty apart from playback that stopped.
 *
 * The ring reports one flag for both: it is stalled before it has ever played, after the download
 * is turned off and flushed, and when the reader runs dry mid-playback. Only the last of those is
 * something the viewer notices, and it is the only one worth telling them about. A fill is what a
 * cold start and an unmute cost, with nothing interrupted while it happens.
 */
export class Interruption {
	#played = false;

	/** Record that the ring is filling from empty, so the stall it is in interrupts nothing. */
	restarted(): void {
		this.#played = false;
	}

	/** Consume what the ring reports and say whether playback is interrupted. */
	update(stalled: boolean): boolean {
		if (!stalled) this.#played = true;
		return stalled && this.#played;
	}
}

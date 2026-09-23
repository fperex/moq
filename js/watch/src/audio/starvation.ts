import type * as Container from "@moq/hang/container";
import { Time } from "@moq/net";
import { WORKLET_QUANTUM } from "./config";
import type { Snapshot } from "./playout";

/**
 * Reports the ring running dry to the arrival estimator, which cannot see it any other way.
 *
 * A receiver whose page freezes reads the frames that queued behind the freeze all at once, and the
 * estimator discounts every one of them as the receiver's own wait (see `Container.Jitter`), so a
 * receiver that keeps freezing is one whose arrivals never say the ring is too shallow. The ring
 * running dry does, and this is what hears it: the reader counts an underrun, and the time since is
 * what the player ran out of.
 *
 * Driven by the ring's counters wherever the main thread reads them, which it only does between
 * freezes: the first read after one is the moment it can learn the ring ran dry. It reports then,
 * so the refill aims at the raised target, and at every read after that until one finds media back.
 * A postMessage ring's reads queue up behind a freeze and arrive in order after it, the earliest
 * describing the first moments of the run-dry, so it is the last of them that knows how long it was.
 *
 * @internal
 */
export class Starvation {
	readonly #rate: number;

	// The counters as last read, so an underrun is the count moving between two reads.
	#previous?: Snapshot;

	// The run-dry being reported: the target it happened at, the timeline it happened on, and the
	// counters its length is measured from.
	#episode?: { base: number; anchor: number; concealed: number; short: number };

	/** A watcher for a ring playing `rate` samples a second. */
	constructor(rate: number) {
		this.#rate = rate;
	}

	/** Fold in the ring's counters as read at `now`, reporting any run-dry they show to `jitter`. */
	update(snapshot: Snapshot, jitter: Container.Jitter | undefined, now: Time.Milli): void {
		const previous = this.#previous;
		this.#previous = snapshot;
		if (previous === undefined || jitter === undefined) {
			this.#episode = undefined;
			return;
		}

		// A timeline nothing has been played from is filling, not running dry: a fresh ring, a flush,
		// a mute. One replaced under a run-dry ends it without another report, since what the reader
		// waits for from there is the new timeline's fill.
		if (snapshot.fresh || (this.#episode !== undefined && snapshot.anchor !== this.#episode.anchor)) {
			this.#episode = undefined;
			return;
		}

		// Media is back: the ring holds something again, or has already refilled and resumed.
		const back = snapshot.buffered > 0 || !snapshot.stalled;

		if (this.#episode === undefined) {
			if (snapshot.underruns <= previous.underruns) return;
			// Everything since the previous read belongs to this run-dry: across a freeze, that read
			// is the last one before it.
			this.#episode = {
				base: jitter.value.peek(),
				anchor: snapshot.anchor,
				concealed: previous.concealed,
				short: previous.short,
			};
		}
		const episode = this.#episode;

		// What the player had nothing of the stream to play for: the audio concealment made up, and
		// the quanta that went out short where it could not, which is all of them with concealment
		// off. A short quantum is counted whole, which is at most one quantum long.
		const frames = snapshot.concealed - episode.concealed + (snapshot.short - episode.short) * WORKLET_QUANTUM;
		const gap = (frames / this.#rate) * 1000;

		// Measured from the target the run-dry happened at. A later report asks only for what an
		// earlier one did not already cover, so however many there are they add up to one.
		jitter.starved(Time.Milli(Math.max(0, episode.base + gap - jitter.value.peek())), now);

		// Done once media is back. What follows is the refill, whose length the raised target itself
		// sets, so counting it too would feed the report back into itself.
		if (back) this.#episode = undefined;
	}
}

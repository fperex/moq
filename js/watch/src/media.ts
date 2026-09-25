import * as Container from "@moq/hang/container";
import type * as Moq from "@moq/net";
import { Error as NetError, type Time } from "@moq/net";
import type { Effect, Getter, Signal } from "@moq/signals";

/**
 * Add a per-subscription counter into a running total, so a swap does not restart it.
 *
 * A rendition change, a republished broadcast, or a reconnect installs a fresh container
 * consumer whose counters start at zero. Proxying one straight through would report the
 * viewer's session as having lost nothing the moment the track changed.
 *
 * @internal
 */
export function accumulate(effect: Effect, target: Signal<number>, source: Getter<number>): void {
	let previous = 0;
	effect.run((inner) => {
		const value = inner.get(source);
		target.update((total) => total + value - previous);
		previous = value;
	});
}

/**
 * The arrival estimator one rendition keeps, handed back whenever that rendition is playing.
 *
 * One estimator per rendition, and a rendition that leaves the catalog and comes back is the same
 * rendition. A publisher hiding its camera or dropping its microphone for a few hundred
 * milliseconds is the same path with the same claim about it, and what was measured on it is still
 * the best thing this receiver knows; the subscription and the container consumer are rebuilt
 * either way.
 *
 * Reseeding there publishes the publisher's declaration as though it were a measurement, and
 * {@link Sync} holds every track to the widest reading, so one track's guess deepens a buffer every
 * other track has already measured. On the bench a camera hidden and shown for 300ms took the
 * shared delay from 20ms to the estimator's 80ms guess, which resized the audio ring mid-playback
 * and cost three of five watchers an underrun and a spinner.
 *
 * A different rendition is a different path with a different declaration, and starts over.
 *
 * @internal
 */
export class Estimator {
	#key?: string;
	#spread?: Container.Jitter;

	/**
	 * The estimator for one rendition, which is the one it left behind unless anything changed.
	 *
	 * `rendition` is whatever makes this a different path, compared by value; `start` is the
	 * publisher's declared flush span, which is part of the comparison because a rendition that
	 * declares a different span has made a different claim about itself.
	 */
	spread(rendition: unknown, start?: Time.Milli): Container.Jitter {
		const key = JSON.stringify([rendition, start]);
		if (key !== this.#key || !this.#spread) {
			this.#key = key;
			this.#spread = new Container.Jitter({ start });
		}
		return this.#spread;
	}
}

/**
 * Where a fresh media subscription starts reading a track that is already holding groups.
 *
 * `"latest"` is what a live player wants: a cursor starting at the oldest group replays the whole
 * retained window at decode speed before it reaches live media, which a viewer sees as playback
 * jumping backwards and then sprinting to catch up. `"oldest"` keeps everything the track holds,
 * which is what buffered playback wants, where media written ahead of the playhead is the point.
 *
 * @internal
 */
export type MediaStart = "latest" | "oldest";

/**
 * Open a media subscription with its max age on the initial request and every update.
 *
 * @internal
 */
export function subscribeMedia(
	effect: Effect,
	props: {
		broadcast: Moq.Broadcast.Consumer;
		track: string;
		priority: number;
		maxAge: Getter<Time.Milli>;
		/** Where to start on a track that already holds groups. Defaults to the live edge. */
		start?: MediaStart;
	},
): Moq.Track.Subscriber | undefined {
	if (effect.get(props.broadcast.closed) !== undefined) return;
	const subscription = () => ({ priority: props.priority, maxAge: props.maxAge.peek() });
	const subscriber = props.broadcast.track(props.track).subscribe(subscription());
	effect.cleanup(() => subscriber.close());

	// A player often opens on a track that is already holding groups: repeat subscriptions to one
	// track share a single upstream, so a replacement subscription (an unmute, a rendition swap, a
	// reconnect) lands on the cache its predecessor filled and is replayed the whole retained
	// window. A live player wants none of that backlog.
	//
	// This moves the local read cursor and deliberately not the subscription's own group start.
	// That field is a request to the publisher, aggregated across every live subscriber, so naming
	// a stale cached sequence there asks the publisher to rewind the track for everyone reading it.
	// What a player wants is to skip what it already has.
	if ((props.start ?? "latest") === "latest") {
		const live = subscriber.latest();
		if (live !== undefined) subscriber.setGroups({ start: { included: live } });
	}

	effect.run((inner) => {
		subscriber.update({ priority: props.priority, maxAge: inner.get(props.maxAge) });
	});

	return subscriber;
}

/** Read the next media frame, ending playback when its subscription is reset. @internal */
export async function nextMedia(consumer: Container.Consumer) {
	try {
		return await consumer.next();
	} catch (err) {
		if (!(err instanceof NetError.Stream)) throw err;
		// The subscription is over, even when other tracks on the session are still live.
		console.debug("media subscription ended", err);
		return undefined;
	}
}

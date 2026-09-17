import type { Container } from "@moq/hang";
import type * as Moq from "@moq/net";
import { StreamError, type Time } from "@moq/net";
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
		if (!(err instanceof StreamError)) throw err;
		// The subscription is over, even when other tracks on the session are still live.
		console.debug("media subscription ended", err);
		return undefined;
	}
}

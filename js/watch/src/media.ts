import type { Container } from "@moq/hang";
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
	},
): Moq.Track.Subscriber | undefined {
	if (effect.get(props.broadcast.closed) !== undefined) return;
	const subscription = () => ({ priority: props.priority, maxAge: props.maxAge.peek() });
	const subscriber = props.broadcast.track(props.track).subscribe(subscription());
	effect.cleanup(() => subscriber.close());

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

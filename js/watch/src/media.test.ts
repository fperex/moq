import { expect, test } from "bun:test";
import { Container } from "@moq/hang";
import * as Moq from "@moq/net";
import { Time } from "@moq/net";
import { Effect, Once, Signal } from "@moq/signals";
import { nextMedia, subscribeMedia } from "./media";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test("media max age is present on the initial subscription and later updates", async () => {
	let initial: Moq.Track.Subscription | undefined;
	const updates: Moq.Track.Subscription[] = [];
	const subscriber = {
		close: () => undefined,
		update: (subscription: Moq.Track.Subscription) => updates.push(subscription),
		// Nothing has been observed on this stand-in, which is what an unheld track reports.
		latest: () => undefined,
		setGroups: () => undefined,
	} as unknown as Moq.Track.Subscriber;
	const broadcast = {
		closed: new Once<Error | null>(),
		track: () => ({
			subscribe: (subscription: Moq.Track.Subscription) => {
				initial = subscription;
				return subscriber;
			},
		}),
	} as unknown as Moq.Broadcast.Consumer;
	const maxAge = new Signal(Time.Milli(250));
	const effect = new Effect();

	subscribeMedia(effect, {
		broadcast,
		track: "media",
		priority: 7,
		maxAge,
	});
	expect(initial).toEqual({ priority: 7, maxAge: 250 });

	maxAge.set(Time.Milli(500));
	await flush();
	expect(updates.at(-1)).toEqual({ priority: 7, maxAge: 500 });

	effect.close();
});

for (const end of [
	new Moq.StreamError(Moq.StreamCode.Cancel),
	new Moq.StreamError(Moq.StreamCode.Internal),
	new Moq.StreamError(Moq.StreamCode(1234)),
	new Moq.SessionError(Moq.SessionCode.Internal),
	new Error("decoder failed"),
]) {
	test(`media subscription end: ${end}`, async () => {
		const track = new Moq.Track.Producer("test");
		const consumer = new Container.Consumer(track.subscribe(), { format: new Container.Legacy.Format("data") });
		try {
			const pending = nextMedia(consumer);
			track.close(end);
			if (end instanceof Moq.StreamError) expect(await pending).toBeUndefined();
			else await expect(pending).rejects.toBe(end);
		} finally {
			consumer.close();
		}
	});
}

test("media does not subscribe through a closed broadcast handle", () => {
	const broadcast = new Moq.Broadcast.Producer();
	const handle = broadcast.consume();
	broadcast.close();
	const effect = new Effect();
	try {
		expect(
			subscribeMedia(effect, {
				broadcast: handle,
				track: "video",
				priority: 0,
				maxAge: new Signal(Time.Milli(0)),
			}),
		).toBeUndefined();
	} finally {
		effect.close();
		handle.close();
	}
});

/** One legacy container frame at `timestamp`, in a group of its own. */
function writeGroup(track: Moq.Track.Producer, sequence: number, timestamp: number): void {
	const ts = Moq.Varint.encode(timestamp);
	const payload = new Uint8Array(ts.byteLength + 2);
	payload.set(ts, 0);
	payload.set([0xde, 0xad], ts.byteLength);
	const group = new Moq.Group.Producer(sequence);
	group.writeFrame({ payload, timestamp: Time.Timestamp.now() });
	group.close();
	track.writeGroup(group);
}

/** Read until nothing more arrives within `ms`, and say which frame timestamps did. */
async function collect(consumer: Container.Consumer, ms: number): Promise<number[]> {
	const seen: number[] = [];
	for (;;) {
		const next = await Promise.race([
			consumer.next(),
			new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
		]);
		if (!next) break;
		if (next.frame) seen.push(next.frame.timestamp);
	}
	return seen;
}

test("a media subscription starts at the live edge of a track that is already holding groups", async () => {
	// A replacement subscription (an unmute, a rendition swap, a reconnect) lands on the cache its
	// predecessor filled, since repeat subscriptions to one track share a single upstream. Replaying
	// that backlog is playback jumping backwards and then sprinting, and every group of it is older
	// than the age budget, so the container consumer convicts it group by group.
	const broadcast = new Moq.Broadcast.Producer();
	const track = broadcast.createTrack("audio");
	for (const [sequence, timestamp] of [
		[0, 0],
		[1, 20_000],
		[2, 40_000],
	]) {
		writeGroup(track, sequence, timestamp);
	}

	const handle = broadcast.consume();
	const effect = new Effect();
	try {
		const sub = subscribeMedia(effect, {
			broadcast: handle,
			track: "audio",
			priority: 0,
			maxAge: new Signal(Time.Milli(100)),
		});
		expect(sub).toBeDefined();
		const consumer = new Container.Consumer(sub as Moq.Track.Subscriber, {
			format: new Container.Legacy.Format("audio"),
			// Wide enough to hold the whole backlog, so the cursor is the only thing under test:
			// without it the three groups arrive and none of them is old enough to convict.
			maxAge: Time.Milli(30_000),
		});
		try {
			// The live edge only, so nothing the age budget would then throw away.
			expect(await collect(consumer, 150)).toEqual([40_000]);
			expect(consumer.skipped.peek()).toBe(0);
		} finally {
			consumer.close();
		}
	} finally {
		effect.close();
		handle.close();
		broadcast.close();
	}
});

test("a media subscription keeps the backlog when the caller asks to start at the oldest group", async () => {
	// Buffered playback: media written ahead of the playhead is the point, so skipping to the live
	// edge would drop the utterance the application queued.
	const broadcast = new Moq.Broadcast.Producer();
	const track = broadcast.createTrack("audio");
	for (const [sequence, timestamp] of [
		[0, 0],
		[1, 20_000],
		[2, 40_000],
	]) {
		writeGroup(track, sequence, timestamp);
	}

	const handle = broadcast.consume();
	const effect = new Effect();
	try {
		const sub = subscribeMedia(effect, {
			broadcast: handle,
			track: "audio",
			priority: 0,
			maxAge: new Signal(Time.Milli(30_000)),
			start: "oldest",
		});
		const consumer = new Container.Consumer(sub as Moq.Track.Subscriber, {
			format: new Container.Legacy.Format("audio"),
			maxAge: Time.Milli(30_000),
		});
		try {
			expect(await collect(consumer, 150)).toEqual([0, 20_000, 40_000]);
		} finally {
			consumer.close();
		}
	} finally {
		effect.close();
		handle.close();
		broadcast.close();
	}
});

test("a media subscription on a track with no backlog reads every group it then produces", async () => {
	const broadcast = new Moq.Broadcast.Producer();
	const track = broadcast.createTrack("audio");
	const handle = broadcast.consume();
	const effect = new Effect();
	try {
		const sub = subscribeMedia(effect, {
			broadcast: handle,
			track: "audio",
			priority: 0,
			maxAge: new Signal(Time.Milli(100)),
		});
		const consumer = new Container.Consumer(sub as Moq.Track.Subscriber, {
			format: new Container.Legacy.Format("audio"),
			maxAge: Time.Milli(30_000),
		});
		try {
			writeGroup(track, 0, 0);
			writeGroup(track, 1, 20_000);
			expect(await collect(consumer, 150)).toEqual([0, 20_000]);
		} finally {
			consumer.close();
		}
	} finally {
		effect.close();
		handle.close();
		broadcast.close();
	}
});

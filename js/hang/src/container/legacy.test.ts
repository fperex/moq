import { expect, test } from "bun:test";
import { Time, Track } from "@moq/net";
import { Format, Producer } from "./legacy.ts";

const payload = (n: number) => new Uint8Array(n).fill(7);

test("closing a producer whose track already closed does not throw", () => {
	const track = new Track.Producer("video");
	const producer = new Producer(track, new Format("video"));
	producer.encode(payload(8), Time.Micro(0), true);

	// The track can close under the producer: its last subscriber leaving releases it, which is what
	// makes the next subscription a real one. There is no group left to flush an endpoint into.
	track.close();
	expect(() => producer.close()).not.toThrow();
});

test("cutting after the track closed is a no-op rather than a throw", () => {
	const track = new Track.Producer("video");
	const producer = new Producer(track, new Format("video"));
	producer.encode(payload(8), Time.Micro(0), true);

	track.close();
	expect(() => producer.cut(Time.Micro(33_000))).not.toThrow();
	// Still idempotent afterwards.
	expect(() => producer.cut()).not.toThrow();
	expect(() => producer.close()).not.toThrow();
});

// A paused encoder's last group reads as live to any budget until the resumed media exists, so a
// relay re-subscribing at its cache's edge and a viewer joining the pause both need the break.
test("a subscription made after a cut starts at its marker", () => {
	const track = new Track.Producer("video").accept({});
	const producer = new Producer(track, new Format("video"));
	// Two 500ms groups at 30fps, the second still open when demand leaves.
	for (let frame = 0; frame < 20; frame++) {
		producer.encode(payload(8), Time.Micro(frame * 33_333), frame % 15 === 0);
	}
	producer.cut();

	const marker = track.subscribe().latest();
	const joiner = track.subscribe({ maxAge: Time.Milli(100) });
	expect(joiner.tryRecvGroup()?.sequence).toBe(marker);
	const rejoin = track.subscribe({ maxAge: Time.Milli(100), groups: { start: { included: 1 } } });
	expect(rejoin.tryRecvGroup()?.sequence).toBe(marker);
	track.close();
});

import { expect, test } from "bun:test";
import { Time, Track } from "@moq/net";
import { Format, Producer } from "./legacy.ts";

const payload = (n: number) => new Uint8Array(n).fill(7);

test("closing a producer whose track already closed does not throw", () => {
	const track = new Track.Producer("video");
	const producer = new Producer(track, new Format("video"));
	producer.encode(payload(8), Time.Micro(0), true);

	// The track can close under the producer: its last subscriber leaving now releases it, which is
	// what makes the next subscription a real one. Flushing an endpoint into the group it tore down
	// used to throw "group is closed" out of whatever was tidying up.
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

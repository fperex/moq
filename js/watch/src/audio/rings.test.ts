import { describe, expect, it } from "bun:test";
import { Time } from "@moq/net";
import { type Counters, frames, STRETCH_BOUND } from "./playout";
import { AudioRingBuffer } from "./ring-buffer";
import { allocSharedRingBuffer, SharedRingBuffer } from "./shared-ring-buffer";

// What the playout engine reads of a ring, run against both transports. The rate is 1000, so a
// sample is a millisecond.

const RATE = 1000;
const SKIP = frames(RATE, STRETCH_BOUND);

/** Either ring, with the calls the two transports spell differently behind one name. */
interface Ring {
	readonly buffer: SharedRingBuffer | AudioRingBuffer;
	insert(ms: number, samples: number, value?: number): void;
}

type Build = (latency: number) => Ring;

function micro(ms: number): Time.Micro {
	return Time.Micro.fromMilli(ms as Time.Milli);
}

const shared: Build = (latency) => {
	const buffer = new SharedRingBuffer(allocSharedRingBuffer(1, 1024, RATE));
	buffer.setLatency(latency);
	return {
		buffer,
		insert: (ms, samples, value = 1) => buffer.insert(micro(ms), [new Float32Array(samples).fill(value)]),
	};
};

const post: Build = (latency) => {
	const buffer = new AudioRingBuffer({ rate: RATE, channels: 1, latency: latency as Time.Milli });
	return {
		buffer,
		insert: (ms, samples, value = 1) => buffer.write(micro(ms), [new Float32Array(samples).fill(value)]),
	};
};

const RINGS: Array<[string, Build]> = [
	["shared", shared],
	["post", post],
];

/** Insert `samples` as a run of `chunk`-sized inserts from `ms`, the way a decoder delivers them. */
function insertChunks(ring: Ring, ms: number, samples: number, chunk: number, value = 1): void {
	for (let i = 0; i < samples; i += chunk) ring.insert(ms + i, Math.min(chunk, samples - i), value);
}

/** Take `count` samples through the reader surface, the way the playout engine does. */
function take(ring: Ring, count: number): Float32Array {
	const view = ring.buffer.view();
	const got = Math.min(count, view.buffered);
	const out = [new Float32Array(got)];
	ring.buffer.peek(out, got);
	expect(ring.buffer.commit(got)).toBe(true);
	return out[0];
}

const counters = (queued: number): Counters => ({
	queued,
	stretched: 0,
	output: 0,
	concealed: 0,
	accelerates: 0,
	expands: 0,
	merges: 0,
	short: 0,
});

describe.each(RINGS)("%s ring: the reader surface", (_, build) => {
	it("reports the target, the band, and what it holds", () => {
		const ring = build(40);
		insertChunks(ring, 0, 40, 20);

		const view = ring.buffer.view();
		expect(view.buffered).toBe(40);
		expect(view.target).toBe(40);
		expect(view.skip).toBe(SKIP);
		expect(view.stalled).toBe(false);
		expect(view.converge).toBe(true);
		expect(view.unstable).toBe(false);
		expect(ring.buffer.debug().target).toBe(40);
		expect(ring.buffer.debug().skip).toBe(SKIP);
	});

	it("hands out samples without advancing until the reader commits them", () => {
		const ring = build(40);
		insertChunks(ring, 0, 40, 10);
		ring.buffer.view();
		const out = [new Float32Array(10)];
		ring.buffer.peek(out, 10);
		expect(ring.buffer.length).toBe(40);

		expect(ring.buffer.commit(10)).toBe(true);
		expect(ring.buffer.length).toBe(30);
	});

	it("reports nothing to play while stalled, and a park is not an underrun", () => {
		const ring = build(40);
		insertChunks(ring, 0, 20, 10);

		const view = ring.buffer.view();
		expect(view.stalled).toBe(true);
		expect(view.buffered).toBe(0);
		expect(ring.buffer.underruns).toBe(0);
	});

	it("parks and counts an underrun when the reader starves it", () => {
		const ring = build(40);
		insertChunks(ring, 0, 40, 10);
		take(ring, 40);

		expect(ring.buffer.view().buffered).toBe(0);
		ring.buffer.starve();
		expect(ring.buffer.stalled).toBe(true);
		expect(ring.buffer.underruns).toBe(1);
	});

	it("reports the media playhead as the cursor less what the engine still holds", () => {
		const ring = build(40);
		insertChunks(ring, 0, 40, 10);
		take(ring, 30);

		expect(Time.Milli.fromMicro(ring.buffer.timestamp)).toBe(30 as Time.Milli);

		// A time stretch holds a block back, and it is the media position video is paced against.
		// The shared transport never reports a playhead behind the last one it did, so a stale
		// queue cannot step video back onto audio already heard.
		ring.buffer.report(counters(10));
		take(ring, 10);
		expect(Time.Milli.fromMicro(ring.buffer.timestamp)).toBe(30 as Time.Milli);
		expect(ring.buffer.debug().queued).toBe(10);
	});

	it("changes generation when the ring re-anchors, and only then", () => {
		const ring = build(40);
		insertChunks(ring, 0, 40, 10);
		const first = ring.buffer.view().generation;

		// Neither dropping the tail a successor supersedes nor a deeper target replaces the timeline:
		// what the engine learned about the stream still describes it.
		ring.buffer.truncate(micro(30));
		ring.insert(30, 10);
		expect(ring.buffer.view().generation).toBe(first);

		ring.buffer.reset();
		insertChunks(ring, 5000, 40, 10);
		expect(ring.buffer.view().generation).not.toBe(first);
	});

	it("counts audio the writer threw away as too old", () => {
		const ring = build(40);
		insertChunks(ring, 0, 40, 10);
		take(ring, 30);

		ring.insert(0, 10);
		expect(ring.buffer.debug().discarded).toBe(10);
	});
});

describe.each(RINGS)("%s ring: a hole in the media", (_, build) => {
	it("steps the playhead over a hole the reader has already run dry on", () => {
		const ring = build(40);
		insertChunks(ring, 0, 40, 10);
		take(ring, 40);
		ring.buffer.view();
		ring.buffer.starve();

		// Media that never arrived: the reader covered for it, so queueing it as silence would make
		// a listener wait for the same missing audio twice.
		ring.insert(300, 10);
		expect(ring.buffer.length).toBe(10);
		expect(ring.buffer.debug().skips).toBe(1);
		expect(ring.buffer.debug().skipped).toBe(260);
		// The engine is told the playhead moved, so it can re-seed what it learned about the level.
		expect(ring.buffer.view().skipped).toBe(260);
	});

	it("keeps the silence for a hole in front of audio that still has to play", () => {
		const ring = build(40);
		insertChunks(ring, 0, 40, 10);

		ring.insert(60, 10);
		expect(ring.buffer.length).toBe(70);
		expect(ring.buffer.debug().skips).toBe(0);
	});
});

describe.each(RINGS)("%s ring: converging on the target", (_, build) => {
	it("judges a surplus on the new timeline after a re-anchor", () => {
		const ring = build(40);
		insertChunks(ring, 0, 40, 10);

		// A long run on one timeline, so the cursor and the window the floor opened are far out.
		let media = 40;
		for (let i = 0; i < 400; i++) {
			insertChunks(ring, media, 50, 10);
			media += 50;
			take(ring, 50);
		}

		ring.buffer.reset();
		insertChunks(ring, 100_000, 40, 10);
		take(ring, 10);
		// Copied: the postMessage ring refills one object on every call.
		const before = { ...ring.buffer.debug() };

		// The same surplus as a fresh ring: a window of the new timeline's playback is all it takes,
		// not a window the old timeline's cursor had run out to.
		media = 100_040;
		for (let i = 0; i < 40; i++) {
			insertChunks(ring, media, 100, 10);
			media += 100;
			take(ring, 50);
		}

		const after = ring.buffer.debug();
		expect(after.skipped + after.discarded).toBeGreaterThan(before.skipped + before.discarded);
	});

	it("holds a ring that is above its target but inside the band", () => {
		const ring = build(40);
		insertChunks(ring, 0, 40 + SKIP, 10);
		expect(ring.buffer.view().buffered).toBe(40 + SKIP);
		expect(ring.buffer.debug().skips).toBe(0);
	});

	it("drops back to the target once the surplus outlasts a window of playback", () => {
		const ring = build(40);
		insertChunks(ring, 0, 40, 10);
		take(ring, 10);

		// A hundred samples in for fifty out, every round: the trough climbs past the band and stays
		// there, which is a sender running faster than real time rather than a flush.
		let media = 40;
		let dropped = false;
		for (let i = 0; i < 40; i++) {
			insertChunks(ring, media, 100, 10);
			media += 100;
			take(ring, 50);
			if (ring.buffer.debug().skipped > 0 || ring.buffer.debug().discarded > 0) dropped = true;
		}

		expect(dropped).toBe(true);
		expect(ring.buffer.length).toBeLessThanOrEqual(ring.buffer.view().target + SKIP + 100);
	});
});

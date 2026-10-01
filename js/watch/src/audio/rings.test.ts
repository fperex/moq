import { describe, expect, it } from "bun:test";
import { Time } from "@moq/net";
import { type Ring, rings } from "./replay";

// What both ring transports do alike, run against each. The rate is 1000 unless a case says otherwise,
// so a sample is a millisecond.

/** Insert `samples` of `value` at `ms`. */
function insert(ring: Ring, ms: number, samples: number, value = 1): void {
	ring.insert(Time.Micro.fromMilli(ms as Time.Milli), [new Float32Array(samples).fill(value)]);
}

/** Insert `samples` as a run of `chunk`-sized inserts from `ms`, the way a decoder delivers them. */
function insertChunks(ring: Ring, ms: number, samples: number, chunk: number, value = 1): void {
	for (let i = 0; i < samples; i += chunk) insert(ring, ms + i, Math.min(chunk, samples - i), value);
}

/** Read a quantum of up to `samples`, returning what the ring handed over. */
function read(ring: Ring, samples: number): Float32Array {
	const output = [new Float32Array(samples)];
	return output[0].subarray(0, ring.buffer.read(output));
}

describe.each(rings(48000))("%s ring: the chunk above the target", (_, build) => {
	// The real shape a conference call has: 48kHz Opus in 20ms frames, and the lowest target the
	// estimator can report. The target counts the frame being played, the way NetEq's does, so the
	// ring holds 40ms and one arrival a few milliseconds late no longer finds it empty.

	it("un-stalls at the target plus a chunk, not at the target", () => {
		const ring = build(20);

		insert(ring, 0, 960);
		expect(ring.buffer.length).toBe(960);
		expect(ring.buffer.stalled).toBe(true);

		insert(ring, 20, 960);
		expect(ring.buffer.stalled).toBe(false);
	});

	it("plays a full quantum through a chunk that arrives ten milliseconds late", () => {
		const ring = build(20);
		// Feed it a chunk at a time and start playing the moment it says it is ready, which is what
		// the refill after a stall does. What it stops at is the whole question.
		for (let at = 0; ring.buffer.stalled; at += 20) insert(ring, at, 960);

		// Thirty milliseconds of render quanta with nothing arriving: the chunk due at 40ms is ten
		// late. A ring holding only the target would be empty ten milliseconds before it landed.
		for (let i = 0; i < Math.floor((48000 * 30) / 1000 / 128); i++) {
			expect(read(ring, 128).length).toBe(128);
		}
		expect(ring.buffer.underruns).toBe(0);
		expect(ring.buffer.stalled).toBe(false);
	});
});

describe.each(rings(1000))("%s ring: re-buffer", (_, build) => {
	it("re-stalls and refills to the hold level after running dry", () => {
		// A 40 sample target with 20 sample chunks: the ring holds 60, the target plus the chunk
		// being played.
		const ring = build(40);

		insertChunks(ring, 0, 60, 20);
		expect(ring.buffer.stalled).toBe(false);

		// Drain it.
		expect(read(ring, 60).length).toBe(60);
		expect(ring.buffer.length).toBe(0);

		// The next read finds nothing and parks playback rather than handing the worklet a quantum
		// of silence and trying again on the next one.
		expect(read(ring, 20).length).toBe(0);
		expect(ring.buffer.stalled).toBe(true);
		expect(ring.buffer.underruns).toBe(1);

		// Two chunks are still short of the level, so playback stays parked.
		insertChunks(ring, 60, 40, 20, 2);
		expect(ring.buffer.stalled).toBe(true);
		expect(read(ring, 20).length).toBe(0);

		// Reaching it resumes playback, and nothing buffered in the meantime was lost.
		insert(ring, 100, 20, 2);
		expect(ring.buffer.stalled).toBe(false);
		expect(read(ring, 60).length).toBe(60);
	});

	it("counts a quantum it could only partly fill as an underrun", () => {
		const ring = build(40);

		insertChunks(ring, 0, 60, 20);
		expect(read(ring, 50).length).toBe(50);

		// Ten samples remain against a quantum of twenty: the rest of the quantum is silence, which
		// is an underrun whether or not a chunk lands before the next read. It is not a stall: a
		// refill would cost the whole level to cover a gap shorter than one quantum.
		expect(read(ring, 20).length).toBe(10);
		expect(ring.buffer.stalled).toBe(false);
		expect(ring.buffer.underruns).toBe(1);

		// A chunk landing before the next read keeps playback going.
		insert(ring, 60, 20, 2);
		expect(read(ring, 20).length).toBe(20);
		expect(ring.buffer.underruns).toBe(1);
	});

	it("stall() parks playback without discarding what is buffered", () => {
		const ring = build(40);

		insertChunks(ring, 0, 60, 20);
		expect(read(ring, 20).length).toBe(20);

		// The target deepens, so playback parks until the ring holds the new depth.
		ring.setLatency(60);
		ring.buffer.stall();
		expect(ring.buffer.stalled).toBe(true);
		expect(read(ring, 20).length).toBe(0);
		expect(ring.buffer.length).toBe(40); // nothing was thrown away, unlike reset()

		insert(ring, 60, 20, 2);
		expect(ring.buffer.stalled).toBe(true); // 60 buffered, the ring holds 80

		insert(ring, 80, 20, 2);
		expect(ring.buffer.stalled).toBe(false);

		// Playback resumes on the same timeline: the samples buffered before the stall play first.
		const output = read(ring, 20);
		expect(output.length).toBe(20);
		expect(output[0]).toBe(1);
		expect(ring.buffer.underruns).toBe(0);
	});

	it("does not count an underrun while parked", () => {
		const ring = build(40);
		read(ring, 20);
		read(ring, 20);
		expect(ring.buffer.underruns).toBe(0);
	});
});

// A 30ms target with 10ms chunks: the ring holds 40ms, the target plus the chunk being played.
const TARGET = 30;
const CHUNK = 10;
const HOLD = TARGET + CHUNK;
const FILL = 90;

/** Insert `samples` from `ms` as chunks that each carry their index, so where playback starts shows. */
function numbered(ring: Ring, ms: number, samples: number): void {
	for (let i = 0; i < samples / CHUNK; i++) insert(ring, ms + i * CHUNK, CHUNK, i);
}

describe.each(rings(1000))("%s ring: trimming the first fill", (_, build) => {
	it("starts the playhead at the newest audio less the level it holds", () => {
		const ring = build(TARGET);
		numbered(ring, 0, FILL);

		// Nothing had been played, so the excess was dropped in silence rather than left for the
		// reader's time stretch to close over the seconds after a tune-in or an unmute.
		expect(ring.debug().trimmed).toBe(FILL - HOLD);
		expect(ring.buffer.length).toBe(HOLD);
		expect(ring.buffer.stalled).toBe(false);

		// Nothing else counted it: a trim is neither a reader skipping ahead nor a writer overflowing.
		expect(ring.debug().skips).toBe(0);
		expect(ring.debug().skipped).toBe(0);
		expect(ring.debug().discarded).toBe(0);
		expect(ring.buffer.underruns).toBe(0);

		// And the first read is the newest 40ms, which is chunk 5 onwards rather than chunk 0.
		const output = read(ring, HOLD);
		expect(output.length).toBe(HOLD);
		expect(output[0]).toBe((FILL - HOLD) / CHUNK);
	});

	it("leaves a fill that is already on the level it holds alone", () => {
		const ring = build(TARGET);
		numbered(ring, 0, HOLD);

		expect(ring.buffer.stalled).toBe(false);
		expect(ring.debug().trimmed).toBe(0);
		expect(read(ring, HOLD)[0]).toBe(0);
	});

	it("keeps a surplus once something has been played", () => {
		const ring = build(TARGET);
		numbered(ring, 0, FILL);

		// One block read is what makes the rest of the timeline the listener's: from here a surplus is
		// audio on its way to being heard, and the reader's time stretch is what closes it.
		expect(read(ring, CHUNK).length).toBe(CHUNK);
		const trimmed = ring.debug().trimmed;

		for (let i = 0; i < 5; i++) insert(ring, FILL + i * CHUNK, CHUNK, 9 + i);

		expect(ring.debug().trimmed).toBe(trimmed);
		expect(ring.buffer.length).toBeGreaterThan(HOLD);
	});
});

describe.each(rings(1000))("%s ring: a declared endpoint", (_, build) => {
	/** A ring the reader has played out and run dry on, which is where a declared pause finds it. */
	function drained(): Ring {
		const ring = build(TARGET);
		numbered(ring, 0, HOLD);
		expect(ring.buffer.stalled).toBe(false);
		expect(read(ring, HOLD).length).toBe(HOLD);
		read(ring, CHUNK); // nothing left: the reader parks
		expect(ring.buffer.stalled).toBe(true);
		return ring;
	}

	it("releases a stall on an empty ring", () => {
		const ring = drained();

		ring.buffer.end();

		// A stall waits for a refill and there is no refill coming, so it is a wait nothing can end.
		// The reader parks on the endpoint itself, which is the pause the publisher declared rather
		// than a gap to conceal.
		expect(ring.buffer.stalled).toBe(false);
		expect(ring.buffer.view().ended).toBe(true);
		expect(read(ring, CHUNK).length).toBe(0);
	});

	it("takes the endpoint back on an insert, and media after a played-out one is a fresh fill", () => {
		const ring = drained();
		ring.buffer.end();
		expect(ring.debug().fresh).toBe(false); // this timeline has been played

		const generation = ring.buffer.view().generation;

		// The publisher unmutes ten seconds later, and the relay serves more than the ring holds.
		numbered(ring, 10_000, FILL);

		expect(ring.buffer.view().ended).toBe(false);
		// Nothing of the resumed run has been heard, so the playhead starts on the newest audio and
		// the rest is dropped in silence rather than left for the reader to stretch across.
		expect(ring.debug().anchor).toBe(10_000);
		expect(ring.debug().fresh).toBe(true);
		expect(ring.buffer.view().generation).not.toBe(generation);
		expect(ring.debug().trimmed).toBe(FILL - HOLD);
		expect(ring.buffer.length).toBe(HOLD);
		expect(ring.buffer.stalled).toBe(false);
		expect(read(ring, HOLD)[0]).toBe((FILL - HOLD) / CHUNK);
	});
});

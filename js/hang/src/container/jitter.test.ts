import { describe, expect, it } from "bun:test";
import { Time } from "@moq/net";
import { Jitter } from "./jitter";
import { load, replay } from "./jitter.vectors.ts";

const FRAME = 20;
const START = 80;

/** Feed one arrival, in milliseconds on both axes. */
function observe(jitter: Jitter, media: number, arrival: number, reordered?: boolean): void {
	jitter.observe(Time.Micro.fromMilli(media as Time.Milli), arrival as Time.Milli, reordered);
}

/**
 * A sender emitting one frame every `frame` ms, holding `burst - 1` of them back and flushing the
 * whole run at once. `burst` of 1 is an evenly paced sender.
 *
 * Returns the media timestamp one past the last frame, so a caller can keep the timeline going.
 */
function flush(
	jitter: Jitter,
	options: { frames: number; burst?: number; base?: number; start?: number; frame?: number },
): number {
	const { frames, burst = 1, base = 50, start = 0, frame = FRAME } = options;
	let held: number[] = [];

	for (let i = 0; i < frames; i++) {
		const media = start + i * frame;
		held.push(media);
		if (held.length < burst) continue;
		for (const m of held) observe(jitter, m, media + base);
		held = [];
	}

	return start + frames * frame;
}

describe("tune-in", () => {
	// The regression that closed PR #3517. Its estimator learned a "frame duration" from the gap
	// between consecutive timestamps, so the very first gap set it with nothing to validate against
	// and a viewer read a 14.56s buffer. Written first, and it reads 14560 on that estimator.
	it("does not inflate from a stale frame followed by the live edge", () => {
		const jitter = new Jitter();

		observe(jitter, 0, 0);
		observe(jitter, 14_560, 5);
		expect(jitter.value.peek()).toBeLessThanOrEqual(2000 as Time.Milli);

		// Ten seconds of perfectly paced audio with no real jitter at all.
		let max = Time.Milli.zero;
		for (let i = 1; i <= 500; i++) {
			observe(jitter, 14_560 + i * FRAME, 5 + i * FRAME);
			max = Time.Milli.max(max, jitter.value.peek());
		}

		expect(max).toBeLessThanOrEqual(2000 as Time.Milli);
		expect(jitter.value.peek()).toBeLessThanOrEqual(100 as Time.Milli);
	});

	it("starts at the cold-start guess", () => {
		expect(new Jitter().value.peek()).toBe(START as Time.Milli);
	});

	it("starts at what the publisher declares it flushes", () => {
		// The TS importer advertises 302ms on the bbb sources. A declaration is a measurement of the
		// same quantity by the party that already knows it, so it is where the estimate starts.
		expect(new Jitter({ start: 302 as Time.Milli }).value.peek()).toBe(320 as Time.Milli);
	});

	it("never starts below the cold-start guess", () => {
		// A browser publisher declares its 20ms frame duration. The network still adds to that, and
		// nothing has been measured yet, so the guess stands.
		expect(new Jitter({ start: 20 as Time.Milli }).value.peek()).toBe(START as Time.Milli);
		expect(new Jitter({ start: Time.Milli.zero }).value.peek()).toBe(START as Time.Milli);
	});

	it("never starts above the histogram's range", () => {
		// A publisher declaring more than the estimator can ever measure would otherwise name a
		// target no observation could bring down.
		expect(new Jitter({ start: 9000 as Time.Milli }).value.peek()).toBe(Jitter.CEILING as Time.Milli);
	});

	it("falls from a declared start to what it measures", () => {
		// The declaration is a prior, not a floor: a path that turns out to be clean walks the
		// target down to the same bucket the unseeded estimator settles on, at the ordinary bound.
		const jitter = new Jitter({ start: 302 as Time.Milli });
		expect(jitter.value.peek()).toBe(320 as Time.Milli);

		// 20s of evenly paced frames, which is more than the fall bound needs from 320ms.
		flush(jitter, { frames: 1000 });
		expect(jitter.value.peek()).toBe(Jitter.BUCKET as Time.Milli);
	});

	it("holds a declared start for as long as the fall bound says", () => {
		// One second of clean arrivals cannot undo a 320ms start: the bound is a sixth of the
		// distance per second, so a viewer never has the buffer pulled out from under them.
		const jitter = new Jitter({ start: 302 as Time.Milli });
		flush(jitter, { frames: 50 });
		expect(jitter.value.peek()).toBeGreaterThanOrEqual(280 as Time.Milli);
	});
});

describe("steady state", () => {
	it("converges from the cold start to one bucket", () => {
		const jitter = new Jitter();
		expect(jitter.value.peek()).toBe(START as Time.Milli);

		flush(jitter, { frames: 500 });
		expect(jitter.value.peek()).toBe(Jitter.BUCKET as Time.Milli);
	});

	it("does not follow the absolute path delay", () => {
		// A sender on the other side of the planet is not a jittery sender. This is exactly what an
		// RTT-derived buffer gets wrong, and why the two terms are not interchangeable.
		const near = new Jitter();
		const far = new Jitter();
		flush(near, { frames: 500, base: 10 });
		flush(far, { frames: 500, base: 2010 });
		expect(far.value.peek()).toBe(near.value.peek());
	});

	it("reads a publisher's flush span", () => {
		// Seven AAC frames per PES, which is what the public relay serves. 120ms of spread reads as
		// the bucket above it.
		const jitter = new Jitter();
		flush(jitter, { frames: 700, burst: 7 });
		expect(jitter.value.peek()).toBe(140 as Time.Milli);
	});

	it("sees a slow build-up an inter-arrival estimator cannot", () => {
		// Each frame is 2ms later than the last, so consecutive deltas are 2ms while the delay the
		// buffer has to absorb climbs to 200ms.
		const jitter = new Jitter();
		for (let i = 0; i < 300; i++) {
			observe(jitter, i * FRAME, i * FRAME + 50 + Math.min(i, 100) * 2);
		}
		expect(jitter.value.peek()).toBeGreaterThan(100 as Time.Milli);
	});
});

describe("reordering", () => {
	it("excludes an arrival that is not strictly newer", () => {
		const paced = new Jitter();
		const swapped = new Jitter();

		flush(paced, { frames: 300 });

		// The same path, except every tenth frame loses a race with its successor. The successor
		// keeps its own arrival time, so nothing about the path changed.
		for (let i = 0; i < 300; i++) {
			const media = i * FRAME;
			if (i % 10 === 9) continue;
			if (i % 10 === 8) {
				observe(swapped, media + FRAME, media + FRAME + 50);
				observe(swapped, media, media + FRAME + 51);
				observe(swapped, media, media + 50);
				continue;
			}
			observe(swapped, media, media + 50);
		}

		expect(swapped.value.peek()).toBe(paced.value.peek());
	});

	it("takes an explicit reordered flag even when the timestamp is newer", () => {
		const jitter = new Jitter();
		flush(jitter, { frames: 500 });
		const settled = jitter.value.peek();

		// A frame the caller already knows arrived out of order. Half a second late, so it would
		// otherwise raise the target by a lot.
		observe(jitter, 500 * FRAME, 500 * FRAME + 550, true);
		expect(jitter.value.peek()).toBe(settled);
	});
});

describe("the receiver's own reading gap", () => {
	it("does not read a blocked read loop as path delay", () => {
		// A tune-in blocks the main thread on a decoder polyfill, a worklet start and the first
		// keyframe. Nothing about the path changes: the frames land on time and queue, and the read
		// loop stamps every one of them when it runs again. Measured against a reference from before
		// the block the first one out of the queue reads as the whole block.
		const jitter = new Jitter();
		flush(jitter, { frames: 200, burst: 7 });

		const settled = jitter.value.peek();
		expect(settled).toBe(140 as Time.Milli);

		const BLOCK = 1500;
		const DRAIN = 3;
		const blocked = 200 * FRAME;

		let cursor = blocked + BLOCK;
		let max = settled;
		let recovered: number | undefined;

		for (let i = 200; i < 1200; i++) {
			const media = i * FRAME;

			// Read at the later of when the frame landed and when the loop got to it.
			const read = Math.max(media + 50, cursor);
			cursor = read + DRAIN;
			observe(jitter, media, read);

			const value = jitter.value.peek();
			max = Time.Milli.max(max, value);
			if (recovered === undefined && value <= settled) recovered = read;
		}

		expect(max).toBeLessThanOrEqual((settled + 2 * Jitter.BUCKET) as Time.Milli);
		expect(recovered).toBeLessThanOrEqual(blocked + BLOCK + 5000);
	});

	it("still measures a publisher slower than the resample interval", () => {
		// One frame a second is idle for longer than the resample interval on every single arrival,
		// so a rule that only looked at how long the loop was idle would throw the whole track away.
		// What says the receiver was reading is that the timeline advanced as far as the wall clock
		// did, which is true here and false for a backlog.
		const jitter = new Jitter();

		for (let i = 0; i < 10; i++) observe(jitter, i * 1000, i * 1000 + 50);
		expect(jitter.value.peek()).toBeLessThanOrEqual(Jitter.BUCKET as Time.Milli);

		// From here every other frame is 400ms late. The receiver was reading throughout: each
		// arrival covers as much media as the wall clock moved, give or take the path's own jitter,
		// which is the 400ms the buffer has to hold.
		for (let i = 10; i < 60; i++) {
			observe(jitter, i * 1000, i * 1000 + 50 + (i % 2 === 1 ? 400 : 0));
		}

		expect(jitter.value.peek()).toBeGreaterThanOrEqual(400 as Time.Milli);
	});
});

describe("the histogram", () => {
	it("drops an observation past its range instead of clamping it", () => {
		const jitter = new Jitter();
		flush(jitter, { frames: 500 });
		const settled = jitter.value.peek();

		// The path stalls 2500ms and keeps the loss, so the next arrivals read past the 2000ms
		// range. Clamping them into the last bucket would pin the target at 2000ms.
		let max: Time.Milli = settled;
		for (let i = 500; i < 700; i++) {
			observe(jitter, i * FRAME, i * FRAME + 50 + 2500);
			max = Time.Milli.max(max, jitter.value.peek());
		}
		expect(max).toBeLessThanOrEqual(settled);
	});

	it("forgets once per resampled observation, not once per arrival", () => {
		// Two senders with the same 120ms flush span but three times apart in frame rate: 20ms
		// frames flushed seven at a time, and 60ms frames flushed three at a time. A factor applied
		// per arrival would forget the burst three times faster for the denser one; applied per
		// resampled observation it is a wall-clock time constant, so both land in the same place
		// after the same four seconds of clean audio.
		const dense = new Jitter();
		const sparse = new Jitter();

		flush(dense, { frames: 100, burst: 7 });
		flush(sparse, { frames: 36, burst: 3, frame: 60 });
		expect(sparse.value.peek()).toBe(dense.value.peek());

		flush(dense, { frames: 200, start: 100 * FRAME });
		flush(sparse, { frames: 67, frame: 60, start: 36 * 60 });
		expect(sparse.value.peek()).toBe(dense.value.peek());
	});

	it("ramps the forget factor so a cold start converges in seconds", () => {
		// Four seconds of clean audio is 8 observations. Without the ramp the seeded 0.5^(i+1) prior
		// still holds most of the mass after 8 decays of 0.983, and the quantile needs about 134 of
		// them, more than a minute, before it reaches the first bucket.
		const jitter = new Jitter();
		flush(jitter, { frames: 200 });
		expect(jitter.value.peek()).toBe(Jitter.BUCKET as Time.Milli);
	});
});

describe("pauses", () => {
	it("decays across a gap with no arrivals", () => {
		// The same stream twice: once interrupted for ten seconds, once not. A histogram that only
		// decays on an arrival would come out of the gap holding exactly what it went in with, so
		// the two would agree.
		const paused = new Jitter();
		const uninterrupted = new Jitter();

		for (const [jitter, gap] of [
			[paused, 10_000],
			[uninterrupted, 0],
		] as const) {
			flush(jitter, { frames: 200, burst: 7 });
			flush(jitter, { frames: 300, start: 200 * FRAME + gap });
		}

		expect(paused.value.peek()).toBeLessThan(uninterrupted.value.peek());
	});

	it("caps the catch-up so a very long gap costs no more than a long one", () => {
		const long = new Jitter();
		const longer = new Jitter();

		for (const [jitter, gap] of [
			[long, 30_000],
			[longer, 600_000],
		] as const) {
			flush(jitter, { frames: 200, burst: 7 });
			const resume = 200 * FRAME + gap;
			observe(jitter, resume, resume + 50);
			observe(jitter, resume + FRAME, resume + FRAME + 50);
		}

		expect(longer.value.peek()).toBe(long.value.peek());
	});
});

describe("rise and fall", () => {
	it("rises as soon as an arrival proves the buffer is too shallow", () => {
		const jitter = new Jitter();
		flush(jitter, { frames: 500 });
		expect(jitter.value.peek()).toBe(Jitter.BUCKET as Time.Milli);

		// One second of 7-frame bursts, two resample intervals, takes it straight to the span.
		flush(jitter, { frames: 56, burst: 7, start: 500 * FRAME });
		expect(jitter.value.peek()).toBe(140 as Time.Milli);
	});

	it("falls no faster than one bucket per second while it is close", () => {
		const jitter = new Jitter();
		flush(jitter, { frames: 100, burst: 7 });

		const from = jitter.value.peek();
		expect(from).toBe(140 as Time.Milli);

		const start = 100 * FRAME;
		const anchor = start + 50;
		let previous = from;

		for (let i = 0; i < 1000; i++) {
			const media = start + i * FRAME;
			observe(jitter, media, media + 50);

			const value = jitter.value.peek();
			expect(value).toBeLessThanOrEqual(previous);
			expect(from - value).toBeLessThanOrEqual(Math.floor((media + 50 - anchor) / 1000) * Jitter.BUCKET);
			previous = value;
		}

		expect(jitter.value.peek()).toBe(Jitter.BUCKET as Time.Milli);
	});

	it("closes a large overshoot without taking a second per bucket", () => {
		// The path degrades 30ms a frame for a second, which the estimator reads as the delay it is,
		// and then flushes what it queued. The quantile comes down in whole handfuls of buckets as
		// the histogram forgets, and a fixed step cannot follow it: 1480ms at a bucket a second is
		// 74 seconds, well past the 29 seconds the histogram remembers why it went up.
		const jitter = new Jitter();
		flush(jitter, { frames: 500 });

		const degraded = 500 * FRAME;
		for (let i = 0; i < 50; i++) {
			const media = degraded + i * FRAME;
			observe(jitter, media, media + 50 + i * 30);
		}
		expect(jitter.value.peek()).toBeGreaterThan(1000 as Time.Milli);

		// The queue drains at 3ms a frame and the path is clean again from there.
		const recovering = degraded + 50 * FRAME;
		let cursor = recovering + 50 + 49 * 30;
		let settled: number | undefined;

		for (let i = 0; i < 4000; i++) {
			const media = recovering + i * FRAME;
			const read = Math.max(media + 50, cursor);
			cursor = read + 3;
			observe(jitter, media, read);

			if (settled === undefined && jitter.value.peek() === Jitter.BUCKET) settled = read;
		}

		expect(settled).toBeDefined();
		expect((settled as number) - recovering).toBeLessThan(45_000);
	});
});

describe("re-anchoring", () => {
	it("keeps the distribution and drops the reference", () => {
		const jitter = new Jitter();
		flush(jitter, { frames: 700, burst: 7 });
		const settled = jitter.value.peek();
		expect(settled).toBe(140 as Time.Milli);

		// The timeline rewinds to zero. Without dropping the reference every arrival after the
		// rewind would read as hours of delay; without keeping the histogram the target would fall
		// back to the cold-start guess.
		jitter.reanchor();
		flush(jitter, { frames: 56, burst: 7 });
		expect(jitter.value.peek()).toBe(settled);
	});

	it("does not treat a rewound timestamp as reordered forever", () => {
		const jitter = new Jitter();
		flush(jitter, { frames: 500, start: 100_000 });

		jitter.reanchor();
		flush(jitter, { frames: 500 });
		expect(jitter.value.peek()).toBe(Jitter.BUCKET as Time.Milli);
	});
});

describe("conformance", () => {
	const corpus = load();

	for (const entry of corpus.cases) {
		it(`${entry.name}: ${entry.description}`, () => {
			expect(replay(entry.arrivals, entry.start_ms)).toEqual(entry.target_ms);
		});
	}
});

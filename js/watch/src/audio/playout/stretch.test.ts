import { describe, expect, it } from "bun:test";
import { Decision } from "./decision";
import { antiphase, buzz, dominant, energy, maxStep, noise, tone, zeroRun } from "./fixture";
import {
	CORRELATION,
	CORRELATION_FAST,
	DECIMATED,
	frames,
	MAX_LAG,
	peak,
	SEARCH,
	STRETCH_BOUND,
	Stretch,
} from "./index";
import { Floor, Level } from "./level";
import { Noise } from "./noise";
import { Sync } from "./sync";

const RATES = [48000, 44100];

/** A tone's steepest slope per sample, which a clean splice never exceeds. */
function slope(rate: number, frequency: number, amplitude: number): number {
	return (amplitude * 2 * Math.PI * frequency) / rate;
}

/** Scratch output planes wide enough for anything either operation writes. */
function planes(channels: number, length: number): Float32Array[] {
	return Array.from({ length: channels }, () => new Float32Array(length));
}

describe("pitch search", () => {
	it("finds the pitch period of a tone", () => {
		for (const rate of RATES) {
			const [pcm] = tone(rate, 0.1, 200, 0.5);
			const found = peak(pcm.subarray(0, frames(rate, SEARCH + MAX_LAG)), rate, SEARCH);
			const period = rate / 200;
			// One decimated sample, which is what the coarse search can resolve.
			const tolerance = rate / DECIMATED;
			expect(Math.abs(found - period)).toBeLessThanOrEqual(tolerance);
		}
	});

	it("prefers the fundamental over its multiples", () => {
		// 400Hz has a 2.5ms period, so 5ms and 7.5ms correlate just as well. Concealment repeats the
		// lag verbatim and fast accelerate folds it back up, so both want the shortest one.
		const rate = 48000;
		const [pcm] = tone(rate, 0.1, 400, 0.5);
		const found = peak(pcm.subarray(0, frames(rate, SEARCH + MAX_LAG)), rate, SEARCH);
		expect(Math.abs(found - rate / 400)).toBeLessThanOrEqual(rate / DECIMATED);
	});
});

describe("accelerate", () => {
	it("keeps the tone and drops one period", () => {
		for (const rate of RATES) {
			const input = tone(rate, 0.05, 997, 0.5);
			const length = frames(rate, 30);
			const stretch = new Stretch(rate, 1);
			const quiet = new Noise(1);
			const out = planes(1, length);

			const removed = stretch.accelerate(input, length, quiet, false, out);
			expect(removed).toBeGreaterThan(0);

			const played = out[0].subarray(0, length - removed);
			const found = dominant(played, rate, 900, 1100);
			expect(Math.abs(found - 997)).toBeLessThan(9.97);
			expect(zeroRun(played)).toBeLessThanOrEqual(2);
			expect(maxStep(played)).toBeLessThan(1.5 * slope(rate, 997, 0.5));
		}
	});

	it("leaves loud aperiodic audio alone", () => {
		const rate = 48000;
		const input = noise(rate, 0.03, 0.5);
		const length = frames(rate, 30);
		const stretch = new Stretch(rate, 1);
		const quiet = new Noise(1);

		const found = stretch.analyse(input, length, quiet);
		expect(found.active).toBe(true);
		expect(found.correlation).toBeLessThan(CORRELATION);

		const out = planes(1, length);
		out[0][0] = 42;
		expect(stretch.accelerate(input, length, quiet, false, out)).toBe(0);
		expect(stretch.preemptiveExpand(input, length, 0, quiet, out)).toBe(0);
		expect(out[0][0]).toBe(42); // a skipped block must not touch the output
	});

	it("stretches passive noise without a correlation", () => {
		const rate = 48000;
		// -60 dBFS, three orders of magnitude under the background floor, so the gate calls it
		// passive however uncorrelated it is.
		const input = noise(rate, 0.03, 0.001);
		const length = frames(rate, 30);
		const stretch = new Stretch(rate, 1);
		const quiet = new Noise(1);

		const found = stretch.analyse(input, length, quiet);
		expect(found.active).toBe(false);
		expect(found.correlation).toBeLessThan(CORRELATION_FAST);

		expect(stretch.accelerate(input, length, quiet, false, planes(1, length))).toBeGreaterThan(0);
	});

	it("accepts half the correlation and folds the period in fast mode", () => {
		const rate = 48000;
		const input = buzz(rate, 0.03, 3, 0.4, 0.28);
		const length = frames(rate, 30);
		const stretch = new Stretch(rate, 1);
		const quiet = new Noise(1);

		const found = stretch.analyse(input, length, quiet);
		expect(found.active).toBe(true);
		expect(found.correlation).toBeGreaterThan(CORRELATION_FAST);
		expect(found.correlation).toBeLessThanOrEqual(CORRELATION);

		expect(stretch.accelerate(input, length, quiet, false, planes(1, length))).toBe(0);

		const removed = stretch.accelerate(input, length, quiet, true, planes(1, length));
		const folded = Math.floor(stretch.maxLag / found.lag) * found.lag;
		expect(removed).toBe(folded);
		expect(removed).toBeGreaterThanOrEqual(2 * found.lag);
	});
});

describe("preemptive expand", () => {
	it("keeps the tone and adds one period", () => {
		for (const rate of RATES) {
			const input = tone(rate, 0.05, 997, 0.5);
			const length = frames(rate, 30);
			const stretch = new Stretch(rate, 1);
			const quiet = new Noise(1);
			const out = planes(1, length + stretch.maxLag);

			const inserted = stretch.preemptiveExpand(input, length, 0, quiet, out);
			expect(inserted).toBeGreaterThan(0);

			const played = out[0].subarray(0, length + inserted);
			const found = dominant(played, rate, 900, 1100);
			expect(Math.abs(found - 997)).toBeLessThan(9.97);
			expect(zeroRun(played)).toBeLessThanOrEqual(2);
			expect(maxStep(played)).toBeLessThan(1.5 * slope(rate, 997, 0.5));
		}
	});

	it("refuses active speech spliced past the splice point", () => {
		// NetEq will not move the splice further than 15ms in, because everything before it has
		// already been played and cannot be faded into.
		const rate = 48000;
		const input = tone(rate, 0.05, 997, 0.5);
		const length = frames(rate, 30);
		const stretch = new Stretch(rate, 1);
		const quiet = new Noise(1);

		expect(stretch.preemptiveExpand(input, length, stretch.maxLag + 1, quiet, planes(1, length * 2))).toBe(0);
		expect(stretch.preemptiveExpand(input, length, stretch.maxLag, quiet, planes(1, length * 2))).toBeGreaterThan(
			0,
		);
	});
});

describe("stereo", () => {
	it("stays antiphase through both operations", () => {
		const rate = 48000;
		const input = antiphase(rate, 0.05, 997, 0.5);
		const length = frames(rate, 30);
		const stretch = new Stretch(rate, 2);
		const quiet = new Noise(2);

		for (const [operation, out] of [
			["accelerate", planes(2, length)],
			["expand", planes(2, length + stretch.maxLag)],
		] as const) {
			const moved =
				operation === "accelerate"
					? stretch.accelerate(input, length, quiet, false, out)
					: stretch.preemptiveExpand(input, length, 0, quiet, out);
			expect(moved).toBeGreaterThan(0);

			const played = operation === "accelerate" ? length - moved : length + moved;
			const sum = new Float32Array(played);
			for (let i = 0; i < played; i++) sum[i] = out[0][i] + out[1][i];
			expect(energy(sum)).toBeLessThan(1e-12);
		}
	});
});

describe("background noise", () => {
	it("reports the floor before it learns anything", () => {
		const estimate = new Noise(1);
		expect(estimate.initialised).toBe(false);
		expect(estimate.energy(0)).toBeGreaterThan(0);
	});

	it("converges on noise but not on a tone", () => {
		const rate = 48000;
		const level = 0.01;
		const room = new Noise(1);
		const [pcm] = noise(rate, 1, level);
		for (let i = 256; i <= pcm.length; i += 256) room.update([pcm.subarray(i - 256, i)], 256);
		expect(room.initialised).toBe(true);

		// White noise at amplitude `level` has mean energy level^2 / 3.
		const expected = (level * level) / 3;
		expect(room.energy(0) / expected).toBeGreaterThan(0.5);
		expect(room.energy(0) / expected).toBeLessThan(2);

		const held = new Noise(1);
		const [sine] = tone(rate, 1, 997, 0.01);
		for (let i = 256; i <= sine.length; i += 256) held.update([sine.subarray(i - 256, i)], 256);
		expect(held.initialised).toBe(false);
	});
});

describe("buffer level filter", () => {
	it("follows the target's smoothing factor", () => {
		const fast = new Level();
		fast.target(20);
		const slow = new Level();
		slow.target(1000);

		for (let i = 0; i < 10; i++) {
			fast.update(4800, 0);
			slow.update(4800, 0);
		}
		expect(fast.filtered).toBeGreaterThan(slow.filtered);
	});

	it("subtracts a time stretch exactly once", () => {
		const level = new Level();
		level.set(960);
		level.update(960, 240);
		expect(level.filtered).toBe(720);
		level.update(720, 0);
		expect(level.filtered).toBe(720);
	});

	it("never goes negative", () => {
		const level = new Level();
		level.set(100);
		level.update(100, 10_000);
		expect(level.filtered).toBe(0);
	});
});

describe("the sustained depth", () => {
	it("reports the trough between two flushes, not the peak", () => {
		const floor = new Floor();
		// A publisher flushing five frames at once: the ring peaks by the whole flush and drains
		// back to the target before the next one lands.
		let at = 0;
		let sustained = 0;
		for (let flush = 0; flush < 20; flush++) {
			for (const depth of [500, 400, 300, 200, 100]) {
				sustained = floor.observe(depth, at, 500);
				at += 100;
			}
		}
		expect(sustained).toBe(100);
	});

	it("reports the first depth it sees, having nothing to compare it against", () => {
		expect(new Floor().observe(900, 0, 500)).toBe(900);
	});

	it("follows a surplus that outlasts the window", () => {
		const floor = new Floor();
		let sustained = 0;
		for (let at = 0; at < 4000; at += 100) sustained = floor.observe(at < 1000 ? 100 : 900, at, 500);
		expect(sustained).toBe(900);
	});
});

describe("the output block", () => {
	it("hands back what it was given, and keeps the history a splice needs", () => {
		const block = new Sync(1, 4, 8);
		block.push([Float32Array.from([1, 2, 3, 4, 5, 6])], 0, 6);
		expect(block.queued).toBe(6);

		const out = [new Float32Array(4)];
		block.pull(out, 0, 4);
		expect([...out[0]]).toEqual([1, 2, 3, 4]);
		expect(block.queued).toBe(2);

		const borrowed = [new Float32Array(4)];
		expect(block.borrow(borrowed, 4)).toBe(4);
		expect([...borrowed[0]]).toEqual([1, 2, 3, 4]);

		// A truncate drops what is still queued and leaves the history behind the cursor alone.
		block.truncate();
		expect(block.queued).toBe(0);
		expect(block.borrow(borrowed, 4)).toBe(4);
		expect([...borrowed[0]]).toEqual([1, 2, 3, 4]);
	});

	it("forgets played audio past the history rather than growing", () => {
		const block = new Sync(1, 4, 8);
		const out = [new Float32Array(4)];
		for (let i = 0; i < 100; i++) {
			block.push([Float32Array.from([i, i, i, i])], 0, 4);
			block.pull(out, 0, 4);
		}
		// The history, plus the pull that has not been compacted away yet.
		expect(block.played).toBeLessThanOrEqual(8);
	});
});

describe("decision", () => {
	const RATE = 48000;
	const TARGET = frames(RATE, 100);
	const CHUNK = frames(RATE, 20);
	// low = target, high = target + chunk + 20ms.
	const HIGH = TARGET + CHUNK + frames(RATE, 20);

	/** A decision that has adopted `buffered` as its level, so the next call rules on that alone. */
	function seeded(buffered: number): Decision {
		const decision = new Decision(RATE);
		decision.decide({ buffered, queued: 0, target: TARGET, chunk: CHUNK, outputFrame: 0 });
		return decision;
	}

	function decide(decision: Decision, buffered: number, outputFrame = 0) {
		return decision.decide({ buffered, queued: 0, target: TARGET, chunk: CHUNK, outputFrame });
	}

	it("plays normally inside the band", () => {
		expect(decide(seeded(TARGET), TARGET)).toBe("normal");
		expect(decide(seeded(HIGH - 1), HIGH - 1)).toBe("normal");
	});

	it("accelerates at the upper limit and fast accelerates four times past it", () => {
		expect(decide(seeded(HIGH), HIGH)).toBe("accelerate");
		expect(decide(seeded(4 * HIGH - 1), 4 * HIGH - 1)).toBe("accelerate");
		expect(decide(seeded(4 * HIGH), 4 * HIGH)).toBe("fast-accelerate");
	});

	it("expands below the target but not below half of it", () => {
		expect(decide(seeded(TARGET - 1), TARGET - 1)).toBe("expand");
		expect(decide(seeded(TARGET / 2), TARGET / 2)).toBe("expand");
		// Below half the target the ring is refilling, and holding audio back would fight the refill.
		expect(decide(seeded(TARGET / 2 - 1), TARGET / 2 - 1)).toBe("normal");
	});

	it("holds a cooldown of a hundred milliseconds of output", () => {
		// One sample, so the level the operation removes cannot take the buffer back inside the band
		// on its own and the cooldown is the only thing deciding.
		const decision = seeded(HIGH + 1);
		expect(decide(decision, HIGH + 1)).toBe("accelerate");
		decision.applied(1, 0);

		const cooldown = frames(RATE, 100);
		expect(decide(decision, HIGH + 1, cooldown - 1)).toBe("normal");
		expect(decide(decision, HIGH + 1, cooldown)).toBe("accelerate");
	});

	it("subtracts what an operation moved instead of acting on it twice", () => {
		const decision = seeded(HIGH);
		expect(decide(decision, HIGH)).toBe("accelerate");

		// The samples are gone from the buffer the moment the splice lands, but the ring is only
		// read a quantum at a time, so the raw level still shows them.
		decision.applied(frames(RATE, 15), 0);
		expect(decide(decision, HIGH, 1)).toBe("normal");
	});

	it("lets a fast accelerate through the cooldown", () => {
		// The buffer is already so far past target that a listener hears every word late; waiting
		// out the cooldown is exactly what would prolong it.
		const decision = seeded(5 * HIGH);
		decision.applied(1, 0);
		expect(decide(decision, 5 * HIGH, 1)).toBe("fast-accelerate");
	});

	it("adopts the level again after a discontinuity", () => {
		const decision = seeded(4 * HIGH);
		expect(decide(decision, 4 * HIGH)).toBe("fast-accelerate");

		decision.discontinuity();
		// The filter would take a second to walk down from four times the limit; a flush means the
		// level never drifted there, so the next observation replaces it.
		expect(decide(decision, TARGET)).toBe("normal");
	});
});

describe("the stretch bound", () => {
	it("is what the cooldown and the maximum operation can close in half a second", () => {
		// One 15ms pitch period per 100ms of output, five times over.
		expect(STRETCH_BOUND).toBe(MAX_LAG * 5);
	});
});

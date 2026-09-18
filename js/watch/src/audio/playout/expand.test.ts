import { describe, expect, it } from "bun:test";
import { BLOCK } from "./decision";
import { Expand, MAX_CONSECUTIVE_EXPANDS, voiceMix } from "./expand";
import { antiphase, dominant, energy, goertzel, maxStep, tone, noise as white, zeroRun } from "./fixture";
import { Merge } from "./merge";
import { frames } from "./stretch";

const RATE = 48000;

/** Concealment primed on the tail of `history`, ready to produce blocks. */
function primed(history: Float32Array[], channels: number): Expand {
	const expand = new Expand(RATE, channels, BLOCK);
	const length = history[0].length;
	expand.analyse(
		history.map((plane) => plane.subarray(length - expand.history)),
		expand.history,
	);
	return expand;
}

/** `count` blocks of concealment, concatenated per channel. */
function conceal(expand: Expand, count: number, channels = 1): Float32Array[] {
	const out = Array.from({ length: channels }, () => new Float32Array(expand.block * count));
	const block = Array.from({ length: channels }, () => new Float32Array(expand.block));

	for (let i = 0; i < count; i++) {
		expand.process(block, 0);
		for (let channel = 0; channel < channels; channel++) {
			out[channel].set(block[channel], i * expand.block);
		}
	}
	return out;
}

describe("the voice mix", () => {
	it("is the cubic from expand.cc, clamped", () => {
		// A perfectly periodic signal is all period and no noise.
		expect(voiceMix(1)).toBe(1);
		// And one that barely repeats is nearly all noise. The cubic is only consulted above 0.48,
		// where it is still positive.
		expect(voiceMix(0.5)).toBeGreaterThan(0);
		expect(voiceMix(0.5)).toBeLessThan(0.5);
		expect(voiceMix(0.48)).toBeLessThan(voiceMix(0.6));
	});
});

describe("concealment", () => {
	it("holds the pitch of a tone and fades it out", () => {
		const expand = primed(tone(RATE, 0.05, 997, 0.5), 1);
		const blocks: Float32Array[] = [];
		const block = [new Float32Array(expand.block)];
		for (let i = 0; i < 20; i++) {
			expand.process(block, 0);
			blocks.push(block[0].slice());
		}

		const first = energy(blocks[0]);
		let previous = Number.MAX_VALUE;
		for (const produced of blocks) {
			const level = energy(produced);
			// Every block is quieter than the last, all the way down.
			expect(level).toBeLessThanOrEqual(previous * 1.05);
			previous = level;

			// And while it is still loud it is still the tone. Further down the unvoiced part has
			// taken over, which is what a fade is supposed to sound like.
			if (level > first / 100) {
				const signal = goertzel(produced, RATE, 997);
				const off = goertzel(produced, RATE, 1600);
				expect(signal).toBeGreaterThan(8 * off);
			}
		}

		const all = new Float32Array(blocks.length * expand.block);
		for (const [index, produced] of blocks.entries()) all.set(produced, index * expand.block);
		expect(Math.abs(dominant(all, RATE, 900, 1100) - 997)).toBeLessThan(9.97);

		// The muting slope reaches zero well inside the ceiling, so the tail is digital silence.
		expect(energy(blocks[blocks.length - 1])).toBe(0);
	});

	it("plays silence from the ceiling on, whatever the room sounds like", () => {
		// A room the estimator would happily have reported: with comfort noise this block came back
		// at the room's own level and never stopped.
		const expand = primed(tone(RATE, 0.05, 997, 0.5), 1);
		// The ceiling is NetEq's 200 blocks of 10ms, which is 100 of this engine's 20ms blocks.
		conceal(expand, MAX_CONSECUTIVE_EXPANDS);
		expect(expand.exhausted).toBe(true);

		const [after] = conceal(expand, 50);
		expect(energy(after)).toBe(0);
		expect(after.every((sample) => sample === 0)).toBe(true);
	});

	it("fades a long outage to digital silence rather than buzzing on", () => {
		const expand = primed(tone(RATE, 0.05, 997, 0.5), 1);

		const [produced] = conceal(expand, MAX_CONSECUTIVE_EXPANDS);
		const tail = produced.subarray(produced.length - frames(RATE, 1000));
		expect(energy(tail)).toBe(0);

		// And it got there smoothly: the last audible sample is small enough that stopping is not
		// a click.
		const last = produced.findLastIndex((sample) => sample !== 0);
		expect(last).toBeGreaterThan(0);
		expect(Math.abs(produced[last])).toBeLessThan(0.01);
		expect(maxStep(produced)).toBeLessThan(maxStep(tone(RATE, 0.05, 997, 0.5)[0]) * 1.5);
	});

	it("plays silence when it has nothing to repeat", () => {
		// No analysis: inventing audio we have never heard would be worse than the gap, so NetEq
		// renders nothing and so do we.
		const expand = new Expand(RATE, 1, BLOCK);
		expect(expand.ready).toBe(false);

		const [produced] = conceal(expand, 1);
		expect(energy(produced)).toBe(0);
	});

	it("keeps an anti-phase stereo image anti-phase", () => {
		const expand = primed(antiphase(RATE, 0.05, 997, 0.5), 2);

		const [left, right] = conceal(expand, 5, 2);
		const sum = left.map((sample, i) => sample + right[i]);
		expect(energy(sum)).toBeLessThan(1e-9 * energy(left));
	});

	it("conceals speech without a click at either seam", () => {
		// Speech-like: a periodic excitation with enough noise in it to spoil a naive splice.
		const source = tone(RATE, 0.5, 220, 0.4);
		const [room] = white(RATE, 0.5, 0.01);
		for (let i = 0; i < source[0].length; i++) source[0][i] += room[i];

		const expand = primed([source[0].subarray(0, frames(RATE, 40))], 1);
		const [concealed] = conceal(expand, 3);

		// The stream comes back where it would have been had nothing been lost.
		const from = frames(RATE, 40) + concealed.length;
		const returning = [source[0].subarray(from, from + frames(RATE, BLOCK))];

		const out = [new Float32Array(concealed.length + returning[0].length)];
		const kept = new Merge(RATE, 1).merge([concealed], concealed.length, returning, returning[0].length, out);

		const spliced = out[0].subarray(0, kept + returning[0].length);
		// The fixture's own steepest step, which a splice on a pitch period does not exceed.
		const slope = maxStep(source[0]);
		expect(maxStep(spliced)).toBeLessThan(1.5 * slope);
		expect(zeroRun(spliced)).toBeLessThanOrEqual(2);
	});
});

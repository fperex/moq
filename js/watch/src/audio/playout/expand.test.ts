import { describe, expect, it } from "bun:test";
import { BLOCK } from "./decision";
import { Expand, MAX_CONSECUTIVE_EXPANDS, voiceMix } from "./expand";
import { antiphase, dominant, energy, goertzel, maxStep, tone, noise as white, zeroRun } from "./fixture";
import { Merge } from "./merge";
import { Noise } from "./noise";
import { frames } from "./stretch";

const RATE = 48000;

/** A noise estimate trained on a second of quiet room tone. */
function trained(channels: number, level: number): Noise {
	const estimate = new Noise(channels);
	const room = white(RATE, 1, level, channels);
	for (let at = 256; at <= room[0].length; at += 256) {
		estimate.update(
			room.map((plane) => plane.subarray(0, at)),
			at,
		);
	}
	expect(estimate.initialised).toBe(true);
	return estimate;
}

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
function conceal(expand: Expand, estimate: Noise, count: number, channels = 1): Float32Array[] {
	const out = Array.from({ length: channels }, () => new Float32Array(expand.block * count));
	const block = Array.from({ length: channels }, () => new Float32Array(expand.block));

	for (let i = 0; i < count; i++) {
		expand.process(estimate, block, 0);
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
	it("holds the pitch of a tone and decays toward the background", () => {
		const estimate = trained(1, 0.002);
		const floor = estimate.energy(0);

		const expand = primed(tone(RATE, 0.05, 997, 0.5), 1);
		const blocks: Float32Array[] = [];
		const block = [new Float32Array(expand.block)];
		for (let i = 0; i < 20; i++) {
			expand.process(estimate, block, 0);
			blocks.push(block[0].slice());
		}

		let previous = Number.MAX_VALUE;
		for (const produced of blocks) {
			const level = energy(produced);

			// Once the concealment has faded into the room, what is left is noise and noise wanders.
			// Until then every block is quieter than the last.
			if (level > 2 * floor) {
				expect(level).toBeLessThanOrEqual(previous * 1.05);
				previous = level;
			}

			// And while it is still well clear of the room it is still the tone. Closer than 20dB
			// the background dominates the off pitch bin, which is the whole point of fading into it.
			if (level > 100 * floor) {
				const signal = goertzel(produced, RATE, 997);
				const off = goertzel(produced, RATE, 1600);
				expect(signal).toBeGreaterThan(8 * off);
			}
			expect(zeroRun(produced)).toBeLessThanOrEqual(2);
		}

		const all = new Float32Array(blocks.length * expand.block);
		for (const [index, produced] of blocks.entries()) all.set(produced, index * expand.block);
		expect(Math.abs(dominant(all, RATE, 900, 1100) - 997)).toBeLessThan(9.97);

		const last = energy(blocks[blocks.length - 1]);
		expect(last).toBeLessThan(energy(blocks[0]) / 1000);
		expect(last).toBeLessThan(4 * floor);
	});

	it("stops at the ceiling and plays the background from there", () => {
		const estimate = trained(1, 0.002);
		const floor = estimate.energy(0);

		const expand = primed(tone(RATE, 0.05, 997, 0.5), 1);
		// The ceiling is NetEq's 200 blocks of 10ms, which is 100 of this engine's 20ms blocks.
		conceal(expand, estimate, MAX_CONSECUTIVE_EXPANDS);
		expect(expand.exhausted).toBe(true);

		const [after] = conceal(expand, estimate, 1);
		const level = energy(after);
		expect(level).toBeGreaterThan(floor / 4);
		expect(level).toBeLessThan(floor * 4);
		// Comfort noise, not silence: the room is still there when the talker is not.
		expect(zeroRun(after)).toBeLessThanOrEqual(2);
	});

	it("fades a long outage to the background rather than buzzing on", () => {
		const estimate = trained(1, 0.002);
		const floor = estimate.energy(0);
		const expand = primed(tone(RATE, 0.05, 997, 0.5), 1);

		const [produced] = conceal(expand, estimate, MAX_CONSECUTIVE_EXPANDS);
		const tail = produced.subarray(produced.length - frames(RATE, 1000));
		expect(energy(tail)).toBeLessThan(4 * floor);
	});

	it("plays silence when it has never heard the room and has nothing to repeat", () => {
		// No analysis and no background estimate: inventing a room tone we have never heard would
		// be worse than the gap, so NetEq renders nothing and so do we.
		const expand = new Expand(RATE, 1, BLOCK);
		expect(expand.ready).toBe(false);

		const [produced] = conceal(expand, new Noise(1), 1);
		expect(energy(produced)).toBe(0);
	});

	it("keeps an anti-phase stereo image anti-phase", () => {
		// Untrained, so nothing but the repeated period comes out. The room tone that a trained
		// estimate fades in is one excitation shared by every channel, as `expand.cc` generates it,
		// so it is correlated by construction and would show up here as the two channels drifting.
		const expand = primed(antiphase(RATE, 0.05, 997, 0.5), 2);

		const [left, right] = conceal(expand, new Noise(2), 5, 2);
		const sum = left.map((sample, i) => sample + right[i]);
		expect(energy(sum)).toBeLessThan(1e-9 * energy(left));
	});

	it("conceals speech without a click at either seam", () => {
		const estimate = trained(1, 0.002);
		// Speech-like: a periodic excitation with enough noise in it to spoil a naive splice.
		const source = tone(RATE, 0.5, 220, 0.4);
		const [room] = white(RATE, 0.5, 0.01);
		for (let i = 0; i < source[0].length; i++) source[0][i] += room[i];

		const expand = primed([source[0].subarray(0, frames(RATE, 40))], 1);
		const [concealed] = conceal(expand, estimate, 3);

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

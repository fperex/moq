import { describe, expect, it } from "bun:test";
import { BLOCK } from "./decision";
import { energy, maxStep, tone } from "./fixture";
import { Merge } from "./merge";
import { frames } from "./stretch";

const RATE = 48000;

/** The steepest step a 997Hz tone at half scale takes between two samples. */
const SLOPE = (0.5 * 2 * Math.PI * 997) / RATE;

describe("the splice back to real audio", () => {
	it("joins a tone back onto itself without a click", () => {
		const source = tone(RATE, 0.2, 997, 0.5);
		// Concealment that has drifted a quarter period out of phase, which is what the alignment
		// search is there to find.
		const concealed = frames(RATE, 30);
		const expanded = [source[0].subarray(12, 12 + concealed)];
		const returning = [source[0].subarray(0, frames(RATE, BLOCK))];

		const out = [new Float32Array(concealed + returning[0].length)];
		const kept = new Merge(RATE, 1).merge(expanded, concealed, returning, returning[0].length, out);

		const spliced = out[0].subarray(0, kept + returning[0].length);
		expect(kept).toBeGreaterThan(0);
		expect(maxStep(spliced)).toBeLessThan(1.5 * SLOPE);
	});

	it("brings a loud return in quietly and lets it back up", () => {
		// Concealment that has faded almost to the room, and media that comes back at full scale.
		const expanded = tone(RATE, 0.03, 997, 0.01);
		const returning = tone(RATE, 0.01, 997, 0.5);
		const concealed = expanded[0].length;
		const back = returning[0].length;

		const out = [new Float32Array(concealed + back)];
		const kept = new Merge(RATE, 1).merge(expanded, concealed, returning, back, out);

		const head = out[0].subarray(kept, kept + frames(RATE, 1));
		expect(energy(head)).toBeLessThan(energy(returning[0].subarray(0, head.length)) / 4);

		// And it is back at full scale by the end, so the media is never held down once the
		// concealment underneath it is gone.
		const tail = out[0].subarray(kept + back - frames(RATE, 1), kept + back);
		expect(energy(tail)).toBeGreaterThan(energy(returning[0]) / 2);
	});

	it("is a passthrough when either side is empty", () => {
		const merge = new Merge(RATE, 1);
		const input = [Float32Array.from([1, 2])];
		const out = [new Float32Array(2)];

		expect(merge.merge([new Float32Array(0)], 0, input, 2, out)).toBe(0);
		expect(Array.from(out[0])).toEqual([1, 2]);
	});

	it("splices both channels at the same point", () => {
		// A distinct signal per channel. `tone(..., 2)` copies one mono signal into every channel,
		// so left and right would be identical and a per-channel alignment would still line up.
		const [left] = tone(RATE, 0.2, 997, 0.5);
		const [right] = tone(RATE, 0.2, 613, 0.5);
		const concealed = frames(RATE, 30);
		const expanded = [left.subarray(12, 12 + concealed), right.subarray(12, 12 + concealed)];
		const back = frames(RATE, BLOCK);
		const returning = [left.subarray(0, back), right.subarray(0, back)];

		const out = [new Float32Array(concealed + back), new Float32Array(concealed + back)];
		const kept = new Merge(RATE, 2).merge(expanded, concealed, returning, back, out);

		// The alignment is searched on the first channel and applied to all of them, so every
		// channel keeps exactly `kept` frames of its own concealment ahead of the crossfade.
		expect(kept).toBeGreaterThan(0);
		for (const channel of [0, 1]) {
			expect(Array.from(out[channel].subarray(0, kept))).toEqual(Array.from(expanded[channel].subarray(0, kept)));
		}

		// The two channels really are different, so the check above had something to catch.
		expect(Array.from(out[0].subarray(0, kept))).not.toEqual(Array.from(out[1].subarray(0, kept)));
	});
});

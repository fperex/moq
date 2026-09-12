import { expect, test } from "bun:test";
import { Playout } from "./playout";

const name = "sparse storage";
test(`${name}: reclaimed index prefix still admits overwrites and later appends`, () => {
	const play = new Playout({ rate: 8000, channels: 1, target: { kind: "fixed", milliseconds: 0 }, buffered: true });
	play.insert(0, [new Float32Array([0.25])], 0);
	for (let i = 0; i < 2400; i++) play.insert((24000 + i * 2) * 125, [new Float32Array([0.5])], 1);
	const output = [new Float32Array(128)];
	for (let frame = 0; frame < 11008; frame += 128) play.render(output, frame);
	expect(play.stats.queueSamples).toBe(2400);
	play.insert(27400 * 125, [new Float32Array([0.875])], 2);
	play.insert(29000 * 125, [new Float32Array(160).fill(0.75)], 3);
	expect(play.stats.queueSamples).toBe(2560);
	play.end(29160 * 125);
	const captured = new Float32Array(29184 - 11008);
	for (let frame = 11008; frame < 29184; frame += 128) {
		play.render(output, frame);
		captured.set(output[0], frame - 11008);
	}
	expect(play.stats.consumed).toBeCloseTo(2561, 6);
	expect(play.stats.queueSamples).toBe(0);
	expect(Array.from(captured.subarray(29040 - 11008, 29160 - 11008))).toEqual(Array(120).fill(0.75));
});
test(`${name}: repeated overlapping sparse inputs match independent retained sample counts`, () => {
	for (let seed = 1; seed <= 40; seed++) {
		let random = seed;
		const next = () => {
			random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
			return random;
		};
		const play = new Playout({
			rate: 8000,
			channels: 1,
			target: { kind: "fixed", milliseconds: 0 },
			buffered: true,
			capacityMilliseconds: 100,
		});
		const expected = new Set<number>();
		play.insert(0, [new Float32Array([0.25])], 0);
		expected.add(0);
		for (let i = 0; i < 300; i++) {
			const start = 1600 + (next() % 1200);
			const length = 1 + (next() % 64);
			if (next() % 9 === 0) {
				play.truncate(start * 125);
				for (const value of expected) if (value >= start) expected.delete(value);
			} else {
				let extra = 0;
				for (let j = 0; j < length; j++) if (!expected.has(start + j)) extra++;
				if (expected.size + extra > 800)
					expect(() => play.insert(start * 125, [new Float32Array(length).fill(0.5)], i)).toThrow();
				else {
					play.insert(start * 125, [new Float32Array(length).fill(0.5)], i);
					for (let j = 0; j < length; j++) expected.add(start + j);
				}
			}
			expect(play.stats.queueSamples).toBe(expected.size);
		}
		const end = Math.max(...expected) + 1;
		play.end(end * 125);
		const output = [new Float32Array(128)];
		for (let frame = 0; frame < end + 128; frame += 128) play.render(output, frame);
		expect(play.stats.consumed).toBeCloseTo(expected.size, 6);
		expect(play.stats.queueSamples).toBe(0);
	}
});

import { expect, test } from "bun:test";
import { Playout } from "./playout";

for (const rate of [44100, 48000, 96000]) {
	for (const mode of ["auto", "fixed"] as const) {
		test(`${rate} Hz ${mode} recovers when network delay rises by 200 ms and then falls`, () => {
			const play = new Playout({
				rate,
				channels: 2,
				target:
					mode === "auto"
						? { kind: "auto", initialMilliseconds: 40, minMilliseconds: 40, maxMilliseconds: 500 }
						: { kind: "fixed", milliseconds: 40 },
			});
			const chunk = rate / 50;
			const output = [new Float32Array(128), new Float32Array(128)];
			let packet = 0;
			let recoveryFrames = 0;
			let peak = 0;
			for (let frame = 0; frame < rate * 16; frame += 128) {
				const now = (frame * 1000) / rate;
				for (;;) {
					const timestamp = packet * 20;
					const delay = timestamp < 3000 ? 0 : timestamp < 8000 ? 200 : 60;
					if (timestamp + delay > now) break;
					const left = Float32Array.from(
						{ length: chunk },
						(_, i) => 0.2 * Math.sin(((packet * chunk + i) * 2 * Math.PI * 997) / rate),
					);
					play.insert(timestamp * 1000, [left, Float32Array.from(left, (value) => -value)], now);
					packet++;
				}
				play.render(output, frame);
				if (now >= 5000) {
					let energy = 0;
					for (let i = 0; i < 128; i++) {
						const sample = output[0][i];
						energy += sample * sample;
						peak = Math.max(peak, Math.abs(sample));
						if (!Number.isFinite(sample) || sample !== -output[1][i])
							throw new Error("invalid recovered stereo");
					}
					if (energy === 0) throw new Error(`still silent at ${now} ms`);
					recoveryFrames += 128;
				}
			}
			const stats = play.stats;
			expect(recoveryFrames).toBeGreaterThan(rate * 10);
			expect(peak).toBeGreaterThan(0.19);
			expect(stats.consumed).toBeGreaterThan(rate * 15);
			expect(stats.late).toBeLessThan(rate * 0.1);
			expect(stats.silent).toBeLessThan(rate * 0.4);
			expect(stats.queueSamples).toBeLessThan(rate * 0.6);
		});
	}
}

test("an exhausted unknown tail holds the media clock while explicit future gaps still advance", () => {
	const play = new Playout({ rate: 8000, channels: 1, target: { kind: "fixed", milliseconds: 0 }, buffered: true });
	const output = [new Float32Array(128)];
	play.insert(0, [new Float32Array(160).fill(0.25)], 0);
	for (let frame = 0; frame < 1600; frame += 128) play.render(output, frame);
	const held = play.timestamp;
	for (let frame = 1664; frame < 3200; frame += 128) play.render(output, frame);
	expect(play.timestamp).toBe(held);
	expect(play.playing).toBe(false);
	play.insert(500000, [new Float32Array(160).fill(0.5)], 400);
	play.end(520000);
	let heard = false;
	for (let frame = 3200; frame < 8000; frame += 128) {
		play.render(output, frame);
		heard ||= output[0].some((value) => value === 0.5);
	}
	expect(heard).toBe(true);
	expect(play.timestamp).toBe(520000);
});

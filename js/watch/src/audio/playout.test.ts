import { describe, expect, test } from "bun:test";
import { type Config, Playout } from "./playout";

for (const rate of [44100, 48000])
	describe(`${rate} Hz PCM timeline`, () => {
		const config = { rate, channels: 2, target: { kind: "fixed" as const, milliseconds: 40 }, buffered: true };
		test("plays a finite stereo utterance exactly and stops at its endpoint", () => {
			const play = new Playout(config);
			const count = Math.round(rate / 10);
			const left = Float32Array.from({ length: count }, (_, i) => 0.2 * Math.sin(i / 10));
			const right = Float32Array.from(left, (x) => -x);
			const timestamp = 3_000_000;
			play.insert(timestamp, [left, right], 0);
			play.end(timestamp + (count * 1e6) / rate);
			const rendered: number[] = [];
			let stereoError = 0;
			for (let frame = 0; frame < count + 2048; frame += 128) {
				const output = [new Float32Array(128), new Float32Array(128)];
				play.render(output, frame);
				rendered.push(...output[0]);
				for (let i = 0; i < 128; i++)
					stereoError = Math.max(stereoError, Math.abs(output[0][i] + output[1][i]));
			}
			expect(rendered.slice(0, count)).toEqual(Array.from(left));
			expect(rendered.slice(count).every((x) => x === 0)).toBe(true);
			expect(stereoError).toBe(0);
			expect(play.timestamp).toBeCloseTo(timestamp + (count * 1e6) / rate, 6);
			expect(play.stats.concealed).toBe(0);
		});
		test("reset discards pending samples and concealment history", () => {
			const play = new Playout(config);
			const count = Math.round(rate / 10);
			play.insert(4_000_000, [new Float32Array(count).fill(0.5), new Float32Array(count).fill(-0.5)], 0);
			play.render([new Float32Array(128), new Float32Array(128)], 0);
			play.reset();
			play.insert(
				1_000_000,
				[new Float32Array(count).fill(0.25), new Float32Array(count).fill(-0.25)],
				128000 / rate,
			);
			const out = [new Float32Array(128), new Float32Array(128)];
			play.render(out, 128);
			expect(Array.from(out[0])).toEqual(Array(128).fill(0.25));
			expect(Array.from(out[1])).toEqual(Array(128).fill(-0.25));
			expect(play.timestamp).toBeCloseTo(1_000_000 + 128e6 / rate, 6);
		});
		test("preserves authentic digital silence without treating it as loss", () => {
			const play = new Playout(config);
			const count = Math.round(rate / 10);
			play.insert(0, [new Float32Array(count), new Float32Array(count)], 0);
			play.end((count * 1e6) / rate);
			for (let frame = 0; frame < count; frame += 128)
				play.render([new Float32Array(128), new Float32Array(128)], frame);
			expect(play.stats.concealed).toBe(0);
			expect(play.stats.consumed).toBe(count);
		});
	});

describe("playout policy lifecycle", () => {
	test("distant PCM cannot fill the initial realtime cushion", () => {
		// Buffered playback retains its full source timeline, including long gaps.
		for (const buffered of [false, true]) {
			const play = new Playout({
				rate: 48000,
				channels: 1,
				buffered,
				target: { kind: "fixed", milliseconds: 200 },
			});
			play.insert(0, [new Float32Array(4800).fill(0.25)], 0);
			play.insert(10000000, [new Float32Array(19200).fill(0.5)], 0);
			const output = [new Float32Array(128)];
			play.render(output, 0);
			expect(play.playing).toBe(buffered);
			expect(Array.from(output[0])).toEqual(Array(128).fill(buffered ? 0.25 : 0));
			expect(play.timestamp).toBe(buffered ? (128 * 1e6) / 48000 : 0);
		}
	});

	test("resumes after a long outage without waiting forever at the concealed gap", () => {
		const play = new Playout({ rate: 8000, channels: 1, target: { kind: "fixed", milliseconds: 20 } });
		play.insert(0, [new Float32Array(320).fill(0.25)], 0);
		const output = [new Float32Array(128)];
		for (let frame = 0; frame < 1280; frame += 128) play.render(output, frame);
		expect(play.playing).toBe(false);
		play.insert(500000, [new Float32Array(8000).fill(0.5)], 500);
		for (let frame = 1280; frame < 7680; frame += 128) play.render(output, frame);
		expect(play.playing).toBe(true);
		expect(play.timestamp).toBeGreaterThan(500000);
		expect(Array.from(output[0])).toEqual(Array(128).fill(0.5));
	});

	test("starts with valid leading audio when the cushion contains a missing frame", () => {
		const play = new Playout({ rate: 8000, channels: 1, target: { kind: "fixed", milliseconds: 40 } });
		play.insert(0, [new Float32Array(80).fill(0.25)], 0);
		play.insert(30000, [new Float32Array(80).fill(0.5)], 30);
		const output = [new Float32Array(128)];
		play.render(output, 0);
		expect(play.playing).toBe(true);
		expect(Array.from(output[0].subarray(0, 80))).toEqual(Array(80).fill(0.25));
		expect(play.stats.concealed).toBe(48);
		expect(play.stats.silent).toBe(0);
		expect(play.timestamp).toBe(16000);
	});

	test("applies auto floors and ceilings to the estimate without retaining an old floor", () => {
		const play = new Playout({ rate: 48000, channels: 1, target: { kind: "auto", initialMilliseconds: 80 } });
		play.configure({ target: { kind: "auto", minMilliseconds: 200, maxMilliseconds: 500 } });
		expect(play.stats.targetMilliseconds).toBe(200);
		play.configure({ target: { kind: "auto", minMilliseconds: 20, maxMilliseconds: 500 } });
		expect(play.stats.targetMilliseconds).toBe(80);
		play.configure({ target: { kind: "auto", minMilliseconds: 20, maxMilliseconds: 60 } });
		expect(play.stats.targetMilliseconds).toBe(60);
	});

	test("rejects invalid auto limits without changing the active policy or queued audio", () => {
		const play = new Playout({
			rate: 48000,
			channels: 1,
			target: { kind: "fixed", milliseconds: 40 },
			buffered: true,
		});
		play.insert(0, [new Float32Array(4800).fill(0.25)], 0);
		const targets: Config["target"][] = [
			{ kind: "auto", minMilliseconds: 200, maxMilliseconds: 100 },
			{ kind: "auto", minMilliseconds: -1 },
			{ kind: "auto", maxMilliseconds: Infinity },
			{ kind: "auto", initialMilliseconds: NaN },
		];
		for (const target of targets) expect(() => play.configure({ target })).toThrow(RangeError);
		expect(play.stats.targetMilliseconds).toBe(40);
		const output = [new Float32Array(128)];
		play.render(output, 0);
		expect(Array.from(output[0])).toEqual(Array(128).fill(0.25));
	});

	test("reveals the learned delay when an auto floor is lowered", () => {
		const play = new Playout({ rate: 8000, channels: 1, target: { kind: "auto", minMilliseconds: 200 } });
		const output = [new Float32Array(160)];
		for (let frame = 0; frame < 30; frame++) {
			play.insert(frame * 20000, [new Float32Array(160).fill(0.25)], frame * 20);
			play.render(output, frame * 160);
		}
		expect(play.stats.targetMilliseconds).toBe(200);
		play.configure({ target: { kind: "auto", minMilliseconds: 20 } });
		expect(play.stats.targetMilliseconds).toBe(40);
	});

	test("expires old relative-delay minima without increasing the target beyond the active two-second window", () => {
		const play = new Playout({ rate: 8000, channels: 1, target: { kind: "auto", initialMilliseconds: 80 } });
		const targets: number[] = [];
		for (let i = 0; i < 40; i++) {
			play.insert(i * 100000, [new Float32Array([0.25])], i * 150);
			if (i % 4 === 0) targets.push(play.stats.targetMilliseconds);
		}
		expect(targets).toEqual([80, 160.125, 360.125, 560.125, 660.125, 660.125, 660.125, 660.125, 660.125, 660.125]);
	});

	test("resets to the latest policy after fixed and auto transitions", () => {
		const play = new Playout({ rate: 48000, channels: 1, target: { kind: "fixed", milliseconds: 40 } });
		play.configure({ target: { kind: "fixed", milliseconds: 150 } });
		play.reset();
		expect(play.stats.targetMilliseconds).toBe(150);
		play.configure({
			target: { kind: "auto", initialMilliseconds: 90, minMilliseconds: 120, maxMilliseconds: 500 },
		});
		play.reset();
		expect(play.stats.targetMilliseconds).toBe(120);
		play.configure({
			target: { kind: "auto", initialMilliseconds: 70, minMilliseconds: 20, maxMilliseconds: 500 },
		});
		play.reset();
		expect(play.stats.targetMilliseconds).toBe(70);
	});

	test("grows for a configured floor above two seconds without replacing queued samples", () => {
		const play = new Playout({
			rate: 8000,
			channels: 1,
			target: { kind: "fixed", milliseconds: 40 },
			buffered: true,
		});
		play.insert(0, [Float32Array.from({ length: 800 }, (_, i) => i / 8000)], 0);
		play.configure({ target: { kind: "fixed", milliseconds: 3000 }, buffered: true });
		play.insert(100000, [new Float32Array(23200).fill(0.5)], 1);
		const output = [new Float32Array(800)];
		play.render(output, 0);
		expect(Array.from(output[0])).toEqual(Array.from({ length: 800 }, (_, i) => Math.fround(i / 8000)));
		expect(play.stats.targetMilliseconds).toBe(3000);
	});

	test("accepts finite long floors at construction and retains explicit capacity bounds", () => {
		const long = new Playout({
			rate: 8000,
			channels: 1,
			target: { kind: "fixed", milliseconds: 65000 },
			buffered: true,
		});
		expect(long.stats.targetMilliseconds).toBe(65000);
		const limited = new Playout({
			rate: 8000,
			channels: 1,
			target: { kind: "fixed", milliseconds: 40 },
			capacityMilliseconds: 200,
		});
		expect(() => limited.configure({ target: { kind: "fixed", milliseconds: 300 } })).toThrow(RangeError);
		expect(() => limited.configure({ target: { kind: "auto", maxMilliseconds: 300 } })).toThrow(RangeError);
		expect(limited.stats.targetMilliseconds).toBe(40);
	});

	test("preserves a partially rendered block when the queue grows", () => {
		const play = new Playout({
			rate: 8000,
			channels: 1,
			target: { kind: "fixed", milliseconds: 40 },
			buffered: true,
		});
		const source = Float32Array.from({ length: 800 }, (_, i) => i / 8000);
		play.insert(0, [source], 0);
		play.render([new Float32Array(32)], 0);
		play.configure({ target: { kind: "fixed", milliseconds: 3000 }, buffered: true });
		const output = [new Float32Array(32)];
		play.render(output, 32);
		expect(Array.from(output[0])).toEqual(Array.from(source.subarray(32, 64)));
		expect(play.timestamp).toBe(8000);
	});

	test("keeps an endpoint through a policy change and clears it only on reset", () => {
		const play = new Playout({
			rate: 8000,
			channels: 1,
			target: { kind: "fixed", milliseconds: 40 },
			buffered: true,
		});
		play.insert(1000000, [new Float32Array(800).fill(0.25)], 0);
		play.end(1050000);
		play.configure({ target: { kind: "auto", initialMilliseconds: 80 }, buffered: true });
		const output = [new Float32Array(800)];
		play.render(output, 0);
		expect(Array.from(output[0].subarray(0, 400))).toEqual(Array(400).fill(0.25));
		expect(Array.from(output[0].subarray(400))).toEqual(Array(400).fill(0));
		expect(play.timestamp).toBe(1050000);
		expect(play.playing).toBe(false);
		play.reset();
		play.insert(0, [new Float32Array(800).fill(0.5)], 100);
		play.render(output, 800);
		expect(Array.from(output[0])).toEqual(Array(800).fill(0.5));
		expect(play.timestamp).toBe(100000);
	});
});

describe("sparse PCM storage", () => {
	for (const rate of [8000, 44100, 48000]) {
		test(`plays both 20ms spans around a five-second gap at ${rate} Hz without counting the gap as PCM`, () => {
			const play = new Playout({
				rate,
				channels: 1,
				target: { kind: "fixed", milliseconds: 100 },
				buffered: true,
				capacityMilliseconds: 100,
			});
			const length = rate / 50;
			play.insert(0, [new Float32Array(length).fill(0.25)], 0);
			play.insert(5000000, [new Float32Array(length).fill(0.5)], 10);
			expect(play.stats.queueSamples).toBe(length * 2);
			const output = [new Float32Array(128)];
			play.render(output, 0);
			expect(play.playing).toBe(true);
			play.end(5020000);
			const total = Math.ceil((rate * 5.02 + 128) / 128) * 128;
			const rendered = new Float32Array(total);
			rendered.set(output[0]);
			for (let frame = 128; frame < total; frame += 128) {
				play.render(output, frame);
				rendered.set(output[0], frame);
			}
			expect(Array.from(rendered.subarray(0, length))).toEqual(Array(length).fill(0.25));
			expect(rendered.subarray(Math.ceil(rate * 0.1), rate * 5).every((value) => value === 0)).toBe(true);
			expect(Array.from(rendered.subarray(Math.ceil(rate * 5.005), rate * 5 + length))).toEqual(
				Array(rate * 5 + length - Math.ceil(rate * 5.005)).fill(0.5),
			);
			expect(rendered.subarray(Math.round(rate * 5.02)).every((value) => value === 0)).toBe(true);
			expect(play.stats.consumed).toBeCloseTo(length * 2, 6);
			expect(play.stats.late).toBe(0);
			expect(play.stats.queueSamples).toBe(0);
			expect(play.timestamp).toBe(5020000);
			expect(play.playing).toBe(false);
		});
	}

	test("rejects only additional retained PCM and preserves previously admitted sparse spans", () => {
		const play = new Playout({
			rate: 8000,
			channels: 1,
			target: { kind: "fixed", milliseconds: 0 },
			buffered: true,
			capacityMilliseconds: 100,
		});
		play.insert(0, [new Float32Array(400).fill(0.25)], 0);
		play.insert(5000000, [new Float32Array(400).fill(0.5)], 1);
		expect(() => play.insert(10000000, [new Float32Array([1])], 2)).toThrow("PCM ingress capacity exceeded");
		expect(play.stats.queueSamples).toBe(800);
		play.end(5050000);
		const output = [new Float32Array(128)];
		for (let frame = 0; frame < 40576; frame += 128) play.render(output, frame);
		expect(play.stats.consumed).toBeCloseTo(800, 6);
		expect(play.stats.queueSamples).toBe(0);
		expect(play.timestamp).toBe(5050000);
	});

	test("replaces overlapping future spans without reserving duplicate samples", () => {
		const play = new Playout({
			rate: 8000,
			channels: 1,
			target: { kind: "fixed", milliseconds: 0 },
			buffered: true,
			capacityMilliseconds: 100,
		});
		play.insert(0, [new Float32Array(100).fill(0.25)], 0);
		play.insert(5000000, [new Float32Array(700).fill(0.5)], 1);
		play.insert(5030000, [new Float32Array(100).fill(0.875)], 2);
		expect(play.stats.queueSamples).toBe(800);
		play.end(5087500);
		const rendered = new Float32Array(40832);
		const output = [new Float32Array(128)];
		for (let frame = 0; frame < rendered.length; frame += 128) {
			play.render(output, frame);
			rendered.set(output[0], frame);
		}
		expect(Array.from(rendered.subarray(40240, 40340))).toEqual(Array(100).fill(0.875));
		expect(Array.from(rendered.subarray(40340, 40700))).toEqual(Array(360).fill(0.5));
		expect(play.stats.consumed).toBeCloseTo(800, 6);
		expect(play.stats.queueSamples).toBe(0);
	});

	test("preserves a newer overwrite where deferred PCM has just entered the indexed window", () => {
		const play = new Playout({
			rate: 8000,
			channels: 1,
			target: { kind: "fixed", milliseconds: 0 },
			buffered: true,
			capacityMilliseconds: 100,
		});
		play.insert(0, [new Float32Array(80).fill(0.25)], 0);
		play.insert(90000, [new Float32Array(320).fill(0.5)], 1);
		play.render([new Float32Array(160)], 0);
		play.insert(110000, [new Float32Array(20).fill(0.875)], 2);
		play.end(130000);
		const output = [new Float32Array(880)];
		play.render(output, 160);
		expect(Array.from(output[0].subarray(720, 740))).toEqual(Array(20).fill(0.875));
		expect(Array.from(output[0].subarray(740))).toEqual(Array(140).fill(0.5));
		expect(play.stats.consumed).toBeCloseTo(400, 6);
		expect(play.stats.queueSamples).toBe(0);
	});

	test("grows and truncates a distant timeline without scanning or allocating its gap", () => {
		const play = new Playout({
			rate: 8000,
			channels: 1,
			target: { kind: "fixed", milliseconds: 0 },
			buffered: true,
		});
		play.insert(0, [new Float32Array(160).fill(0.25)], 0);
		play.insert(1000000000000, [new Float32Array(160).fill(0.5)], 1);
		play.configure({ target: { kind: "fixed", milliseconds: 3000 }, buffered: true });
		expect(play.stats.queueSamples).toBe(320);
		play.truncate(1000000005000);
		expect(play.stats.queueSamples).toBe(200);
		play.truncate(20000);
		expect(play.stats.queueSamples).toBe(160);
		play.end(20000);
		const output = [new Float32Array(160)];
		play.render(output, 0);
		expect(Array.from(output[0])).toEqual(Array(160).fill(0.25));
		play.reset();
		play.insert(0, [new Float32Array(160).fill(0.75)], 2);
		play.end(20000);
		play.render(output, 160);
		expect(Array.from(output[0])).toEqual(Array(160).fill(0.75));
		expect(play.stats.queueSamples).toBe(0);
	});
});

test("counts retained audio beyond gaps when deciding whether the buffer needs expansion", () => {
	const rate = 48000;
	const play = new Playout({ rate, channels: 1, target: { kind: "fixed", milliseconds: 200 } });
	for (let packet = 0; packet < 20; packet++) {
		const source = Float32Array.from({ length: 1536 }, (_, i) => 0.25 * Math.sin((2 * Math.PI * 200 * i) / rate));
		play.insert(packet * 34000, [source], 0);
	}
	for (let frame = 0; frame < rate / 10; frame += 128) play.render([new Float32Array(128)], frame);
	expect(play.stats.queueSamples).toBeGreaterThan(rate * 0.4);
	expect(play.stats.expanded).toBe(0);
	expect(play.stats.accelerated).toBeGreaterThan(0);
	expect(play.stats.concealed).toBeGreaterThan(0);
});

for (const gap of [60021, 9800000])
	test(`PCM beyond a ${gap}us gap does not change the current utterance's rate`, () => {
		const rate = 48000;
		const current = new Playout({ rate, channels: 1, target: { kind: "fixed", milliseconds: 200 } });
		const future = new Playout({ rate, channels: 1, target: { kind: "fixed", milliseconds: 200 } });
		const source = Float32Array.from({ length: 9600 }, (_, i) => 0.25 * Math.sin((2 * Math.PI * 200 * i) / rate));
		current.insert(0, [source], 0);
		future.insert(0, [source], 0);
		future.insert(200000 + gap, [new Float32Array(19200).fill(0.25)], 0);
		for (let frame = 0; frame < 4800; frame += 128) {
			const first = [new Float32Array(128)];
			const second = [new Float32Array(128)];
			current.render(first, frame);
			future.render(second, frame);
			expect(second[0]).toEqual(first[0]);
		}
		expect(current.stats.consumed).toBeGreaterThan(0);
		expect(future.stats.consumed).toBe(current.stats.consumed);
		expect(future.stats.accelerated).toBe(0);
	});

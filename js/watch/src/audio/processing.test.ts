import { describe, expect, test } from "bun:test";
import { Playout } from "./playout";

function tone(rate: number, length: number, frequency = 200, amplitude = 0.3): Float32Array {
	return Float32Array.from({ length }, (_, i) => amplitude * Math.sin((2 * Math.PI * frequency * i) / rate));
}

function noise(length: number, amplitude: number, seed: number): Float32Array {
	let state = seed >>> 0;
	return Float32Array.from({ length }, () => {
		state = (1664525 * state + 1013904223) >>> 0;
		return ((state / 0x1_0000_0000) * 2 - 1) * amplitude;
	});
}

function insertChunks(playout: Playout, rate: number, planes: Float32Array[], start = 0): void {
	const frameLength = Math.round(rate * 0.02);
	for (let offset = 0; offset < planes[0].length; offset += frameLength) {
		playout.insert(
			((start + offset) * 1e6) / rate,
			planes.map((plane) => plane.slice(offset, Math.min(plane.length, offset + frameLength))),
			(offset * 1000) / rate,
		);
	}
}

function render(playout: Playout, channels: number, length: number, startFrame = 0): Float32Array[] {
	const rendered = Array.from({ length: channels }, () => new Float32Array(length));
	for (let offset = 0; offset < length; offset += 128) {
		const count = Math.min(128, length - offset);
		const output = Array.from({ length: channels }, () => new Float32Array(count));
		playout.render(output, startFrame + offset);
		for (let channel = 0; channel < channels; channel++) rendered[channel].set(output[channel], offset);
	}
	return rendered;
}

function rms(samples: Float32Array): number {
	let energy = 0;
	for (const sample of samples) energy += sample * sample;
	return Math.sqrt(energy / samples.length);
}

function correlation(first: Float32Array, second: Float32Array): number {
	let dot = 0;
	let firstEnergy = 0;
	let secondEnergy = 0;
	for (let i = 0; i < first.length; i++) {
		dot += first[i] * second[i];
		firstEnergy += first[i] * first[i];
		secondEnergy += second[i] * second[i];
	}
	return dot / Math.sqrt(firstEnergy * secondEnergy);
}

function maximumLagCorrelation(samples: Float32Array, minimum: number, maximum: number): number {
	let best = -Infinity;
	for (let lag = minimum; lag <= maximum; lag++) {
		let dot = 0;
		let firstEnergy = 0;
		let secondEnergy = 0;
		for (let i = lag; i < samples.length; i++) {
			dot += samples[i] * samples[i - lag];
			firstEnergy += samples[i] * samples[i];
			secondEnergy += samples[i - lag] * samples[i - lag];
		}
		best = Math.max(best, dot / Math.sqrt(firstEnergy * secondEnergy));
	}
	return best;
}

describe("content-aware time stretching", () => {
	for (const rate of [44100, 48000, 96000]) {
		test(`keeps stereo and source-clock accounting exact while accelerating at ${rate} Hz`, () => {
			const playout = new Playout({
				rate,
				channels: 2,
				target: { kind: "fixed", milliseconds: 40 },
				capacityMilliseconds: 2000,
			});
			const source = tone(rate, Math.round(rate * 1.5));
			insertChunks(playout, rate, [source, Float32Array.from(source, (sample) => -sample)]);
			const outputFrames = Math.round(rate * 0.5);
			const output = render(playout, 2, outputFrames);
			let stereoError = 0;
			for (let i = 0; i < outputFrames; i++)
				stereoError = Math.max(stereoError, Math.abs(output[0][i] + output[1][i]));
			const timestampSamples = ((playout.timestamp ?? 0) * rate) / 1e6;
			expect(playout.stats.accelerated).toBeGreaterThan(0);
			expect(playout.stats.expanded).toBe(0);
			expect(stereoError).toBe(0);
			expect(timestampSamples).toBeCloseTo(playout.stats.consumed, 7);
			expect(playout.stats.consumed).toBeCloseTo(
				outputFrames + playout.stats.accelerated - playout.stats.expanded,
				7,
			);
		});

		test(`keeps the source clock exact while expanding at ${rate} Hz`, () => {
			const playout = new Playout({
				rate,
				channels: 1,
				target: { kind: "fixed", milliseconds: 200 },
				capacityMilliseconds: 2000,
			});
			insertChunks(playout, rate, [tone(rate, Math.round(rate * 0.2))]);
			const outputFrames = Math.round(rate * 0.1);
			render(playout, 1, outputFrames);
			const timestampSamples = ((playout.timestamp ?? 0) * rate) / 1e6;
			expect(playout.stats.expanded).toBeGreaterThan(0);
			expect(playout.stats.accelerated).toBe(0);
			expect(timestampSamples).toBeCloseTo(playout.stats.consumed, 7);
			expect(playout.stats.consumed).toBeCloseTo(
				outputFrames + playout.stats.accelerated - playout.stats.expanded,
				7,
			);
		});
	}

	test("learns stationary flat backgrounds at increasing levels and eventually corrects drift", () => {
		const rate = 8000;
		const firstCorrections: number[] = [];
		for (const amplitude of [0.01, 0.05, 0.2]) {
			const seconds = 13;
			const playout = new Playout({
				rate,
				channels: 2,
				target: { kind: "fixed", milliseconds: 40 },
				capacityMilliseconds: seconds * 1000,
			});
			insertChunks(playout, rate, [noise(rate * seconds, amplitude, 1), noise(rate * seconds, amplitude, 2)]);
			let firstCorrection = Infinity;
			for (let frame = 0; frame < rate * 12; frame += 128) {
				playout.render([new Float32Array(128), new Float32Array(128)], frame);
				if (firstCorrection === Infinity && playout.stats.accelerated > 0) firstCorrection = frame / rate;
			}
			firstCorrections.push(firstCorrection);
			expect(playout.stats.accelerated).toBeGreaterThan(0);
			const expanded = playout.stats.expanded;
			playout.configure({ target: { kind: "fixed", milliseconds: 2000 } });
			render(playout, 2, rate * 0.3, rate * 12);
			expect(playout.stats.expanded).toBeGreaterThan(expanded);
		}
		expect(firstCorrections[0]).toBeLessThan(0.2);
		expect(firstCorrections[1]).toBeGreaterThan(1);
		expect(firstCorrections[1]).toBeLessThan(4);
		expect(firstCorrections[2]).toBeGreaterThan(8);
		expect(firstCorrections[2]).toBeLessThan(12);
	});
});

describe("content-aware concealment", () => {
	const rate = 48000;
	const sourceLength = rate * 0.1;
	const gapLength = rate * 0.1;
	const recoveryLength = rate * 0.02;

	function conceal(
		planes: Float32Array[],
		recovery: Float32Array[],
	): { output: Float32Array[]; stats: Playout["stats"] } {
		const playout = new Playout({
			rate,
			channels: planes.length,
			target: { kind: "fixed", milliseconds: 0 },
			buffered: true,
		});
		insertChunks(playout, rate, planes);
		insertChunks(playout, rate, recovery, sourceLength + gapLength);
		playout.end(((sourceLength + gapLength + recoveryLength) * 1e6) / rate);
		return {
			output: render(playout, planes.length, sourceLength + gapLength + recoveryLength),
			stats: playout.stats,
		};
	}

	test("keeps voiced tone periodic while fading loss and recovery without a boundary spike", () => {
		const source = tone(rate, sourceLength);
		const recovery = Float32Array.from(
			{ length: recoveryLength },
			(_, i) => 0.3 * Math.sin((2 * Math.PI * 200 * (sourceLength + gapLength + i)) / rate),
		);
		const { output, stats } = conceal([source], [recovery]);
		const gap = output[0].subarray(sourceLength, sourceLength + gapLength);
		const normalized = Float32Array.from(
			gap.subarray(0, rate * 0.05),
			(sample, i) => sample / (1 - i / (rate * 0.06)),
		);
		expect(maximumLagCorrelation(normalized, rate * 0.004, rate * 0.006)).toBeGreaterThan(0.99);
		expect(Math.abs(gap[0] - source[source.length - 1])).toBeLessThan(0.02);
		expect(rms(gap.subarray(rate * 0.05, rate * 0.06))).toBeLessThan(rms(gap.subarray(0, rate * 0.01)) * 0.3);
		expect(gap.subarray(rate * 0.06).every((sample) => sample === 0)).toBe(true);
		expect(Math.abs(output[0][sourceLength + gapLength])).toBeLessThan(0.02);
		expect(stats.concealed).toBe(rate * 0.06);
		expect(stats.silent).toBe(rate * 0.04);
	});

	test("turns flat stereo noise into nonperiodic colored residual without collapsing its image", () => {
		const left = noise(sourceLength, 0.2, 3);
		const independent = noise(sourceLength, 0.2, 4);
		const right = Float32Array.from(left, (sample, i) => sample * 0.6 + independent[i] * 0.8);
		const recoveryLeft = noise(recoveryLength, 0.2, 5);
		const recoveryIndependent = noise(recoveryLength, 0.2, 6);
		const recoveryRight = Float32Array.from(
			recoveryLeft,
			(sample, i) => sample * 0.6 + recoveryIndependent[i] * 0.8,
		);
		const { output } = conceal([left, right], [recoveryLeft, recoveryRight]);
		const begin = sourceLength + rate * 0.005;
		const end = sourceLength + rate * 0.03;
		const gainNormalized = output.map((channel) =>
			Float32Array.from(
				channel.subarray(begin, end),
				(sample, i) => sample / (1 - (i + rate * 0.005) / (rate * 0.06)),
			),
		);
		const inputCorrelation = correlation(left.subarray(rate * 0.06), right.subarray(rate * 0.06));
		const concealedCorrelation = correlation(gainNormalized[0], gainNormalized[1]);
		expect(maximumLagCorrelation(gainNormalized[0], rate * 0.0025, rate * 0.01)).toBeLessThan(0.4);
		expect(Math.abs(concealedCorrelation - inputCorrelation)).toBeLessThan(0.15);
		expect(rms(gainNormalized[0])).toBeGreaterThan(rms(left) * 0.5);
		expect(rms(gainNormalized[0])).toBeLessThan(rms(left) * 1.5);
		let peak = 0;
		for (const sample of output[0].subarray(sourceLength, sourceLength + rate * 0.06))
			peak = Math.max(peak, Math.abs(sample));
		expect(peak).toBeLessThan(0.5);
	});

	test("preserves exact anti-phase stereo through noise concealment", () => {
		const left = noise(sourceLength, 0.2, 7);
		const right = Float32Array.from(left, (sample) => -sample);
		const recovery = noise(recoveryLength, 0.2, 8);
		const { output } = conceal([left, right], [recovery, Float32Array.from(recovery, (sample) => -sample)]);
		let error = 0;
		for (let i = sourceLength; i < sourceLength + gapLength; i++) {
			error = Math.max(error, Math.abs(output[0][i] + output[1][i]));
		}
		expect(error).toBe(0);
	});
});

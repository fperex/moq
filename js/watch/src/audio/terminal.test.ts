import { expect, test } from "bun:test";
import type { Time } from "@moq/net";
import { Terminal } from "./terminal";

test("Terminal trims a partial packet to the source endpoint", () => {
	const terminal = new Terminal();
	terminal.update({ discontinuity: 0, frame: { timestamp: 0 as Time.Micro }, end: 17_916 as Time.Micro });
	expect(terminal.span({ timestamp: 0, sampleRate: 48_000, numberOfFrames: 960 }).frames).toBe(860);
});

test("Terminal maps Opus delay back before trimming terminal output", () => {
	const terminal = new Terminal();
	terminal.clear(312);
	terminal.update({ discontinuity: 0, frame: { timestamp: 0 as Time.Micro } });
	const body = terminal.span({ timestamp: 0, sampleRate: 48_000, numberOfFrames: 960 });
	expect(body).toEqual({ timestamp: 0 as Time.Micro, frameOffset: 312, frames: 648 });

	terminal.update({ discontinuity: 0, end: 20_000 as Time.Micro });
	terminal.update({ discontinuity: 0, frame: { timestamp: 20_000 as Time.Micro } });
	const drain = terminal.span({ timestamp: 20_000, sampleRate: 48_000, numberOfFrames: 960 });
	expect(drain).toEqual({ timestamp: 13_500 as Time.Micro, frameOffset: 0, frames: 312 });
	expect(body.frames + drain.frames).toBe(960);
});

test("Terminal preserves samples before the source endpoint", () => {
	const terminal = new Terminal();
	terminal.update({ discontinuity: 0, frame: { timestamp: 0 as Time.Micro }, end: 20_000 as Time.Micro });
	expect(terminal.span({ timestamp: 0, sampleRate: 48_000, numberOfFrames: 960 }).frames).toBe(960);
});

test("a rewound endpoint survives the discontinuity reset and trims its terminal packet", () => {
	const terminal = new Terminal();
	terminal.clear(312);
	terminal.update({ discontinuity: 0, end: 40_000 as Time.Micro });

	const reset = terminal.update({ discontinuity: 1, end: 20_000 as Time.Micro });
	expect(reset).toBe(true);
	expect(terminal.end).toBe(20_000 as Time.Micro);

	terminal.update({ discontinuity: 1, frame: { timestamp: 20_000 as Time.Micro } });
	const span = terminal.span({ timestamp: 20_000, sampleRate: 48_000, numberOfFrames: 960 });
	expect(span).toEqual({ timestamp: 20_000 as Time.Micro, frameOffset: 312, frames: 0 });
});

test("a discontinuity reapplies Opus pre-skip in the resumed epoch", () => {
	const terminal = new Terminal();
	terminal.clear(312);
	terminal.update({ discontinuity: 0, frame: { timestamp: 0 as Time.Micro } });
	expect(terminal.span({ timestamp: 0, sampleRate: 48_000, numberOfFrames: 960 }).frameOffset).toBe(312);

	terminal.update({ discontinuity: 1, frame: { timestamp: 1_000_000 as Time.Micro } });
	const resumed = terminal.span({ timestamp: 1_000_000, sampleRate: 48_000, numberOfFrames: 960 });
	expect(resumed).toEqual({ timestamp: 1_000_000 as Time.Micro, frameOffset: 312, frames: 648 });
});

test("queued spans restore a source timestamp gap collapsed by decoder output", () => {
	const terminal = new Terminal();
	terminal.push({ timestamp: 100_000 as Time.Micro, duration: 20_000 as Time.Micro });
	terminal.push({ timestamp: 1_000_000 as Time.Micro, duration: 20_000 as Time.Micro });

	expect(terminal.spans({ timestamp: 100_000, sampleRate: 48_000, numberOfFrames: 1_920 })).toEqual([
		{ timestamp: 100_000 as Time.Micro, frameOffset: 0, frames: 960 },
		{ timestamp: 1_000_000 as Time.Micro, frameOffset: 960, frames: 960 },
	]);
});

test("one queued span can be consumed across decoder callbacks", () => {
	const terminal = new Terminal();
	terminal.push({ timestamp: 500_000 as Time.Micro, duration: 20_000 as Time.Micro });

	expect(terminal.spans({ timestamp: 0, sampleRate: 48_000, numberOfFrames: 400 })).toEqual([
		{ timestamp: 500_000 as Time.Micro, frameOffset: 0, frames: 400 },
	]);
	expect(terminal.spans({ timestamp: 8_333, sampleRate: 48_000, numberOfFrames: 560 })).toEqual([
		{ timestamp: (500_000 + (400 * 1_000_000) / 48_000) as Time.Micro, frameOffset: 0, frames: 560 },
	]);
});

test("queued spans preserve variable packet durations", () => {
	const terminal = new Terminal();
	terminal.push({ timestamp: 0 as Time.Micro, duration: 2_500 as Time.Micro });
	terminal.push({ timestamp: 50_000 as Time.Micro, duration: 60_000 as Time.Micro });

	expect(terminal.spans({ timestamp: 0, sampleRate: 48_000, numberOfFrames: 3_000 })).toEqual([
		{ timestamp: 0 as Time.Micro, frameOffset: 0, frames: 120 },
		{ timestamp: 50_000 as Time.Micro, frameOffset: 120, frames: 2_880 },
	]);
});

test("mapped timing runs preserve every decoded frame across quantized source timestamps", () => {
	for (const [sampleRate, duration, frames] of [
		[44_100, 23_220, 1_024],
		[48_000, 21_333, 1_024],
		[96_000, 10_667, 1_024],
	] as const) {
		const terminal = new Terminal();
		for (let packet = 0; packet < 10_001; packet++) {
			const timestamp = Math.round((packet * frames * 1_000_000) / sampleRate) as Time.Micro;
			terminal.push({ timestamp, duration: duration as Time.Micro });
		}

		let endFrame = 0;
		for (let packet = 0; packet < 10_001; packet++) {
			const [span] = terminal.spans({ timestamp: 0, sampleRate, numberOfFrames: frames });
			const startFrame = Math.round((span.timestamp * sampleRate) / 1_000_000);
			expect({ startFrame, frameOffset: span.frameOffset, frames: span.frames }).toEqual({
				startFrame: endFrame,
				frameOffset: 0,
				frames,
			});
			endFrame += span.frames;
		}
		expect(endFrame).toBe(10_001 * frames);
	}
});

test("Safari AAC timestamp quantization would leave holes without timing-run normalization", () => {
	const sampleRate = 44_100;
	const frames = 1_024;
	const duration = 23_220 as Time.Micro;
	const timestamps = [
		73_624_933_366, 73_624_956_644, 73_624_979_855, 73_625_003_066, 73_625_026_277, 73_625_049_488, 73_625_072_700,
		73_625_095_911,
	] as Time.Micro[];
	const rawStarts = timestamps.map((timestamp) => Math.round((timestamp * sampleRate) / 1_000_000));
	expect(rawStarts.slice(1).map((start, index) => start - rawStarts[index] - frames)).toEqual([
		3, 0, -1, 0, -1, 0, 0,
	]);

	const terminal = new Terminal();
	for (const timestamp of timestamps) terminal.push({ timestamp, duration });

	let endFrame: number | undefined;
	let retained = 0;
	for (let packet = 0; packet < timestamps.length; packet++) {
		const [span] = terminal.spans({ timestamp: 0, sampleRate, numberOfFrames: frames });
		const startFrame = Math.round((span.timestamp * sampleRate) / 1_000_000);
		if (endFrame !== undefined) expect(startFrame).toBe(endFrame);
		endFrame = startFrame + span.frames;
		retained += span.frames;
	}
	expect(retained).toBe(timestamps.length * frames);
});

test("queued spans apply pre-skip without assuming callback boundaries", () => {
	const terminal = new Terminal();
	terminal.clear(312);
	terminal.push({ timestamp: 0 as Time.Micro, duration: 20_000 as Time.Micro });
	terminal.push({ timestamp: 20_000 as Time.Micro, duration: 20_000 as Time.Micro });

	expect(terminal.spans({ timestamp: 0, sampleRate: 48_000, numberOfFrames: 960 })).toEqual([
		{ timestamp: 0 as Time.Micro, frameOffset: 312, frames: 648 },
	]);
	expect(terminal.spans({ timestamp: 20_000, sampleRate: 48_000, numberOfFrames: 960 })).toEqual([
		{ timestamp: 13_500 as Time.Micro, frameOffset: 0, frames: 960 },
	]);
});

test("pre-skip debt does not cross a source timestamp gap", () => {
	const terminal = new Terminal();
	terminal.clear(312);
	terminal.push({ timestamp: 0 as Time.Micro, duration: 20_000 as Time.Micro });
	terminal.push({ timestamp: 1_000_000 as Time.Micro, duration: 20_000 as Time.Micro });

	expect(terminal.spans({ timestamp: 0, sampleRate: 48_000, numberOfFrames: 960 })).toEqual([
		{ timestamp: 0 as Time.Micro, frameOffset: 312, frames: 648 },
	]);
	expect(terminal.spans({ timestamp: 20_000, sampleRate: 48_000, numberOfFrames: 960 })).toEqual([
		{ timestamp: 1_000_000 as Time.Micro, frameOffset: 0, frames: 960 },
	]);
});

test("a gap during pre-skip starts a new timing run", () => {
	const terminal = new Terminal();
	terminal.clear(312);
	terminal.push({ timestamp: 0 as Time.Micro, duration: 2_500 as Time.Micro });
	terminal.push({ timestamp: 1_000_000 as Time.Micro, duration: 20_000 as Time.Micro });
	terminal.push({ timestamp: 1_020_000 as Time.Micro, duration: 20_000 as Time.Micro });

	expect(terminal.spans({ timestamp: 0, sampleRate: 48_000, numberOfFrames: 120 })).toEqual([]);
	expect(terminal.spans({ timestamp: 2_500, sampleRate: 48_000, numberOfFrames: 960 })).toEqual([
		{ timestamp: 1_000_000 as Time.Micro, frameOffset: 192, frames: 768 },
	]);
	expect(terminal.spans({ timestamp: 22_500, sampleRate: 48_000, numberOfFrames: 960 })).toEqual([
		{ timestamp: 1_016_000 as Time.Micro, frameOffset: 0, frames: 960 },
	]);
});

test("queued spans trim terminal padding and reset at a discontinuity", () => {
	const terminal = new Terminal();
	terminal.update({ discontinuity: 0, end: 15_000 as Time.Micro });
	terminal.push({ timestamp: 0 as Time.Micro, duration: 20_000 as Time.Micro });
	expect(terminal.spans({ timestamp: 0, sampleRate: 48_000, numberOfFrames: 960 })).toEqual([
		{ timestamp: 0 as Time.Micro, frameOffset: 0, frames: 720 },
	]);

	expect(terminal.update({ discontinuity: 1, frame: { timestamp: 1_000_000 as Time.Micro } })).toBe(true);
	terminal.push({ timestamp: 1_000_000 as Time.Micro, duration: 20_000 as Time.Micro });
	expect(terminal.spans({ timestamp: 0, sampleRate: 48_000, numberOfFrames: 960 })).toEqual([
		{ timestamp: 1_000_000 as Time.Micro, frameOffset: 0, frames: 960 },
	]);
});

test("unknown-duration epochs keep decoder timestamp fallback", () => {
	const terminal = new Terminal();
	terminal.push({ timestamp: 700_000 as Time.Micro });
	expect(terminal.spans({ timestamp: 700_000, sampleRate: 48_000, numberOfFrames: 960 })).toEqual([
		{ timestamp: 700_000 as Time.Micro, frameOffset: 0, frames: 960 },
	]);
	terminal.push({ timestamp: 720_000 as Time.Micro, duration: 20_000 as Time.Micro });
	expect(terminal.spans({ timestamp: 720_000, sampleRate: 48_000, numberOfFrames: 960 })).toEqual([
		{ timestamp: 720_000 as Time.Micro, frameOffset: 0, frames: 960 },
	]);
	expect(() => terminal.push({ timestamp: 0 as Time.Micro, duration: 0 as Time.Micro })).toThrow(
		"encoded audio duration must be positive",
	);
});

test("a mapped epoch rejects missing source duration and excess decoder output", () => {
	const terminal = new Terminal();
	terminal.push({ timestamp: 0 as Time.Micro, duration: 20_000 as Time.Micro });
	expect(() => terminal.push({ timestamp: 20_000 as Time.Micro })).toThrow(
		"encoded audio duration became unknown within a mapped codec epoch",
	);
	expect(() => terminal.spans({ timestamp: 0, sampleRate: 48_000, numberOfFrames: 961 })).toThrow(
		"decoded audio exceeds queued source duration",
	);
});

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

test("Terminal reports a hole in the source the decoder would swallow", () => {
	const terminal = new Terminal();
	terminal.clear();

	// Nothing to measure against until a frame has decoded and named the frame duration.
	expect(terminal.continues(0 as Time.Micro)).toBe(true);
	terminal.span({ timestamp: 0, sampleRate: 48_000, numberOfFrames: 960 });

	// The normal cadence, including the rounding a container's integer timestamps carry.
	expect(terminal.continues(20_000 as Time.Micro)).toBe(true);
	expect(terminal.continues(40_001 as Time.Micro)).toBe(true);
	expect(terminal.continues(59_999 as Time.Micro)).toBe(true);

	// One frame missing is already a hole: a decoder told nothing about it keeps timestamping its
	// output on the old run, so every sample after it lands 20ms in the past.
	expect(terminal.continues(100_000 as Time.Micro)).toBe(false);

	// The frame that opens the new run continues it.
	terminal.reanchor();
	expect(terminal.continues(120_000 as Time.Micro)).toBe(true);
});

test("Terminal starts a fresh run at a codec epoch rather than measuring across the break", () => {
	const terminal = new Terminal();
	terminal.clear();
	terminal.update({ discontinuity: 0, frame: { timestamp: 0 as Time.Micro } });
	expect(terminal.continues(0 as Time.Micro)).toBe(true);
	terminal.span({ timestamp: 0, sampleRate: 48_000, numberOfFrames: 960 });

	// The caller already resets the decoder on an epoch change, so the first frame of the new epoch
	// must not ask for a second one however far it sits from the last frame of the old.
	expect(terminal.update({ discontinuity: 1, frame: { timestamp: 9_000_000 as Time.Micro } })).toBe(true);
	expect(terminal.continues(9_000_000 as Time.Micro)).toBe(true);
});

test("Terminal re-anchors on the frame after the hole rather than one later", () => {
	const terminal = new Terminal();
	terminal.clear();
	terminal.continues(0 as Time.Micro);
	terminal.span({ timestamp: 0, sampleRate: 48_000, numberOfFrames: 960 });

	expect(terminal.continues(3_000_000 as Time.Micro)).toBe(false);
	terminal.reanchor();
	// The re-anchored run still knows where it started, so a second hole right behind the first is
	// reported too.
	expect(terminal.continues(6_000_000 as Time.Micro)).toBe(false);
});

test("a declared break reopens a timeline that ended", () => {
	// A muted publisher declares where its timeline stops, and declares a break when it resumes:
	// an endpoint trims everything past it, so without the break the watcher would never hear the
	// talker again.
	const terminal = new Terminal();
	terminal.update({ discontinuity: 0, frame: { timestamp: 0 as Time.Micro }, end: 20_000 as Time.Micro });
	expect(terminal.end).toBe(20_000 as Time.Micro);

	expect(terminal.update({ discontinuity: 1, frame: { timestamp: 10_020_000 as Time.Micro } })).toBe(true);
	expect(terminal.end).toBeUndefined();
	expect(terminal.span({ timestamp: 10_020_000, sampleRate: 48_000, numberOfFrames: 960 }).frames).toBe(960);
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

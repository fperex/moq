import { expect, jest, test } from "bun:test";
import type MoqWatch from "@moq/watch/element";
import { probe, threadOf } from "./probe.ts";

// Only what `threadOf` reads: `audio.out`, with or without the signal.
const watch = (out: Record<string, unknown>) => ({ audio: { out }, sync: { out: {} } }) as unknown as MoqWatch;
const signal = (value: unknown) => ({ peek: () => value });

test("a build with the signal says which thread feeds the ring", () => {
	expect(threadOf(watch({ thread: signal({ kind: "worker", transport: "webtransport" }) }))).toEqual({
		kind: "worker",
		transport: "webtransport",
	});
	expect(threadOf(watch({ thread: signal({ kind: "main", reason: "refused" }) }))).toEqual({
		kind: "main",
		reason: "refused",
	});
});

test("a worker still starting is pending, not a build that cannot say", () => {
	expect(threadOf(watch({ thread: signal(undefined) }))).toEqual({ kind: "pending" });
	expect(threadOf(watch({}))).toBeUndefined();
});

test("the probe sums buffered ranges and tolerates builds without a range list", () => {
	jest.useFakeTimers();
	try {
		for (const [buffered, expected] of [
			[
				[
					{ start: 0, end: 40 },
					{ start: 60, end: 100 },
				],
				80,
			],
			[12, undefined],
			[{}, undefined],
			[undefined, undefined],
			[[], undefined],
		] as const) {
			const running = probe(watch({ buffered: signal(buffered) }));
			try {
				jest.advanceTimersByTime(250);
				const samples = running.drain();
				expect(samples).toHaveLength(1);
				expect(samples[0].buffered).toBe(expected);
			} finally {
				running.stop();
			}
		}
	} finally {
		jest.useRealTimers();
	}
});

test("the probe copies ring counters and identifies replacement graphs", () => {
	jest.useFakeTimers();
	let root = {};
	const debug = { anchor: 0, skips: 1, skipped: 1024 };
	const running = probe(
		watch({
			root: { peek: () => root },
			context: signal({ sampleRate: 44100 }),
			debug: signal(debug),
		}),
	);
	try {
		jest.advanceTimersByTime(250);
		const first = running.drain()[0];
		debug.skips = 2;
		root = {};
		jest.advanceTimersByTime(250);
		const next = running.drain()[0];
		expect(first.playout?.skips).toBe(1);
		expect(first.playout?.rate).toBe(44100);
		expect(next.playout?.skips).toBe(2);
		expect(next.playout?.generation).toBe((first.playout?.generation ?? 0) + 1);
	} finally {
		running.stop();
		jest.useRealTimers();
	}
});

for (const failure of ["constructor", "connect"] as const) {
	test(`a replacement analyser ${failure} failure cannot sample the previous graph`, () => {
		jest.useFakeTimers();
		const original = Object.getOwnPropertyDescriptor(globalThis, "AnalyserNode");
		let replacing = false;
		Object.defineProperty(globalThis, "AnalyserNode", {
			configurable: true,
			value: class {
				fftSize = 2048;
				constructor() {
					if (replacing && failure === "constructor") throw new Error("constructor failed");
				}
				getFloatTimeDomainData(pcm: Float32Array) {
					pcm.fill(0.5);
				}
			},
		});
		const node = () => ({
			context: {},
			connect() {
				if (replacing && failure === "connect") throw new Error("connect failed");
			},
		});
		let root = node();
		const running = probe(watch({ root: { peek: () => root } }));
		try {
			jest.advanceTimersByTime(250);
			expect(running.drain()[0].rms).toBe(0.5);
			replacing = true;
			root = node();
			jest.advanceTimersByTime(500);
			expect(running.drain().map((sample) => sample.rms)).toEqual([undefined, undefined]);
			expect(running.notes()).toEqual([`analyser: ${failure} failed`]);
		} finally {
			running.stop();
			if (original) Object.defineProperty(globalThis, "AnalyserNode", original);
			else Reflect.deleteProperty(globalThis, "AnalyserNode");
			jest.useRealTimers();
		}
	});
}

#!/usr/bin/env bun
/**
 * moq-playout-01 conformance corpus.
 *
 * `bun js/hang/src/container/jitter.vectors.ts` verifies rs/moq-audio/tests/playout-01.json
 * against {@link Jitter}. `--write` regenerates it.
 *
 * The corpus is the parity contract between `@moq/hang` and `moq-audio`: both run these traces and
 * must produce these targets. The algorithm is `doc/concept/playout.md`; this file is only the
 * traces and the harness that replays them.
 *
 * Every trace is built procedurally from a seeded PRNG so a reviewer reads the shape rather than a
 * wall of numbers, and every arrival lands on a 0.25 ms grid so the arithmetic is exact in f64.
 *
 * @module
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Time } from "@moq/net";
import { Jitter } from "./jitter.ts";

/** The corpus format, so a reader can tell a schema change from a value change. */
export const ALGORITHM = "moq-playout-01";

/** One frame arriving, as the corpus records it. */
export type Arrival = {
	/** The frame's media timestamp, microseconds. */
	timestamp_us: number;
	/** When it arrived, milliseconds on the receiver's monotonic clock. */
	arrival_ms: number;
	/** Force the reordered path, for a trace whose delivery order the timestamps do not show. */
	reordered?: boolean;
	/** Call `reanchor()` before observing, i.e. a timeline discontinuity landed here. */
	reanchor_before?: boolean;
};

/** One trace and the target series it must produce. */
export type Case = {
	name: string;
	description: string;
	/** The publisher's declared flush span this trace starts from, when it declares one. */
	start_ms?: number;
	arrivals: Arrival[];
	/** The target after each arrival, milliseconds, always a whole bucket. */
	target_ms: number[];
};

/** The whole corpus, as it is written to disk. */
export type Corpus = {
	algorithm: string;
	constants: {
		bucket_ms: number;
		buckets: number;
		quantile: number;
		forget: number;
		start_forget_weight: number;
		resample_ms: number;
		window_ms: number;
		start_ms: number;
		max_catchup: number;
		lower_interval_ms: number;
		lower_divisor: number;
	};
	cases: Case[];
};

const CONSTANTS: Corpus["constants"] = {
	bucket_ms: Jitter.BUCKET,
	buckets: 100,
	quantile: 0.95,
	forget: 0.983,
	start_forget_weight: 2,
	resample_ms: 500,
	window_ms: 2000,
	start_ms: 80,
	max_catchup: 60,
	lower_interval_ms: 1000,
	lower_divisor: 6,
};

/** Replay one trace through the estimator and collect the target after each arrival. */
export function replay(arrivals: Arrival[], start?: number): number[] {
	const jitter = new Jitter({ start: start as Time.Milli | undefined });
	const targets: number[] = [];

	for (const arrival of arrivals) {
		if (arrival.reanchor_before) jitter.reanchor();
		jitter.observe(arrival.timestamp_us as Time.Micro, arrival.arrival_ms as Time.Milli, arrival.reordered);
		targets.push(jitter.value.peek());
	}

	return targets;
}

/** Build the corpus from the case definitions below. */
export function generate(): Corpus {
	return {
		algorithm: ALGORITHM,
		constants: CONSTANTS,
		cases: cases().map(({ name, description, start_ms, arrivals }) => ({
			name,
			description,
			...(start_ms === undefined ? {} : { start_ms }),
			arrivals,
			target_ms: replay(arrivals, start_ms),
		})),
	};
}

// --- Traces ---

// mulberry32: 32 bits of state, no dependency, identical everywhere. Only used to shape a trace,
// never inside the estimator.
function prng(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

// Quantise to the 0.25 ms grid so every arrival and every difference between two of them is exact
// in f64, in V8 and in rustc alike.
function grid(ms: number): number {
	return Math.round(ms * 4) / 4;
}

const FRAME_MS = 20;

// A publisher flushing `burst` frames at a time down a path with `spread` ms of wall-clock jitter.
function paced(
	options: { frames: number; burst?: number; base?: number; spread?: number; seed?: number; start?: number } = {
		frames: 0,
	},
): Arrival[] {
	const { frames, burst = 1, base = 50, spread = 0, seed = 1, start = 0 } = options;
	const random = prng(seed);
	const arrivals: Arrival[] = [];

	for (let i = 0; i < frames; i++) {
		// The whole burst leaves the publisher when its last frame is encoded.
		const flush = Math.floor(i / burst) * burst + (burst - 1);
		const jitter = spread === 0 ? 0 : grid(random() * spread);
		arrivals.push({
			timestamp_us: (start + i * FRAME_MS) * 1000,
			arrival_ms: grid(start + flush * FRAME_MS + base + jitter),
		});
	}

	return arrivals;
}

function shift(arrivals: Arrival[], ms: number): Arrival[] {
	return arrivals.map((a) => ({ ...a, arrival_ms: grid(a.arrival_ms + ms) }));
}

// A receiver whose read loop stops for `stall` ms at `at`. The path is untouched: frames keep
// landing on time, they just queue until the loop runs again and then come back out of it one every
// `drain` ms, which is far faster than the media they carry.
function stalled(arrivals: Arrival[], options: { at: number; stall: number; drain: number }): Arrival[] {
	const { at, stall, drain } = options;
	let cursor = at + stall;

	return arrivals.map((a) => {
		if (a.arrival_ms < at) return a;
		const read = Math.max(a.arrival_ms, cursor);
		cursor = read + drain;
		return { ...a, arrival_ms: grid(read) };
	});
}

function cases(): { name: string; description: string; start_ms?: number; arrivals: Arrival[] }[] {
	return [
		{
			name: "steady",
			description: "300 evenly paced 20ms frames with 2ms of path jitter: converges from 80ms to 20ms.",
			arrivals: paced({ frames: 300, base: 50, spread: 2, seed: 11 }),
		},
		{
			name: "steady-far",
			description:
				"The steady trace 2000ms further down the path. The target only reads differences, so the series is identical.",
			arrivals: shift(paced({ frames: 300, base: 50, spread: 2, seed: 11 }), 2000),
		},
		{
			name: "burst-2",
			description: "A publisher flushing two frames at once: the target reads its 20ms flush span.",
			arrivals: paced({ frames: 300, burst: 2, base: 50, spread: 1, seed: 23 }),
		},
		{
			name: "burst-7",
			description:
				"Seven AAC frames per PES, the packing ffmpeg defaults to and the public relay serves. 140ms of flush span, which no round-trip estimate can see.",
			arrivals: paced({ frames: 301, burst: 7, base: 50, spread: 1, seed: 29 }),
		},
		{
			name: "slow-buildup",
			description:
				"A path degrading 2ms per frame for 100 frames, then holding. An inter-arrival estimator reads this as 100 tiny deltas; against the fastest recent arrival it reads as the delay it is.",
			arrivals: (() => {
				const arrivals = paced({ frames: 300, base: 50, spread: 1, seed: 31 });
				for (let i = 0; i < arrivals.length; i++) {
					arrivals[i].arrival_ms = grid(arrivals[i].arrival_ms + Math.min(i, 100) * 2);
				}
				return arrivals;
			})(),
		},
		{
			name: "step-change",
			description:
				"The path jumps 60ms at frame 100 and stays there. The target rises within one resample interval and holds while the histogram still remembers the step.",
			arrivals: (() => {
				const arrivals = paced({ frames: 400, base: 50, spread: 1, seed: 37 });
				for (let i = 100; i < arrivals.length; i++) {
					arrivals[i].arrival_ms = grid(arrivals[i].arrival_ms + 60);
				}
				return arrivals;
			})(),
		},
		{
			name: "reordered",
			description:
				"Every tenth pair of frames is delivered swapped. The older one is excluded from the reference and the histogram, so the target matches the steady trace.",
			arrivals: (() => {
				const arrivals = paced({ frames: 300, base: 50, spread: 2, seed: 11 });
				for (let i = 9; i + 1 < arrivals.length; i += 10) {
					const older = arrivals[i];
					const newer = arrivals[i + 1];
					// The older frame takes a detour and loses the race. The newer one keeps its own
					// arrival time, so nothing about the path has changed; only the delivery order has.
					arrivals[i] = newer;
					arrivals[i + 1] = { ...older, arrival_ms: grid(newer.arrival_ms + 1) };
				}
				return arrivals;
			})(),
		},
		{
			name: "tune-in-stale",
			description:
				"One frame of a stale group, then the live edge 14.56s later in media time, then 10s of clean audio. The regression from PR #3517, which read 14560ms here.",
			arrivals: (() => {
				const arrivals: Arrival[] = [
					{ timestamp_us: 0, arrival_ms: 0 },
					{ timestamp_us: 14_560_000, arrival_ms: 5 },
				];
				for (const a of paced({ frames: 500, base: 5, spread: 1, seed: 41, start: 14_580 })) arrivals.push(a);
				return arrivals;
			})(),
		},
		{
			name: "tune-in-stall",
			description:
				"The receiver's own read loop blocks for 1500ms four seconds in, the way a tune-in blocks it on a decoder polyfill, a worklet start and the first keyframe. The path never changes: frames keep landing on time, queue, and come back out at 3.25ms each once the loop runs again. Against a reference from before the block the first of them reads as 1500ms of delay that belongs to the receiver, so the target has to stay where the path put it.",
			arrivals: stalled(paced({ frames: 700, burst: 7, base: 50, spread: 1, seed: 73 }), {
				at: 4000,
				stall: 1500,
				drain: 3.25,
			}),
		},
		{
			name: "pause-10s",
			description:
				"Four seconds of 7-frame bursts, then nothing for 10s, then clean audio. The empty intervals decay the histogram toward a reset instead of preserving the bursty path.",
			arrivals: (() => {
				const arrivals = paced({ frames: 203, burst: 7, base: 50, spread: 1, seed: 43 });
				const resume = 14_060;
				for (const a of paced({ frames: 250, base: 50, spread: 1, seed: 47, start: resume })) arrivals.push(a);
				return arrivals;
			})(),
		},
		{
			name: "pause-10min",
			description:
				"The same trace with a ten minute gap. The empty-interval catch-up is capped at 60 intervals, so this converges exactly like a 30s gap.",
			arrivals: (() => {
				const arrivals = paced({ frames: 203, burst: 7, base: 50, spread: 1, seed: 43 });
				const resume = 604_060;
				for (const a of paced({ frames: 250, base: 50, spread: 1, seed: 47, start: resume })) arrivals.push(a);
				return arrivals;
			})(),
		},
		{
			name: "discontinuity",
			description:
				"The timeline rewinds to zero halfway through. reanchor() drops the reference, which describes a timeline that no longer exists, and keeps the distribution, which does not move.",
			arrivals: (() => {
				const arrivals = paced({ frames: 150, burst: 2, base: 50, spread: 1, seed: 53 });
				const after = paced({ frames: 150, burst: 2, base: 50, spread: 1, seed: 59 });
				const at = arrivals[arrivals.length - 1].arrival_ms + FRAME_MS;
				for (let i = 0; i < after.length; i++) {
					arrivals.push({
						...after[i],
						arrival_ms: grid(after[i].arrival_ms + at),
						...(i === 0 ? { reanchor_before: true } : {}),
					});
				}
				return arrivals;
			})(),
		},
		{
			name: "outlier",
			description:
				"The path stalls 2500ms at frame 150 and keeps the loss, so a run of arrivals reads past the histogram's 2000ms range. They are dropped rather than clamped into the last bucket, so the target never jumps to 2000ms.",
			arrivals: (() => {
				const arrivals = paced({ frames: 400, base: 50, spread: 1, seed: 61 });
				for (let i = 150; i < arrivals.length; i++) {
					arrivals[i].arrival_ms = grid(arrivals[i].arrival_ms + 2500);
				}
				return arrivals;
			})(),
		},
		{
			name: "sparse",
			description:
				"One frame per second. Two intervals close per arrival, one of them empty, so the target falls at the same wall-clock rate as a 50fps track.",
			arrivals: (() => {
				const arrivals = paced({ frames: 30, burst: 7, base: 50, spread: 1, seed: 67 });
				const random = prng(71);
				let ts = 30 * FRAME_MS;
				let at = arrivals[arrivals.length - 1].arrival_ms;
				for (let i = 0; i < 120; i++) {
					ts += 1000;
					at += 1000;
					arrivals.push({ timestamp_us: ts * 1000, arrival_ms: grid(at + random() * 2) });
				}
				return arrivals;
			})(),
		},
		{
			name: "seeded",
			description:
				"Twenty seconds of the steady trace on a publisher declaring a 310ms flush span. The declaration is the cold start, rounded up to a whole bucket, and the measurement then walks it down the ordinary fall bound to the same 20ms the unseeded trace settles on: a declaration is a prior, not a floor.",
			start_ms: 310,
			arrivals: paced({ frames: 1000, base: 50, spread: 2, seed: 11 }),
		},
	];
}

// --- Freshness check ---

const PATH = join(dirname(fileURLToPath(import.meta.url)), "../../../../rs/moq-audio/tests/playout-01.json");

/** Where the corpus lives, so the test suite and the generator cannot disagree about it. */
export const CORPUS_PATH = PATH;

/** Read the corpus from disk. */
export function load(): Corpus {
	return JSON.parse(readFileSync(PATH, "utf8")) as Corpus;
}

// One arrival per line and twenty targets per line. `JSON.stringify` with an indent spreads every
// arrival over four lines, which triples a file a reviewer already has to scroll.
function format(corpus: Corpus): string {
	const cases = corpus.cases.map((entry) => {
		const arrivals = entry.arrivals.map((a) => `\t\t\t\t${JSON.stringify(a)}`).join(",\n");

		const targets: string[] = [];
		for (let i = 0; i < entry.target_ms.length; i += 20) {
			targets.push(`\t\t\t\t${entry.target_ms.slice(i, i + 20).join(", ")}`);
		}

		return [
			"\t\t{",
			`\t\t\t"name": ${JSON.stringify(entry.name)},`,
			`\t\t\t"description": ${JSON.stringify(entry.description)},`,
			...(entry.start_ms === undefined ? [] : [`\t\t\t"start_ms": ${entry.start_ms},`]),
			'\t\t\t"arrivals": [',
			arrivals,
			"\t\t\t],",
			'\t\t\t"target_ms": [',
			targets.join(",\n"),
			"\t\t\t]",
			"\t\t}",
		].join("\n");
	});

	return [
		"{",
		`\t"algorithm": ${JSON.stringify(corpus.algorithm)},`,
		`\t"constants": ${JSON.stringify(corpus.constants, null, "\t").replaceAll("\n", "\n\t")},`,
		'\t"cases": [',
		cases.join(",\n"),
		"\t]",
		"}",
		"",
	].join("\n");
}

function main(): void {
	const generated = generate();

	if (process.argv.includes("--write")) {
		writeFileSync(PATH, format(generated));
	}

	if (JSON.stringify(load()) !== JSON.stringify(generated)) {
		throw new Error(
			"rs/moq-audio/tests/playout-01.json is stale; run bun js/hang/src/container/jitter.vectors.ts --write",
		);
	}

	const arrivals = generated.cases.reduce((n, c) => n + c.arrivals.length, 0);
	console.log(`${ALGORITHM}: ${generated.cases.length} cases, ${arrivals} arrivals`);
	for (const c of generated.cases) {
		console.log(`  ${c.name.padEnd(14)} settles at ${c.target_ms[c.target_ms.length - 1]}ms`);
	}
}

if (import.meta.main) main();

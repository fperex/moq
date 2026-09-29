/**
 * A synthetic row for the quiet-window proof: a source with a moving level and an authored quiet
 * stretch, and the samples a page playing it through the ring would have recorded.
 *
 * The ring's timing is modelled the way the probe sees it: each sample reads the context clock and
 * the analyser together, and carries a ring report of some age whose playhead and `output` counter
 * came from the same quantum. Nothing here is a test; see `silence.test.ts` and `grade.test.ts`.
 *
 * @module
 */
import { RMS_FRAMES, type Sample } from "./schema.ts";
import type { Reference } from "./silence.ts";

/** The graph's rate, which the fixture's source is already at. */
export const RATE = 44100;

/** Where the source is authored quiet, in source seconds. */
export const QUIET = [30, 50] as const;

/** Media time minus source time: the container's start offset the fit has to find. */
const OFFSET_S = 1.3;

/** Context frames the ring spent short before it first played, so `output` lags the context clock. */
const LAG = 6000;

/** The media frame the ring's timeline is anchored at. */
const ANCHOR = 200_000;

/** Authored quiet stretches, in source seconds. */
type Quiet = readonly (readonly [number, number])[];

/** The source's level at `t` seconds: two slow swells, or a faint bed through a quiet stretch. */
function level(t: number, periods: readonly [number, number], quiet: Quiet): number {
	if (quiet.some(([from, to]) => t >= from && t < to)) return 0.0004 * (1 + 0.5 * Math.sin((2 * Math.PI * t) / 3.1));
	return 0.05 * (1.2 + Math.sin((2 * Math.PI * t) / periods[0])) * (1.2 + Math.sin((2 * Math.PI * t) / periods[1]));
}

/**
 * Onsets of 12 ms hits at irregular gaps of 80 to 400 ms, from a fixed seed: the transients that
 * make a window misplaced by a few milliseconds read differently, as they do in a film.
 */
function hits(seconds: number): number[] {
	let seed = 0x5eed;
	const next = () => {
		seed = (seed * 1103515245 + 12345) % 2 ** 31;
		return seed / 2 ** 31;
	};
	const onsets: number[] = [];
	for (let t = 0.1; t < seconds; t += 0.08 + 0.32 * next()) onsets.push(t);
	return onsets;
}

/**
 * `seconds` of mono source: a 440 Hz tone under {@link level}, with hits outside the `quiet` stretches.
 * Other `periods` make a different film.
 */
export function source(
	seconds = 85,
	periods: readonly [number, number] = [5.3, 1.7],
	quiet: Quiet = [QUIET],
): Float32Array {
	const pcm = new Float32Array(Math.round(seconds * RATE));
	const onsets = hits(seconds);
	let hit = 0;
	for (let i = 0; i < pcm.length; i++) {
		const t = i / RATE;
		while ((onsets[hit + 1] ?? Number.POSITIVE_INFINITY) <= t) hit++;
		const onset = onsets[hit] ?? Number.NEGATIVE_INFINITY;
		const hushed = quiet.some(([from, to]) => t >= from && t < to);
		const lift = !hushed && t >= onset && t < onset + 0.012 ? 4 : 1;
		pcm[i] = lift * level(t, periods, quiet) * Math.sin(2 * Math.PI * 440 * t);
	}
	return pcm;
}

/** The RMS of `pcm` over one analyser window starting at `start`. */
export function rms(pcm: Float32Array, start: number): number {
	let sum = 0;
	for (let i = start; i < start + RMS_FRAMES; i++) sum += (pcm[i] ?? 0) ** 2;
	return Math.sqrt(sum / RMS_FRAMES);
}

/** `pcm` as the analyzer would hand it over, nominally at media frame `start`. */
export function reference(pcm: Float32Array, start = 0): Reference {
	return {
		rate: RATE,
		start,
		pcm,
		provenance: {
			media: "fixture",
			sha256: "fixture",
			encode: [],
			decode: [],
			from: start / RATE,
			seconds: pcm.length / RATE,
			rate: RATE,
		},
	};
}

/** A ring report with nothing unusual in it. */
const report: NonNullable<Sample["playout"]> = {
	backend: "message",
	generation: 1,
	rate: RATE,
	anchor: ANCHOR,
	jumps: 0,
	jumped: 0,
	skips: 0,
	skipped: 0,
	discarded: 0,
	trimmed: 0,
	buffered: 11025,
	target: 11025,
	chunk: 1024,
	skip: 3308,
	stalled: false,
	fresh: false,
	underruns: 0,
	queued: 0,
	stretched: 0,
	output: 0,
	concealed: 0,
	accelerates: 0,
	expands: 0,
	merges: 0,
	short: 0,
};

/** Where the window of sample `i` starts in the source, with the analyser keeping up. */
export const windowStart = (i: number, stretched = 0): number =>
	Math.round(((250 * (i + 1) + 1000) * RATE) / 1000) -
	RMS_FRAMES -
	LAG +
	ANCHOR +
	stretched -
	Math.round(OFFSET_S * RATE);

/**
 * The samples a page playing `pcm` records: `count` of them, 250 ms apart.
 *
 * Every window's RMS is the source's own at the media time the ring was playing, so the row is an
 * exact rendering. `expandAt` inserts `expanded` frames by time stretch just before that sample's
 * report, which moves every later window's media time the way a real expansion does. From `behindAt`
 * on, the analyser's data runs one whole window behind the context clock, as Chromium's did once.
 */
export function samples(
	pcm: Float32Array,
	options: { count?: number; expandAt?: number; expanded?: number; behindAt?: number } = {},
): Sample[] {
	const {
		count = 280,
		expandAt = Number.POSITIVE_INFINITY,
		expanded = 300,
		behindAt = Number.POSITIVE_INFINITY,
	} = options;
	return Array.from({ length: count }, (_, i) => {
		const at = 250 * (i + 1);
		const contextTime = at + 1000;
		const frame = Math.round((contextTime * RATE) / 1000);
		// The report is up to eleven quanta old, as a relayed report is.
		const output = frame - 128 * ((i * 7) % 12) - LAG;
		const stretched = i >= expandAt ? -expanded : 0;
		const playhead = ANCHOR + output + stretched;
		const window = windowStart(i, stretched) - (i >= behindAt ? RMS_FRAMES : 0);
		return {
			at,
			timestamp: (playhead * 1000) / RATE,
			stalled: false,
			underruns: 0,
			contextTime,
			contextRate: RATE,
			rms: rms(pcm, window),
			playout: { ...report, output, stretched, expands: i >= expandAt ? 1 : 0 },
		};
	});
}

/** The graded window: everything after a five second warmup. */
export const graded = (all: Sample[]): Sample[] => all.slice(20);

/** The raw share the analyzer would report for `window`. */
export function share(window: Sample[]): number {
	const levels = window.flatMap((s) => (typeof s.rms === "number" ? [s.rms] : []));
	return Math.round((levels.filter((r) => r < 0.001).length / levels.length) * 1000) / 1000;
}

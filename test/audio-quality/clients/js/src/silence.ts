/**
 * Whether a row's quiet windows are the source's own quiet, proven window by window.
 *
 * `silence_share` counts every AnalyserNode window whose RMS is under the silence floor, and the
 * film this harness plays has quiet scenes of its own: the same row measures 0.11 or 0.26 depending
 * on which minute of it the row happens to play. The raw share and its ceiling stay exactly as they
 * are. A share over its ceiling is excused only by this proof: every quiet window lines up with a
 * quiet window of the source at the same media time. One quiet window over audible source, or one
 * that cannot be placed with confidence, keeps the failure.
 *
 * Placing a window takes nothing the page does not already record:
 *
 * - The context clock, read with the RMS: the window is the graph's last {@link RMS_FRAMES} frames.
 * - The ring's playhead and `output` counter, from one report. Their difference is the media frame
 *   the reader pairs with each output frame, and while the ring plays only a time stretch moves it.
 *   A concealment, skip, jump, discard, trim, or short quantum is counted, and refuses every window
 *   it could have touched.
 * - The reports either side, which bracket that difference across the window.
 *
 * That leaves one constant per row: the context frames the ring spent short before it first played,
 * plus the container's start offset. It is fitted by correlating log RMS over the audible windows
 * with the reference, and the fit has to be tight, cover enough audio, and agree on level before any
 * quiet window is placed with it.
 *
 * The AnalyserNode's data can also fall a whole window behind the context clock partway through a
 * row, with nothing else in the page changing. So each exact audible window votes for the lag at
 * which it matches the reference, the row splits into segments where that lag is constant, and every
 * segment has to prove its own lag with its own audible windows, to the same bars. A quiet window is
 * checked at its segment's proven lag only; one in an unproven segment, or between two segments where
 * nothing says which lag it had, is refused. Lags are whole windows, at most one apart.
 *
 * The reference is the audio the page decoded, not the film: the analyzer replays the publisher's own
 * encode of the looped file from the start of its stream, which reproduces the published packets byte
 * for byte, and decodes it the way the page does. Against the film itself, the codec's level change
 * alone moves a window sitting within a percent of the floor across it.
 *
 * @module
 */
import { frames, MAX_LAG } from "../../../../../js/watch/src/audio/playout/stretch.ts";
import {
	type Alignment,
	type Provenance,
	type QuietProof,
	type QuietWindow,
	RMS_FRAMES,
	type Sample,
	type Segment,
	SILENCE_RMS,
} from "./schema.ts";

/** How far either side of the playhead's own media time the fit looks for the source, in seconds. */
const SEARCH_S = 5;

/** The fit's first pass steps this far, in seconds, before it refines to single frames. */
const STEP_S = 0.005;

/** Audible windows the fit needs before its answer counts: ten seconds of sound. */
const MIN_AUDIBLE = 40;

/** Log RMS correlation the fit must reach. One render quantum of misalignment costs about this much. */
const MIN_CORRELATION = 0.999;

/** How far the output level may sit from the source's, so the floor means the same on both sides. */
const MAX_GAIN_ERROR = 0.05;

/** Log RMS is taken above this, so digital silence has a logarithm. About -120 dBFS. */
const FLOOR = 1e-6;

/** Whole analyser windows the segments of one row may sit apart. */
const MAX_BEHIND = 1;

/** An exact window votes for a lag when its log RMS matches the reference there within this... */
const MATCH = 0.02;

/** ...and misses it at every other lag by at least this. */
const MISS = 0.1;

/** Counters that step the media against the output, or put audio in it that no media carried. */
const DISCONTINUITIES = [
	"underruns",
	"short",
	"concealed",
	"merges",
	"skips",
	"skipped",
	"jumps",
	"jumped",
	"discarded",
	"trimmed",
] as const;

/** The audio a row's windows are placed in. */
export type Reference = {
	/** Frames per second: the graph's rate. */
	rate: number;
	/** The media frame `pcm[0]` nominally plays at: where the decoded span begins in the stream. */
	start: number;
	/** Mono, mixed the way the AnalyserNode mixes its stereo input: half of left plus right. */
	pcm: Float32Array;
	/** Where it came from. */
	provenance: Provenance;
};

/** One report's timing: where a sample's window sits against the media. */
type Timing = {
	/** The context frame the RMS was read at, the end of its window. */
	frame: number;
	/** The media frame the reader paired with output frame zero: playhead less `output`. */
	offset: number;
	/** Context frames the `output` counter trails the clock by: the short start plus the report's age. */
	trail: number;
};

function timing(sample: Sample | undefined): Timing | undefined {
	const playout = sample?.playout;
	if (!sample || !playout || typeof sample.contextTime !== "number" || typeof sample.timestamp !== "number") {
		return undefined;
	}
	const { rate, output } = playout;
	if (![sample.contextTime, sample.timestamp, rate, output].every(Number.isFinite) || rate <= 0) return undefined;
	const frame = Math.round((sample.contextTime * rate) / 1000);
	return { frame, offset: Math.round((sample.timestamp * rate) / 1000 - output), trail: frame - output };
}

/** The offsets a window may have been played at, or why it cannot be placed. */
type Bracket = { offsets: number[]; widen: number; clean: boolean } | { refused: string };

/**
 * Bracket the window of `samples[index]` between the reports either side of it.
 *
 * The window ends at its own sample and starts well after the previous one, and the next report is
 * taken after it ends, so any stretch that moved it shows up across those three. Between two reports,
 * one stretch moves the offset monotonically from one's value to the other's; each further stretch in
 * that interval can overshoot by at most one maximal stretch, so the bracket widens by that much.
 */
function bracket(samples: Sample[], index: number, maxStretch: number): Bracket {
	const before = samples[index - 1];
	const after = samples[index + 1];
	if (!before) return { refused: "no earlier report" };

	const reports = after ? [before, samples[index], after] : [before, samples[index]];
	const timings = reports.map(timing);
	const playouts = reports.map((r) => r?.playout);
	if (timings.some((t) => t === undefined)) return { refused: "timing" };
	const [first, ...rest] = playouts;
	if (!first) return { refused: "timing" };
	for (const [i, playout] of rest.entries()) {
		const previous = playouts[i];
		if (!playout || !previous) return { refused: "timing" };
		if (
			playout.generation !== first.generation ||
			playout.rate !== first.rate ||
			playout.output < previous.output ||
			playout.accelerates + playout.expands < previous.accelerates + previous.expands
		) {
			return { refused: "graph" };
		}
		if (playout.anchor !== first.anchor) return { refused: "timeline" };
		if (DISCONTINUITIES.some((key) => playout[key] !== first[key])) return { refused: "discontinuity" };
	}
	if (reports.some((r) => r?.stalled === true || r?.playout?.stalled === true)) return { refused: "stalled" };

	const stretched = playouts.map((p) => (p ? p.accelerates + p.expands : 0));
	const overshoot = Math.max(0, ...stretched.slice(1).map((n, i) => n - (stretched[i] ?? n) - 1));
	const offsets = timings.map((t) => t?.offset ?? 0);
	// The final window has no later report to close its bracket, so one maximal stretch either side of
	// its own offset stands in for one: whatever happened after its report is as unseen here as it is
	// by every other counter in the row.
	const widen = overshoot * maxStretch + (after ? 0 : maxStretch);
	// The fit learns only from exact windows: no stretch, and one offset across all three reports. The
	// shared ring's poll reads the playhead and its counters apart, so a quantum can land between them
	// and step the offset with no stretch counted; the bracket covers that, but the fit should not use it.
	const still = stretched.every((n) => n === stretched[0]) && Math.min(...offsets) === Math.max(...offsets);
	return { offsets, widen, clean: after !== undefined && still };
}

/**
 * The span of the publisher's stream a row's windows can map to, for the analyzer to decode: the
 * row's playheads, plus the fit's search and a margin either side, in whole seconds.
 */
export function locate(graded: Sample[]): { from: number; seconds: number } | { reason: string } {
	const media = graded.flatMap((s) =>
		typeof s.timestamp === "number" && Number.isFinite(s.timestamp) ? [s.timestamp / 1000] : [],
	);
	if (media.length === 0) return { reason: "no window has a playhead" };
	const from = Math.max(0, Math.floor(Math.min(...media) - SEARCH_S - 2));
	return { from, seconds: Math.ceil(Math.max(...media) + SEARCH_S + 2) - from };
}

/** Pearson correlation of two equally long series. */
function correlation(xs: number[], ys: number[]): number {
	const n = xs.length;
	let sx = 0;
	let sy = 0;
	let sxx = 0;
	let syy = 0;
	let sxy = 0;
	for (let i = 0; i < n; i++) {
		const x = xs[i] ?? 0;
		const y = ys[i] ?? 0;
		sx += x;
		sy += y;
		sxx += x * x;
		syy += y * y;
		sxy += x * y;
	}
	const den = Math.sqrt((n * sxx - sx * sx) * (n * syy - sy * sy));
	return den > 0 ? (n * sxy - sx * sy) / den : 0;
}

const median = (values: number[]): number | undefined =>
	[...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

/**
 * Prove, or refuse to prove, that every quiet window of `graded` lines up with quiet source.
 *
 * `samples` is the whole row, which the bracketing reports come from; `graded` is the window the raw
 * share counted, in the same objects. Without a reference, or with a string saying why there is none,
 * nothing is proven.
 */
export function prove(samples: Sample[], graded: Sample[], reference: Reference | string | undefined): QuietProof {
	const counted = graded.filter((s) => typeof s.rms === "number");
	const quiet = counted.filter((s) => (s.rms ?? 0) < SILENCE_RMS);
	const refuse = (reason: string, alignment: Alignment | null = null, why = "alignment"): QuietProof => ({
		proven: false,
		reason,
		windows: counted.length,
		quiet: quiet.length,
		matched: 0,
		alignment,
		segments: [],
		reference: typeof reference === "object" ? reference.provenance : null,
		quietWindows: quiet.map((s) => ({ at: s.at, rms: s.rms ?? 0, source: null, reference: null, refused: why })),
	});
	if (typeof reference !== "object") {
		return refuse(`no source reference: ${reference ?? "none was given"}`, null, "reference");
	}

	const rate = reference.rate;
	if (counted.some((s) => s.playout !== undefined && s.playout.rate !== rate)) {
		return refuse(`the graph ran at another rate than the ${rate} Hz reference`, null, "reference");
	}

	const position = new Map(samples.map((s, i) => [s, i] as const));
	const maxStretch = frames(rate, MAX_LAG);
	const placed = counted.map((sample) => {
		const index = position.get(sample);
		const bracketed: Bracket =
			index === undefined ? { refused: "no earlier report" } : bracket(samples, index, maxStretch);
		return { sample, timing: timing(sample), bracket: bracketed };
	});

	// The window's first frame in the reference, before the row's one fitted constant is added.
	const { pcm } = reference;
	const n = RMS_FRAMES;
	const base = (t: Timing) => t.frame - n + t.offset - reference.start;
	const energy = new Float64Array(pcm.length + 1);
	for (let i = 0; i < pcm.length; i++) energy[i + 1] = (energy[i] ?? 0) + (pcm[i] ?? 0) ** 2;
	const level = (start: number): number | undefined =>
		start < 0 || start + n > pcm.length
			? undefined
			: Math.sqrt(Math.max(0, (energy[start + n] ?? 0) - (energy[start] ?? 0)) / n);

	// The fit takes exact windows only: audible, with no stretch anywhere in their bracket.
	const exact = placed.flatMap(({ sample, timing, bracket }, index) =>
		timing && "clean" in bracket && bracket.clean && (sample.rms ?? 0) >= SILENCE_RMS
			? [{ index, rms: sample.rms ?? 0, log: Math.log(Math.max(sample.rms ?? 0, FLOOR)), start: base(timing) }]
			: [],
	);
	if (exact.length < MIN_AUDIBLE) {
		return refuse(`alignment: ${exact.length} audible windows to fit on, fewer than ${MIN_AUDIBLE}`);
	}
	type Exact = (typeof exact)[number];
	const trails = placed.flatMap(({ timing }) => (timing ? [timing.trail] : []));
	// Where the playhead's own media time puts the windows: each report, less the typical report age.
	const nominal = -(median(trails) ?? 0);

	// Log RMS correlation and level of `windows`, each placed at `shift` less its lag in frames.
	const measure = (windows: { window: Exact; lag: number }[], shift: number) => {
		const refs: number[] = [];
		const ratios: number[] = [];
		for (const { window, lag } of windows) {
			const r = level(window.start + shift - lag);
			if (r === undefined) return undefined;
			refs.push(Math.log(Math.max(r, FLOOR)));
			ratios.push(window.rms / Math.max(r, FLOOR));
		}
		return {
			r: correlation(
				refs,
				windows.map((w) => w.window.log),
			),
			gain: median(ratios) ?? 0,
		};
	};
	// The shift that places most windows exactly, whatever the rest do: the least median absolute
	// deviation of the log ratio, which a segment lagging behind the rest cannot pull off its mark the
	// way it pulls a correlation, and which no level difference moves.
	const deviation = (windows: { window: Exact; lag: number }[], shift: number) => {
		const ratios: number[] = [];
		for (const { window, lag } of windows) {
			const r = level(window.start + shift - lag);
			if (r === undefined) return undefined;
			ratios.push(window.log - Math.log(Math.max(r, FLOOR)));
		}
		const center = median(ratios) ?? 0;
		return median(ratios.map((d) => Math.abs(d - center)));
	};
	const seek = (windows: { window: Exact; lag: number }[], from: number, to: number, step: number) => {
		let found: { shift: number; spread: number } | undefined;
		for (let shift = from; shift <= to; shift += step) {
			const spread = deviation(windows, shift);
			if (spread !== undefined && (found === undefined || spread < found.spread)) found = { shift, spread };
		}
		return found?.shift;
	};
	const step = Math.max(1, Math.round(rate * STEP_S));
	const span = Math.round(rate * SEARCH_S);
	const unlagged = exact.map((window) => ({ window, lag: 0 }));
	const coarse = seek(unlagged, nominal - span, nominal + span, step);
	if (coarse === undefined) {
		return refuse(`alignment: no shift within ${SEARCH_S} s keeps every audible window inside the reference`);
	}
	let shift = seek(unlagged, coarse - step, coarse + step, 1) ?? coarse;

	// Split the row where the analyser's lag changed: each exact window votes for the whole number of
	// windows behind the clock at which it matches the reference, if it matches there and nowhere else.
	type Run = { lag: number; first: number; last: number };
	const split = (at: number): { runs: Run[]; shift: number } | string => {
		const runs: Run[] = [];
		for (const window of exact) {
			const misses = [];
			for (let k = -MAX_BEHIND; k <= MAX_BEHIND; k++) {
				const r = level(window.start + at - k * n);
				misses.push({
					k,
					miss:
						r === undefined
							? Number.POSITIVE_INFINITY
							: Math.abs(window.log - Math.log(Math.max(r, FLOOR))),
				});
			}
			misses.sort((a, b) => a.miss - b.miss);
			const [best, next] = misses;
			if (!best || !next || best.miss > MATCH || next.miss < MISS) continue;
			const run = runs.at(-1);
			if (run?.lag === best.k * n) run.last = window.index;
			else runs.push({ lag: best.k * n, first: window.index, last: window.index });
		}
		if (runs.length === 0) return { runs: [{ lag: 0, first: 0, last: placed.length - 1 }], shift: at };
		const least = Math.min(...runs.map((r) => r.lag));
		if (Math.max(...runs.map((r) => r.lag)) - least > MAX_BEHIND * n) {
			return `the analyser's lag moved by more than ${MAX_BEHIND} window`;
		}
		// Lags count from the least-behind run, whose placement the shift then describes: a window at
		// `start + at - lag` sits at `start + (at - least) - (lag - least)`.
		for (const run of runs) run.lag -= least;
		// The first and last runs reach the row's ends; between two runs, nothing says which lag held.
		const first = runs[0];
		const last = runs.at(-1);
		if (first) first.first = 0;
		if (last) last.last = placed.length - 1;
		return { runs, shift: at - least };
	};
	const members = (runs: Run[]) =>
		runs.map((run) =>
			exact
				.filter((w) => w.index >= run.first && w.index <= run.last)
				.map((window) => ({ window, lag: run.lag })),
		);
	let voted = split(shift);
	for (let pass = 0; pass < 2 && typeof voted !== "string"; pass++) {
		// Refit the row's shift with every exact window at its run's lag, then vote again from there.
		const all = members(voted.runs).flat();
		const refit = seek(all, voted.shift - 2 * step, voted.shift + 2 * step, 1) ?? voted.shift;
		voted = split(refit);
	}
	if (typeof voted === "string") return refuse(`alignment: ${voted}`);
	const runs = voted.runs;
	shift = voted.shift;

	// Each segment proves its own lag with its own exact windows, to the row's bars.
	const own = members(runs);
	const segments: Segment[] = runs.map((run, i) => {
		const windows = own[i] ?? [];
		const from = placed[run.first]?.sample.at ?? 0;
		const to = placed[run.last]?.sample.at ?? 0;
		const fit = windows.length > 0 ? measure(windows, shift) : undefined;
		const alignment = fit
			? {
					correlation: fit.r,
					gain: fit.gain,
					audible: windows.length,
					shiftMs: ((shift - run.lag - nominal) * 1000) / rate,
				}
			: null;
		const reason =
			windows.length < MIN_AUDIBLE
				? `${windows.length} audible windows prove its lag, fewer than ${MIN_AUDIBLE}`
				: !fit || fit.r < MIN_CORRELATION
					? `log RMS correlation ${fit?.r.toFixed(5)} is under ${MIN_CORRELATION}`
					: Math.abs(fit.gain - 1) > MAX_GAIN_ERROR
						? `output runs at ${fit.gain.toFixed(3)} of the source level`
						: undefined;
		return { from, to, lag: run.lag, alignment, proven: reason === undefined, ...(reason && { reason }) };
	});
	const pooled = measure(own.flat(), shift);
	const alignment: Alignment = {
		correlation: pooled?.r ?? 0,
		gain: pooled?.gain ?? 0,
		audible: own.flat().length,
		shiftMs: ((shift - nominal) * 1000) / rate,
	};

	const quietWindows = placed.flatMap(({ sample, timing, bracket }, index): QuietWindow[] => {
		const rms = sample.rms ?? 0;
		if (rms >= SILENCE_RMS) return [];
		const window: QuietWindow = { at: sample.at, rms, source: null, reference: null };
		const i = runs.findIndex((run) => index >= run.first && index <= run.last);
		const segment = segments[i];
		if (!segment) return [{ ...window, refused: "lag change" }];
		if (!segment.proven) return [{ ...window, refused: `alignment: ${segment.reason}` }];
		if ("refused" in bracket) return [{ ...window, refused: bracket.refused }];
		if (!timing) return [{ ...window, refused: "timing" }];
		const start = base(timing) + shift - segment.lag;
		const lo = start + Math.min(...bracket.offsets) - timing.offset - bracket.widen;
		const hi = start + Math.max(...bracket.offsets) - timing.offset + bracket.widen;
		const source = reference.provenance.from + start / rate;
		if (lo < 0 || hi + n > pcm.length) return [{ ...window, source, lag: segment.lag, refused: "reference" }];
		let loudest = 0;
		for (let at = lo; at <= hi; at++) loudest = Math.max(loudest, level(at) ?? Number.POSITIVE_INFINITY);
		const refused = loudest < SILENCE_RMS ? {} : { refused: "audible source" };
		return [{ ...window, source, reference: loudest, lag: segment.lag, ...refused }];
	});

	const refused = quietWindows.filter((q) => q.refused !== undefined);
	const first = refused[0];
	return {
		proven: refused.length === 0,
		...(first && {
			reason: `${refused.length} of ${quiet.length} quiet windows unproven, first at ${(first.at / 1000).toFixed(2)} s: ${first.refused}`,
		}),
		windows: counted.length,
		quiet: quiet.length,
		matched: quiet.length - refused.length,
		alignment,
		segments,
		reference: reference.provenance,
		quietWindows,
	};
}

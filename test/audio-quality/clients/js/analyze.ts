/**
 * Turns one row's beacons into the `Summary` the grader reads.
 *
 * Everything here is derived from the public samples, which constrains what can honestly be said and
 * is the reason the derivations are written out rather than assumed:
 *
 * - An **underrun episode** is a run of consecutive samples in which the playhead did not advance
 *   while the ring was not stalled. A stalled ring is silent on purpose and is counted separately;
 *   conflating the two makes a player that re-buffers cleanly look like one that glitches. The
 *   `underruns` counter is reported next to the episodes rather than instead of them, because one
 *   long gap and forty scattered ones grade the same by quanta and sound nothing alike.
 * - A **skip-ahead** is a sample in which the playhead advanced by more than the wall time since the
 *   last sample, plus a tolerance. That is audio that was buffered and then discarded.
 * - **converge_s** is the first moment after which the resolved target stayed within one bucket of
 *   its final value for the rest of the run. A target that settles and then moves again has not
 *   converged, so it is measured backwards from the end rather than forwards from the start.
 *
 *     bun analyze.ts --run <run dir> --row <tag> [--warmup 5]
 *
 * Adapted from `debug-findings/analysis/analyze.mjs` on the reporter's fork (`fperex/moq`, branch
 * `debug/rt-audio`), whose per-preset markdown table and per-minute normalisation this keeps. The
 * event stream it read came from patched-in probes; this reads the public samples instead.
 *
 * @module
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
	type Beacon,
	BUCKET_MS,
	CADENCE_QUANTA,
	convergence,
	type Drift,
	type Environment,
	episodes as episodesOf,
	identityTolerance,
	MAX_DRIFT_MS_PER_MIN,
	METRICS,
	type Point,
	RENDER_QUANTUM,
	type Row,
	round1,
	SAMPLE_INTERVAL_MS,
	type Sample,
	type ShaperCounters,
	SILENCE_RMS,
	STAGES,
	type Stage,
	type StageSpan,
	type Summary,
	stats,
	type Void,
} from "./src/schema.ts";

const { values } = parseArgs({
	options: {
		run: { type: "string" },
		row: { type: "string" },
		warmup: { type: "string", default: "5" },
	},
});

if (!values.run || !values.row) {
	console.error("usage: analyze.ts --run <run dir> --row <tag> [--warmup 5]");
	process.exit(2);
}

const run = values.run;
const tag = values.row;
const warmupSec = Number.parseFloat(values.warmup);

/** The row identity is encoded in the tag, which is also the ndjson's filename. */
function parseRow(key: string): Row {
	const [runtime, codec, rate, ...rest] = key.split("-");
	const ring = rest.pop();
	return {
		runtime: (runtime ?? "chromium") as Row["runtime"],
		codec: (codec ?? "opus") as Row["codec"],
		rate: Number.parseInt(rate ?? "48000", 10),
		profile: rest.join("-"),
		ring: (ring ?? "plain") as Row["ring"],
	};
}

const row = parseRow(tag);

// ── load ────────────────────────────────────────────────────────────────────

const samples: Sample[] = [];
let environment: Environment | null = null;
const notes: string[] = [];
let unreadable = 0;

const ndjson = join(run, `${tag}.ndjson`);
if (existsSync(ndjson)) {
	for (const line of readFileSync(ndjson, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const batch = JSON.parse(line) as Beacon;
			if (batch.environment) environment = batch.environment;
			for (const sample of batch.samples ?? []) samples.push(sample);
			for (const n of batch.notes ?? []) notes.push(n);
		} catch {
			unreadable++;
		}
	}
}
samples.sort((a, b) => a.at - b.at);
if (unreadable > 0) notes.push(`sink: ${unreadable} unreadable batches`);

const voids: Void[] = [];
const voidsFile = join(run, `${tag}.voids.json`);
if (existsSync(voidsFile)) {
	try {
		voids.push(...(JSON.parse(readFileSync(voidsFile, "utf8")) as Void[]));
	} catch {
		// A missing or broken voids file is itself a void: the driver did not finish writing it.
		voids.push({ assertion: "driver", detail: "voids file unreadable" });
	}
}

// ── the shaper's own verdict ────────────────────────────────────────────────

type ShaperReport = { profile: string; seed: number; up: ShaperCounters; down: ShaperCounters };
let shaper: ShaperReport | null = null;
const shaperFile = join(run, `shaper-${tag}.json`);
if (existsSync(shaperFile)) {
	try {
		shaper = JSON.parse(readFileSync(shaperFile, "utf8")) as ShaperReport;
	} catch {
		notes.push("shaper: report unreadable");
	}
}

// A profile that silently treated nothing turns an impaired run into an unimpaired pass. near-zero
// is the control, and zero is the right answer for it, which is what makes it the control.
//
// `none` is not a profile that treated nothing: it says the shaper was never in the path, which is
// the Safari lane, whose session is TCP. Recording that is the point of writing the report at all.
if (shaper?.profile === "none") {
	notes.push("shaper: not in the path; this lane's session never traversed the UDP shaper");
} else if (shaper && row.profile !== "near-zero" && row.profile !== "fixed-250") {
	const delayed = shaper.up.delayed + shaper.down.delayed;
	if (delayed === 0) {
		voids.push({
			assertion: "shaper",
			detail: `profile ${row.profile} delayed nothing; the impairment did not apply`,
		});
	}
} else if (!shaper) {
	notes.push("shaper: no report");
}

// ── window ──────────────────────────────────────────────────────────────────

// Grading starts once audio is actually playing, and then after the warmup: every profile spends its
// first seconds converging on purpose, and grading that would grade the tune-in, not the steady
// state. The tune-in is graded by `converge_s` instead, which is the metric for it.
const firstAudio = samples.find((s) => typeof s.timestamp === "number" && !s.stalled);
const t0 = (firstAudio?.at ?? 0) + warmupSec * 1000;
const t1 = samples.at(-1)?.at ?? t0;
const window = samples.filter((s) => s.at >= t0 && s.at <= t1);
const minutes = Math.max(1e-9, (t1 - t0) / 60000);

if (window.length === 0) {
	voids.push({ assertion: "window", detail: `no samples after warmup (${samples.length} total)` });
}

// ── playhead ────────────────────────────────────────────────────────────────
//
// The playhead a page can read is quantized: it moves when the ring reports a new position, not
// continuously, and on the postMessage ring those reports arrive on their own cadence. Measured on a
// clean local path, consecutive 250 ms samples show the playhead advancing anywhere from 240 to 296
// ms with no net drift. Every derivation below has to survive that, because a rule that treats a
// single sample's excess as a skip reports forty of them a minute on a run with none.

/** A sample's playhead advanced by less than this counts as not having advanced at all. */
const PLATEAU_MS = 1;
/**
 * A net playhead advance beyond wall time larger than this is a skip.
 *
 * Larger than the observed quantization band, and larger than one estimator bucket plus a render
 * quantum, which is the least a re-anchor can discard and still have discarded anything.
 */
const SKIP_MS = 40;
/** Samples either side of a candidate that are reduced to a median before it is judged. */
const SKIP_WINDOW = 4;

const median = (values: number[]): number | undefined => {
	if (values.length === 0) return undefined;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)];
};

let stalledSamples = 0;
for (const s of window) if (s.stalled) stalledSamples++;

/** Least-squares slope of `ys` over `xs`, in units per second. Null when there is nothing to fit. */
function slope(xs: number[], ys: number[]): number | null {
	const n = xs.length;
	if (n < 2) return null;
	const mx = xs.reduce((a, b) => a + b, 0) / n;
	const my = ys.reduce((a, b) => a + b, 0) / n;
	let num = 0;
	let den = 0;
	for (let i = 0; i < n; i++) {
		num += ((xs[i] ?? 0) - mx) * ((ys[i] ?? 0) - my);
		den += ((xs[i] ?? 0) - mx) ** 2;
	}
	return den === 0 ? null : (num / den) * 1000;
}

// The lag between wall time and the playhead drifts when the media timeline does not advance at wall
// rate, which is a property of the source or the publisher rather than of the player: a steady drift
// is not the receiver discarding anything. Left in, it reads as a skip every few seconds, so it is
// fitted and removed first, and reported on its own as `media_drift_ms_per_s`.
const rawLags = window.flatMap((s) =>
	typeof s.timestamp === "number" && !s.stalled ? [{ at: s.at, lag: s.at - s.timestamp }] : [],
);
const mediaDrift = slope(
	rawLags.map((l) => l.at),
	rawLags.map((l) => l.lag),
);

// A skip-ahead is a step in that de-trended lag, not a single large advance. Quantization makes the
// lag oscillate inside a band; discarding buffered audio moves the band. So each candidate is judged
// on the median lag either side of it, which neither the oscillation nor the drift can fake.
const detrend = (at: number, lag: number) => lag - ((mediaDrift ?? 0) / 1000) * (at - (rawLags[0]?.at ?? 0));
const lags = window.map((s) =>
	typeof s.timestamp === "number"
		? { at: s.at, lag: detrend(s.at, s.at - s.timestamp), stalled: s.stalled }
		: undefined,
);
let skipAheads = 0;
let skippedMs = 0;
for (let i = SKIP_WINDOW; i < lags.length - SKIP_WINDOW; i++) {
	const here = lags[i];
	if (!here || here.stalled) continue;
	const before = median(lags.slice(i - SKIP_WINDOW, i).flatMap((l) => (l && !l.stalled ? [l.lag] : [])));
	const after = median(lags.slice(i + 1, i + 1 + SKIP_WINDOW).flatMap((l) => (l && !l.stalled ? [l.lag] : [])));
	if (before === undefined || after === undefined) continue;
	const jumped = before - after;
	if (jumped > SKIP_MS) {
		skipAheads++;
		skippedMs += jumped;
		// One step is one skip, and the trailing window still straddles it for several samples.
		i += SKIP_WINDOW;
	}
}

// The ring's own underrun counter is cumulative, and it is the authoritative count: it sees every
// partly-filled quantum, including the ones that begin and end between two 250 ms samples.
//
// A build that does not publish it at all reports null, not zero. The difference matters most in
// exactly the comparison this harness exists for: a baseline without the counter would otherwise
// show a perfect zero next to the branch's real number and read as a regression.
/**
 * How far a cumulative counter rose across the window, or null when the build never published it.
 *
 * Positive deltas only: a rebuilt ring or a re-subscribed consumer restarts its counter at zero, and
 * a restart is not a negative number of events.
 */
function rise(counts: (number | undefined)[]): number | null {
	if (!counts.some((c) => typeof c === "number")) return null;
	let total = 0;
	for (let i = 1; i < counts.length; i++) {
		const prev = counts[i - 1];
		const cur = counts[i];
		if (typeof prev !== "number" || typeof cur !== "number") continue;
		total += Math.max(0, cur - prev);
	}
	return total;
}

const underrunCounts = window.map((s) => s.underruns);
const hasCounter = underrunCounts.some((c) => typeof c === "number");
const underruns = rise(underrunCounts);

// Groups that lost content above the decoder, from the container consumer's own counter. It cannot
// say why: the local age budget skipping a group and the transport giving up on one land in the same
// number, which is why `budget_aborts` stays null rather than being read off this.
const skippedGroups = rise(window.map((s) => s.skipped));

// An episode is a maximal run of consecutive samples in which that counter was still rising: one
// audible gap, however many quanta it spanned. Forty scattered episodes and one long one grade the
// same by quanta and sound nothing alike, which is why both are reported.
//
// Where the counter is absent the fallback is a playhead plateau, which can only see a gap that
// lasted a whole sample interval and is therefore a lower bound. The build under test has the
// counter; the fallback is what lets an older one still produce a number rather than a zero.
if (!hasCounter) notes.push("underruns: this build publishes no counter; episodes are the coarser playhead plateaus");
const points: Point[] = window.map((cur, i) => {
	const prev = window[i - 1];
	const rising = hasCounter
		? typeof prev?.underruns === "number" && typeof cur.underruns === "number" && cur.underruns > prev.underruns
		: typeof prev?.timestamp === "number" &&
			typeof cur.timestamp === "number" &&
			cur.timestamp - prev.timestamp < PLATEAU_MS;
	// A stalled ring is deliberately not playing and is graded separately; an episode open when the
	// stall began is closed at it rather than being credited with the refill.
	return { at: cur.at, rising, excluded: cur.stalled === true };
});
const episodes = episodesOf(points, t1);

const underrunMs = episodes.reduce((a, b) => a + b, 0);
const stalledShare = window.length > 0 ? stalledSamples / window.length : null;

// ── target ──────────────────────────────────────────────────────────────────

const targetSeries = samples
	.filter((s) => typeof s.delay === "number")
	.map((s) => ({ at: s.at, ms: s.delay as number }));
const targets = window.map((s) => s.delay).filter((x): x is number => typeof x === "number");

const convergeS = convergence(targetSeries, firstAudio?.at ?? 0, BUCKET_MS, t1);

// ── silence and load ────────────────────────────────────────────────────────

const rmsWindows = window.map((s) => s.rms).filter((x): x is number => typeof x === "number");
const silenceShare =
	rmsWindows.length > 0 ? rmsWindows.filter((r) => r < SILENCE_RMS).length / rmsWindows.length : null;
const loads = window.map((s) => s.renderLoad).filter((x): x is number => typeof x === "number");

// What a hundred render quanta actually cost in wall time.
//
// Chromium publishes `renderCapacity`, and nothing else does, so on Safari `render_load` is null and
// this is what stands in for it. `AudioContext.currentTime` advances exactly one quantum per render
// callback, so the quanta between two samples are the context's own advance, and the wall time they
// took is this clock's. A render thread that kept up spends the nominal 128/rate per quantum; one
// that hitched spends more, and the max is the hitch.
//
// It needs the device's rate, not the stream's: a 44.1 kHz stream still renders at whatever the
// output device runs at. Without it there is no quantum to count, so the metric is null rather than
// computed against a guess.
const contextRate = environment?.contextRate;
const cadences: number[] = [];
if (typeof contextRate === "number" && contextRate > 0) {
	const nominal = (CADENCE_QUANTA * RENDER_QUANTUM * 1000) / contextRate;
	for (let i = 1; i < window.length; i++) {
		const prev = window[i - 1]?.contextTime;
		const cur = window[i]?.contextTime;
		const wall = (window[i]?.at ?? 0) - (window[i - 1]?.at ?? 0);
		if (typeof prev !== "number" || typeof cur !== "number") continue;
		const advanced = cur - prev;
		// A sample pair across a context that did not advance at all says the graph was not running,
		// which the clock void already covers; dividing by it here would report an infinity.
		if (advanced <= 0 || wall <= 0) continue;
		cadences.push(nominal * (wall / advanced));
	}
} else if (window.length > 0) {
	notes.push("worklet_cadence: no AudioContext.sampleRate was reported, so the quantum has no duration");
}
const cadenceStats = stats(cadences);

// ── the clock ───────────────────────────────────────────────────────────────

// Which track's playhead playback was paced against. Audio holding it is what the rest of these
// numbers assume: while nothing does, the reference follows the wall clock and the ring is chasing
// it, which is the arrangement the underruns came from in the first place. A sample whose `clock`
// field is absent came from a build without the signal and is left out of the denominator entirely,
// so an old build reports null instead of a flattering zero.
const clocks = window.flatMap((s) => (s.clock === undefined ? [] : [s.clock]));
const wallClockShare = clocks.length > 0 ? clocks.filter((c) => c === "none").length / clocks.length : null;
if (clocks.length === 0) {
	notes.push("clock: this build does not publish sync.out.clock");
} else {
	const sources = [...new Set(clocks)].sort().join(", ");
	if (sources !== "audio") notes.push(`clock: playback was paced by ${sources}`);
}

// ── clocks and stages ───────────────────────────────────────────────────────

// Only one clock is readable from a browser page: its own. The publisher, relay, and shaper run in
// other processes on this host, and nothing in this lane carries a timestamp from them, so their
// drift is unmeasured rather than zero. Saying so is the point; a zero here would be a claim.
const drift: Drift[] = (["relay", "shaper"] as const).map((clock) => ({
	clock,
	msPerMin: null,
	offsetMs: null,
}));

// The publisher's is the exception: the media timeline is the publisher's clock seen through the
// stream, so the drift fitted above is a reading of it. The offset is not, since the two have no
// common epoch, and a run is not voided on this one: the schema's 2ms/min rule is about host clocks
// carrying the stage arithmetic, and a source whose timeline runs fast is content, not a clock.
drift.push({ clock: "publisher", msPerMin: round1(mediaDrift === null ? null : mediaDrift * 60), offsetMs: null });

const contextTimes = window
	.filter((s) => typeof s.contextTime === "number")
	.map((s) => ({ at: s.at, t: s.contextTime as number }));
if (contextTimes.length > 1) {
	const first = contextTimes[0];
	const last = contextTimes.at(-1);
	if (first && last && last.at > first.at) {
		const wall = last.at - first.at;
		const media = last.t - first.t;
		const msPerMin = ((media - wall) / wall) * 60000;
		drift.push({ clock: "viewer", msPerMin: round1(msPerMin), offsetMs: 0 });
		if (Math.abs(msPerMin) > MAX_DRIFT_MS_PER_MIN * 60) {
			// A device clock that is not tracking wall time at all is a different failure from two
			// hosts drifting apart, and the threshold for it is much looser.
			voids.push({ assertion: "clock", detail: `device clock drifted ${round1(msPerMin)}ms/min from wall time` });
		}
	}
}

/**
 * The stage breakdown, as far as this lane can honestly fill it in.
 *
 * The schema's identity is capture to speaker, and this lane cannot check it: `capture`, `encode`,
 * and `network` need a timestamp from the publisher or the relay, and a browser page has no clock in
 * common with either. What it can check is the receiver's own sub-identity, from the live edge to
 * the speaker, which is where every metric graded here comes from anyway.
 *
 * So `publish_flush` is reported because the publisher declares it in the catalog, but it is not in
 * the sum: adding a publisher-side span to a receiver-side total is exactly the unaligned-clock
 * arithmetic the schema exists to prevent. `jitter_buffer` is the resolved target, `device` is the
 * output and base latency the AudioContext reports, and `unaccounted` is the rest of the receiver
 * span: decode and render, which are real and unmeasured here rather than absent.
 */
const RECEIVER_STAGES = ["network", "jitter_buffer", "decode", "render", "device"] as const;

const lastSample = window.at(-1);
const span = (ms: number | null | undefined, source: StageSpan["source"]): StageSpan => ({
	ms: ms === undefined || ms === null ? null : round1(ms),
	source: ms === undefined || ms === null ? "unmeasured" : source,
});

const deviceMs =
	typeof lastSample?.outputLatency === "number"
		? lastSample.outputLatency + (lastSample.baseLatency ?? 0)
		: undefined;

const measured: Partial<Record<Stage, StageSpan>> = {
	publish_flush: span(environment?.catalogJitter, "declared"),
	jitter_buffer: span(lastSample?.delay, "measured"),
	device: span(deviceMs, "measured"),
};
const stages = Object.fromEntries(
	STAGES.map((stage) => [stage, measured[stage] ?? span(null, "unmeasured")]),
) as Record<Stage, StageSpan>;

// The live edge to the speaker: what the receiver is holding, plus what the device adds after it.
const endToEndMs = typeof lastSample?.delay === "number" && deviceMs !== undefined ? lastSample.delay + deviceMs : null;
if (endToEndMs !== null) {
	const summed = RECEIVER_STAGES.reduce((a, s) => a + (stages[s].ms ?? 0), 0);
	stages.unaccounted = { ms: round1(endToEndMs - summed), source: "measured" };
}
// By construction the remainder closes the sum, so this checks the arithmetic rather than the
// pipeline. It becomes a real assertion once `network`, `decode`, and `render` are measured.
const identityHolds =
	endToEndMs === null
		? null
		: Math.abs(
				RECEIVER_STAGES.reduce((a, s) => a + (stages[s].ms ?? 0), 0) +
					(stages.unaccounted.ms ?? 0) -
					endToEndMs,
			) <= identityTolerance(endToEndMs);

// ── the graded numbers ──────────────────────────────────────────────────────

const episodeStats = stats(episodes);
const targetStats = stats(targets);
const loadStats = stats(loads);
const rate = environment?.catalogRate ?? row.rate;

/** Every key a budget may name. A metric this lane cannot measure is null, never zero. */
const metrics: Record<string, number | null> = {
	underruns_total: underruns,
	underruns_per_min: underruns === null ? null : round1(underruns / minutes),
	underrun_episodes_total: episodes.length,
	underrun_episodes_per_min: round1(episodes.length / minutes),
	underrun_episodes_p50: round1(episodeStats.p50),
	underrun_episodes_p95: round1(episodeStats.p95),
	underrun_episodes_max: round1(episodeStats.max),
	underrun_samples_total: round1(underrunMs),
	underrun_samples_per_min: round1(underrunMs / minutes),
	short_quanta_total: null,
	short_quanta_per_min: null,
	silent_quanta_total: null,
	silent_quanta_per_min: null,
	stalled_quanta_share: stalledShare === null ? null : Math.round(stalledShare * 1000) / 1000,
	discarded_samples_total: null,
	discarded_samples_per_min: null,
	skip_aheads_total: skipAheads,
	skip_aheads_per_min: round1(skipAheads / minutes),
	skipped_samples_total: round1(skippedMs),
	skipped_samples_per_min: round1(skippedMs / minutes),
	accelerates_total: null,
	accelerates_per_min: null,
	expands_total: null,
	expands_per_min: null,
	stretched_samples_total: null,
	stretched_samples_per_min: null,
	skipped_groups_total: skippedGroups,
	skipped_groups_per_min: skippedGroups === null ? null : round1(skippedGroups / minutes),
	budget_aborts_total: null,
	budget_aborts_per_min: null,
	target_ms_p50: round1(targetStats.p50),
	target_ms_p95: round1(targetStats.p95),
	target_ms_max: round1(targetStats.max),
	target_ms_last: round1(lastSample?.delay),
	converge_s_seconds: round1(convergeS),
	silence_share_share: silenceShare === null ? null : Math.round(silenceShare * 1000) / 1000,
	wall_clock_share_share: wallClockShare === null ? null : Math.round(wallClockShare * 1000) / 1000,
	render_load_p95: round1(loadStats.p95),
	render_load_max: round1(loadStats.max),
	worklet_cadence_p95: round1(cadenceStats.p95),
	worklet_cadence_max: round1(cadenceStats.max),
	media_drift_last: round1(mediaDrift),
};

const summary: Summary = {
	version: 1,
	row,
	seed: shaper?.seed ?? 0,
	windowSec: round1((t1 - t0) / 1000) ?? 0,
	warmupSec,
	rate,
	environment,
	voids,
	metrics,
	targetSeries,
	episodes: episodes.map((e) => round1(e) ?? 0),
	stages,
	endToEndMs: round1(endToEndMs),
	identityHolds,
	drift,
	shaper,
	notes: notes.slice(0, 50),
};

await Bun.write(join(run, `${tag}.summary.json`), JSON.stringify(summary, null, 1));

// ── the table ───────────────────────────────────────────────────────────────

const lines: string[] = [
	`## ${tag}`,
	"",
	`window ${summary.windowSec}s after a ${warmupSec}s warmup, ${window.length} samples at ${SAMPLE_INTERVAL_MS}ms, rate ${rate}Hz`,
	"",
];
if (voids.length > 0) {
	lines.push("**void**: " + voids.map((v) => `${v.assertion} (${v.detail})`).join("; "), "");
}
lines.push("| metric | unit | aggregation | value |", "|---|---|---|---|");
for (const [name, spec] of Object.entries(METRICS)) {
	for (const aggregation of spec.aggregations) {
		const key = `${name}_${aggregation}`;
		const value = metrics[key];
		const shown =
			value === null || value === undefined ? (spec.pending ? `n/a (${spec.pending})` : "n/a") : String(value);
		lines.push(`| ${name} | ${spec.unit} | ${aggregation} | ${shown} |`);
	}
}
lines.push(
	"",
	"| stage | ms | source |",
	"|---|---|---|",
	...STAGES.map((s) => `| ${s} | ${stages[s].ms ?? "n/a"} | ${stages[s].source} |`),
	"",
	`end-to-end ${summary.endToEndMs ?? "n/a"}ms, identity ${identityHolds === null ? "n/a" : identityHolds ? "holds" : "does not hold"}`,
);
if (shaper) {
	lines.push(
		"",
		`shaper ${shaper.profile} seed ${shaper.seed}: up delivered ${shaper.up.delivered} delayed ${shaper.up.delayed} dropped ${shaper.up.dropped}, down delivered ${shaper.down.delivered} delayed ${shaper.down.delayed} dropped ${shaper.down.dropped}`,
	);
}
if (notes.length > 0) lines.push("", "notes:", ...notes.slice(0, 20).map((n) => `- ${n}`));

await Bun.write(join(run, `${tag}.summary.md`), `${lines.join("\n")}\n`);
console.log(lines.join("\n"));

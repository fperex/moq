/**
 * Grades the recorded arrival traces, with no relay, no shaper, and no browser.
 *
 * The other two lanes measure a player against a live path, which is the only way to learn what a
 * listener hears and also the reason they take half an hour and drift by a few percent between runs.
 * This one measures the same player against a recording: the same `Container.Jitter`, the same two
 * rings, the same `Stretcher`, driven on a simulated clock by
 * [`js/watch/src/audio/replay.ts`](../../../../js/watch/src/audio/replay.ts), which is also what
 * `replay.test.ts` drives. It is deterministic, it runs in a second, and its budgets can be hard
 * zeros because nothing in it can be unlucky.
 *
 * What it cannot say is anything about the transport, the decoder, the device, or the wall clock:
 * there is no session and no audio hardware, so those metrics are null rather than zero. The traces
 * are arrival timing only, trimmed from the recordings attached to moq-dev/moq#3477.
 *
 *     bun replay.ts --out <run dir> [--rings isolated,plain] [--fixtures lan-bbb,...]
 *
 * @module
 */
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import fourKWebm from "../../../../js/watch/src/audio/fixtures/4k-webm.json" with { type: "json" };
import lanBbb from "../../../../js/watch/src/audio/fixtures/lan-bbb.json" with { type: "json" };
import relayBbb7Frame from "../../../../js/watch/src/audio/fixtures/relay-bbb-7frame.json" with { type: "json" };
import { type Fixture, post, recorded, replay, shared } from "../../../../js/watch/src/audio/replay.ts";
import {
	BUCKET_MS,
	convergence,
	episodes as episodesOf,
	type Point,
	type Ring,
	type Row,
	round1,
	rowKey,
	SAMPLE_INTERVAL_MS,
	STAGES,
	type Stage,
	type StageSpan,
	type Summary,
	stats,
} from "./src/schema.ts";

/**
 * A trace, and the stream it was recorded off.
 *
 * The codec and rate are the recording's, not a choice: a trace carries no bitstream, but the frame
 * spacing in it is the codec's frame duration, and running the ring at a rate the recording never
 * had would grade a stream that never existed. `lan-bbb` and `relay-bbb-7frame` are 23.22 ms apart,
 * which is 1024 samples at 44.1 kHz; `4k-webm` is 20 ms, which is Opus.
 */
type Recording = {
	/** The trace, which is the row's `profile`: what the path did, recorded rather than shaped. */
	name: string;
	fixture: Fixture;
	codec: Row["codec"];
	rate: number;
};

const RECORDINGS: Recording[] = [
	{ name: "lan-bbb", fixture: lanBbb as Fixture, codec: "aac", rate: 44100 },
	{ name: "relay-bbb-7frame", fixture: relayBbb7Frame as Fixture, codec: "aac", rate: 44100 },
	{ name: "4k-webm", fixture: fourKWebm as Fixture, codec: "opus", rate: 48000 },
];

/**
 * Wall time discarded before grading, in ms.
 *
 * The target starts at the cold-start guess and falls one bucket a second, and every fall costs the
 * ring the bucket it lands on. That is convergence, which `converge_s` grades on its own; grading it
 * again as an underrun would grade the tune-in twice. The same figure `replay.test.ts` uses on these
 * recordings.
 */
const WARMUP_MS = 4000;

const { values } = parseArgs({
	options: {
		out: { type: "string" },
		rings: { type: "string", default: "isolated,plain" },
		fixtures: { type: "string", default: RECORDINGS.map((r) => r.name).join(",") },
		list: { type: "boolean", default: false },
	},
});

if (!values.out && !values.list) {
	console.error("usage: replay.ts --out <run dir> [--rings isolated,plain] [--fixtures lan-bbb,...] [--list]");
	process.exit(2);
}

const wanted = values.rings.split(",").map((r) => r.trim());
for (const ring of wanted) {
	if (ring !== "isolated" && ring !== "plain") {
		console.error(`error: unknown ring '${ring}' (known: isolated, plain)`);
		process.exit(2);
	}
}
const names = values.fixtures.split(",").map((f) => f.trim());
for (const name of names) {
	if (!RECORDINGS.some((r) => r.name === name)) {
		console.error(`error: unknown fixture '${name}' (known: ${RECORDINGS.map((r) => r.name).join(", ")})`);
		process.exit(2);
	}
}

/** Samples in `ms` at `rate`, which is how every sample count reaches a summary. */
const asMs = (samples: number, rate: number): number => (samples / rate) * 1000;

/** Every row this invocation covers, in the order it runs them. */
const matrix = names.flatMap((name) => {
	const recording = RECORDINGS.find((r) => r.name === name) as Recording;
	return (wanted as Ring[]).map((ring) => ({
		recording,
		row: { runtime: "replay", codec: recording.codec, rate: recording.rate, profile: recording.name, ring } as Row,
	}));
});

if (values.list) {
	for (const { row } of matrix) console.log(rowKey(row));
	console.error(`\n${matrix.length} rows, one per recording per ring`);
	process.exit(0);
}

const out = resolve(values.out as string);
mkdirSync(out, { recursive: true });

for (const { recording, row } of matrix) {
	const tag = rowKey(row);

	const arrivals = recorded(recording.fixture);
	// The catalog floor `Sync` holds the target above is the codec's frame duration, which is
	// the trace's own nominal spacing. Reduced rather than spread, because a recording is tens of
	// thousands of frames and `Math.min(...)` of that many arguments blows the stack.
	const media = arrivals.map((a) => a.media).sort((a, b) => a - b);
	let smallest = Number.POSITIVE_INFINITY;
	for (let i = 1; i < media.length; i++) {
		const gap = media[i] - media[i - 1];
		if (gap > 0 && gap < smallest) smallest = gap;
	}
	if (!Number.isFinite(smallest)) {
		console.error(`error: ${tag} has no two distinct media timestamps, so it has no frame duration`);
		process.exit(2);
	}
	const floorMs = Math.ceil(smallest);

	const build = row.ring === "isolated" ? shared(recording.rate) : post(recording.rate);
	const result = replay(build, arrivals, {
		rate: recording.rate,
		floorMs,
		warmupMs: WARMUP_MS,
		sampleMs: SAMPLE_INTERVAL_MS,
	});

	// Everything below the warmup mark is the tune-in, and `converge_s` is what grades it.
	const graded = result.samples.filter((s) => s.at >= WARMUP_MS);
	const first = graded[0];
	const last = graded.at(-1);
	const windowMs = last && first ? last.at - first.at : 0;
	const minutes = Math.max(1e-9, windowMs / 60000);

	// The ring's own underrun counter, sampled: exact, unlike the browser's, because there is no
	// page between the counter and this file.
	const points: Point[] = graded.map((cur, i) => ({
		at: cur.at,
		rising: i > 0 && cur.debug.underruns > (graded[i - 1]?.debug.underruns ?? 0),
		excluded: cur.debug.stalled,
	}));
	const episodes = episodesOf(points, last?.at ?? WARMUP_MS);
	const episodeStats = stats(episodes);

	const targetSeries = result.samples.map((s) => ({ at: s.at, ms: s.target }));
	const targetStats = stats(graded.map((s) => s.target));
	const stalled = graded.length > 0 ? graded.filter((s) => s.debug.stalled).length / graded.length : null;

	const rise = (read: (at: (typeof graded)[number]) => number): number =>
		last && first ? read(last) - read(first) : 0;
	const underruns = rise((s) => s.debug.underruns);
	const skips = rise((s) => s.debug.skips);
	const skippedSamples = rise((s) => s.debug.skipped);
	const discarded = rise((s) => s.debug.discarded);
	const accelerates = rise((s) => s.debug.accelerates);
	const expands = rise((s) => s.debug.expands);
	// The ring publishes the signed net (what an accelerate removed less what an expansion
	// inserted), so a row where both ran reports the net rather than the sum: a lower bound on how
	// much media had its duration altered, not the total.
	const stretched = Math.abs(rise((s) => s.debug.stretched));
	const short = rise((s) => s.debug.short);

	// The one span this lane holds: what the receiver is buffering. There is no device and no
	// session, so the rest are unmeasured rather than zero, and there is no end-to-end to check
	// the sum against.
	const measured: Partial<Record<Stage, StageSpan>> = {
		jitter_buffer: { ms: round1(last?.target) ?? null, source: "measured" },
	};
	const stages = Object.fromEntries(
		STAGES.map((stage) => [stage, measured[stage] ?? { ms: null, source: "unmeasured" }]),
	) as Record<Stage, StageSpan>;

	const summary: Summary = {
		version: 1,
		row,
		seed: 0,
		windowSec: round1(windowMs / 1000) ?? 0,
		warmupSec: WARMUP_MS / 1000,
		rate: recording.rate,
		environment: null,
		voids: [],
		metrics: {
			underruns_total: underruns,
			underruns_per_min: round1(underruns / minutes),
			underrun_episodes_total: episodes.length,
			underrun_episodes_per_min: round1(episodes.length / minutes),
			underrun_episodes_p50: round1(episodeStats.p50),
			underrun_episodes_p95: round1(episodeStats.p95),
			underrun_episodes_max: round1(episodeStats.max),
			// Every sample count here is exact, so it is converted at the recording's own rate
			// rather than estimated from a sampling grid.
			underrun_samples_total: null,
			underrun_samples_per_min: null,
			short_quanta_total: short,
			short_quanta_per_min: round1(short / minutes),
			silent_quanta_total: null,
			silent_quanta_per_min: null,
			stalled_quanta_share: stalled === null ? null : Math.round(stalled * 1000) / 1000,
			discarded_samples_total: round1(asMs(discarded, recording.rate)),
			discarded_samples_per_min: round1(asMs(discarded, recording.rate) / minutes),
			skip_aheads_total: skips,
			skip_aheads_per_min: round1(skips / minutes),
			skipped_samples_total: round1(asMs(skippedSamples, recording.rate)),
			skipped_samples_per_min: round1(asMs(skippedSamples, recording.rate) / minutes),
			accelerates_total: accelerates,
			accelerates_per_min: round1(accelerates / minutes),
			expands_total: expands,
			expands_per_min: round1(expands / minutes),
			stretched_samples_total: round1(asMs(stretched, recording.rate)),
			stretched_samples_per_min: round1(asMs(stretched, recording.rate) / minutes),
			// No container consumer, no subscription, no device, no session: the metrics that
			// read them report null rather than a flattering zero.
			skipped_groups_total: null,
			skipped_groups_per_min: null,
			budget_aborts_total: null,
			budget_aborts_per_min: null,
			target_ms_p50: round1(targetStats.p50),
			target_ms_p95: round1(targetStats.p95),
			target_ms_max: round1(targetStats.max),
			target_ms_last: round1(last?.target),
			converge_s_seconds: round1(convergence(targetSeries, 0, BUCKET_MS, result.elapsedMs)),
			silence_share_share: null,
			wall_clock_share_share: null,
			render_load_p95: null,
			render_load_max: null,
			worklet_cadence_p95: null,
			worklet_cadence_max: null,
			media_drift_last: null,
		},
		targetSeries,
		episodes: episodes.map((e) => round1(e) ?? 0),
		stages,
		endToEndMs: null,
		identityHolds: null,
		drift: [],
		shaper: null,
		notes: [
			`replayed ${recording.fixture.source}`,
			"no transport, device, or wall clock: the metrics that need one report null",
		],
	};

	await Bun.write(join(out, `${tag}.summary.json`), JSON.stringify(summary, null, 1));
	console.log(
		`${tag}: target ${last?.target ?? 0}ms, ${underruns} underruns in ${episodes.length} episodes, ` +
			`${skips} skips over ${round1(windowMs / 1000)}s, ${accelerates} accelerates and ${expands} expands`,
	);
}

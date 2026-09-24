/**
 * The metric contract: what the page measures, what the analyzer reduces it to, and what the grader
 * compares against a budget.
 *
 * This file is the schema, not a description of one. The page emits {@link Sample}s, the analyzer
 * turns them into a {@link Summary}, the grader reads {@link Summary} against `budgets.json`, and
 * {@link METRICS} says for every graded number what its unit is, which clock it sits on, and how a
 * series became one value. A native lane emitting the same {@link Summary} is comparable to this one
 * by construction rather than by agreement, which is the point of writing it down here.
 *
 * Conventions, once, for everything below:
 *
 * - Every duration is milliseconds as a float. Nothing is in seconds, samples, or microseconds by
 *   the time it reaches a {@link Summary}; a sample count is converted at the rate it was counted
 *   at and reported as ms alongside the count.
 * - Every count is a non-negative integer.
 * - Every share is a fraction of 1, not a percentage.
 * - Every timestamp sits on a named {@link Clock}, and the analyzer reduces all of them to the
 *   `viewer` reference before subtracting any two. See {@link Drift}.
 *
 * @module
 */

/** Milliseconds, as a float. The unit of every duration in this schema. */
export type Ms = number;

/** A fraction of 1. The unit of every share in this schema. */
export type Share = number;

/**
 * The clocks a measurement can originate on.
 *
 * They are separate processes, so their epochs differ and their rates drift. The analyzer reduces
 * every timestamp to `viewer` and records what that correction was; cross-machine calibration is
 * explicitly not shipped, so a run whose hosts are not the same machine is not comparable and the
 * drift check is what catches it.
 */
export type Clock = "viewer" | "publisher" | "relay" | "shaper";

/** How a series of measurements became the one number a budget grades. */
export type Aggregation = "total" | "per_min" | "p50" | "p95" | "max" | "share" | "last" | "seconds";

/** The unit a metric is counted in, before aggregation. */
export type Unit = "ms" | "count" | "share" | "samples";

/** What one metric is: enough to read a number off a summary without guessing. */
export type MetricSpec = {
	/** What the raw measurement counts. */
	unit: Unit;
	/** Which clock its timestamps came from. */
	clock: Clock;
	/** The aggregations reported for it, and therefore the budget keys it can be graded by. */
	aggregations: Aggregation[];
	/** One plain line saying what it measures. */
	description: string;
	/** True when this lane cannot measure it yet, so a null is expected rather than a failure. */
	pending?: string;
};

/**
 * Every graded metric, keyed by its base name.
 *
 * A budget key is `<name>_<aggregation>`, so `underrun_episodes` graded `per_min` is
 * `underrun_episodes_per_min`. Naming the aggregation in the key is what keeps "underruns: 3" and
 * "underruns: 3/min" from being graded against each other.
 */
export const METRICS: Record<string, MetricSpec> = {
	underruns: {
		unit: "count",
		clock: "viewer",
		aggregations: ["total", "per_min"],
		description: "Quanta the ring could only partly fill, counted by the playout ring itself.",
	},
	underrun_episodes: {
		unit: "count",
		clock: "viewer",
		aggregations: ["total", "per_min", "p50", "p95", "max"],
		description:
			"Runs of consecutive underrunning quanta, counted as one event each. The percentiles are the episode's duration in ms.",
	},
	underrun_samples: {
		unit: "samples",
		clock: "viewer",
		aggregations: ["total", "per_min"],
		description: "Samples the ring could not supply, reported in ms at the stream's sample rate.",
	},
	short_quanta: {
		unit: "count",
		clock: "viewer",
		aggregations: ["total", "per_min"],
		description: "Quanta delivered with fewer samples than the render quantum asked for.",
		pending: "the browser probe does not read `audio.out.debug`; the replay lane reads it directly",
	},
	silent_quanta: {
		unit: "count",
		clock: "viewer",
		aggregations: ["total", "per_min"],
		description: "Quanta filled entirely with silence because nothing was buffered.",
		pending: "no counter for it on either lane: the ring reports short quanta, not silent ones",
	},
	stalled_quanta: {
		unit: "share",
		clock: "viewer",
		aggregations: ["share"],
		description:
			"Share of the run the ring spent re-stalled, refilling rather than playing. Graded separately from underruns: it is silence the player chose.",
	},
	discarded_samples: {
		unit: "samples",
		clock: "viewer",
		aggregations: ["total", "per_min"],
		description: "Buffered samples thrown away without being played, reported in ms.",
		pending: "the browser probe does not read `audio.out.debug`; the replay lane reads it directly",
	},
	skip_aheads: {
		unit: "count",
		clock: "viewer",
		aggregations: ["total", "per_min"],
		description: "Re-anchors that jumped the playhead forward, discarding buffered audio.",
	},
	skipped_samples: {
		unit: "samples",
		clock: "viewer",
		aggregations: ["total", "per_min"],
		description: "Media time the playhead jumped over, reported in ms.",
	},
	accelerates: {
		unit: "count",
		clock: "viewer",
		aggregations: ["total", "per_min"],
		description: "Time-stretch decisions that played the buffer down faster than real time.",
		pending: "the browser probe does not read `audio.out.debug`; the replay lane reads it directly",
	},
	expands: {
		unit: "count",
		clock: "viewer",
		aggregations: ["total", "per_min"],
		description: "Concealment decisions that generated audio to cover a gap.",
		pending: "the browser probe does not read `audio.out.debug`; the replay lane reads it directly",
	},
	stretched_samples: {
		unit: "samples",
		clock: "viewer",
		aggregations: ["total", "per_min"],
		description: "Samples whose duration was altered by stretching or concealment, reported in ms.",
		pending: "the browser probe does not read `audio.out.debug`; the replay lane reads it directly",
	},
	skipped_groups: {
		unit: "count",
		clock: "viewer",
		aggregations: ["total", "per_min"],
		description:
			"Groups the container consumer abandoned with content still unread. A group the next one already covers is not one of these: nothing was lost there.",
	},
	budget_aborts: {
		unit: "count",
		clock: "viewer",
		aggregations: ["total", "per_min"],
		description: "Groups abandoned specifically because they exceeded the subscription's age budget.",
		pending:
			"skipped_groups counts the age budget and a transport give-up as one; separating them needs its own counter",
	},
	target_ms: {
		unit: "ms",
		clock: "viewer",
		aggregations: ["p50", "p95", "max", "last"],
		description: "The playout delay the receiver resolved, sampled through the run.",
	},
	converge_s: {
		unit: "ms",
		clock: "viewer",
		aggregations: ["seconds"],
		description:
			"Seconds from first audio until the resolved target stayed within one bucket of its final value for the rest of the run.",
	},
	silence_share: {
		unit: "share",
		clock: "viewer",
		aggregations: ["share"],
		description:
			"Share of sampled windows whose RMS at the audio graph's output was below the silence floor. The only metric read from the audio itself rather than from a counter.",
	},
	wall_clock_share: {
		unit: "share",
		clock: "viewer",
		aggregations: ["share"],
		description:
			"Share of the graded window in which no track's playhead drove playback, so the reference followed the wall clock and the ring was chasing it rather than setting the pace.",
	},
	render_load: {
		unit: "share",
		clock: "viewer",
		aggregations: ["p95", "max"],
		description: "AudioContext render capacity load: how much of each render quantum's budget was used.",
	},
	worklet_cadence: {
		unit: "ms",
		clock: "viewer",
		aggregations: ["p95", "max"],
		description:
			"Wall time a hundred render quanta actually took. The stand-in for render_load where there is no render capacity surface: a render thread that hitched took longer than the hundred quanta were worth.",
	},
	media_drift: {
		unit: "ms",
		clock: "publisher",
		aggregations: ["last"],
		description:
			"Rate at which the media timeline runs away from wall time, in ms per second. A property of the source or the publisher, not of the player, and removed before skip-aheads are counted.",
	},
};

/** RMS below this at the graph output counts the window as silent. About -60 dBFS. */
export const SILENCE_RMS = 0.001;

/** How often the page samples its signals. Every series in a {@link Summary} is on this grid. */
export const SAMPLE_INTERVAL_MS = 250;

/** Frames in one AudioWorklet render quantum, fixed by the Web Audio specification. */
export const RENDER_QUANTUM = 128;

/** How many quanta `worklet_cadence` is reported over, so the number is readable at a glance. */
export const CADENCE_QUANTA = 100;

/**
 * The stages an end-to-end delay is split into, in order, as exclusive spans.
 *
 * Exclusive is the requirement that makes the sum mean anything: no two stages may claim the same
 * millisecond, so they have to be defined by their boundaries rather than by what they feel like.
 * `unaccounted` is the named remainder, and a large one is a finding rather than a rounding error.
 */
export const STAGES = [
	"capture",
	"encode",
	"publish_flush",
	"network",
	"jitter_buffer",
	"decode",
	"render",
	"device",
	"unaccounted",
] as const;

/** One of {@link STAGES}. */
export type Stage = (typeof STAGES)[number];

/** A stage span, and how it was arrived at. */
export type StageSpan = {
	/** The span's duration, or null when this lane cannot measure it. */
	ms: Ms | null;
	/** "measured", "declared" (the publisher said so), or "unmeasured". */
	source: "measured" | "declared" | "unmeasured";
};

/**
 * The tolerance on the sum-to-end-to-end identity: the larger of 2 ms or 2% of the total.
 *
 * Below that, the stages and the measured end-to-end agree. Above it, `unaccounted` is carrying
 * something real.
 */
export const identityTolerance = (endToEndMs: Ms): Ms => Math.max(2, endToEndMs * 0.02);

/**
 * Clock drift beyond this voids a run, in ms per minute.
 *
 * Two processes on one host share a hardware clock, so anything past a couple of ms a minute means
 * they are not on one host and the stage arithmetic is subtracting unrelated numbers.
 */
export const MAX_DRIFT_MS_PER_MIN = 2;

/** What one clock's timestamps needed to be reduced to the viewer reference. */
export type Drift = {
	/** Which clock. */
	clock: Clock;
	/** Measured drift against the viewer clock, ms per minute. */
	msPerMin: Ms | null;
	/** Offset removed to put it on the viewer epoch. */
	offsetMs: Ms | null;
};

// ── the row identity ────────────────────────────────────────────────────────

/** Which ring the page actually ran, which is decided by whether the document is isolated. */
export type Ring = "isolated" | "plain";

/**
 * One matrix cell.
 *
 * A budget is keyed by the whole thing. Keying by profile alone would grade one codec's floor
 * against another's, and the sample rate and the ring path each move it as much as the profile does.
 */
export type Row = {
	/** The runtime that played it. */
	runtime: "chromium" | "safari" | "replay";
	/** The audio codec. */
	codec: "opus" | "aac";
	/** Sample rate in Hz. */
	rate: number;
	/** The shaper profile the path ran under. */
	profile: string;
	/** Which ring ran. */
	ring: Ring;
};

/** The row identity as a flat string, used as a directory name and a table label. */
export const rowKey = (row: Row): string => `${row.runtime}-${row.codec}-${row.rate}-${row.profile}-${row.ring}`;

// ── what the page emits ─────────────────────────────────────────────────────

/**
 * Which thread fed the ring, from `audio.out.thread`: the page's audio worker, with the transport its own
 * session ran over, or the page's main thread, with why the page took the audio back when it did.
 * `pending` while the worker is starting.
 */
export type Thread = { kind: "worker"; transport?: string } | { kind: "main"; reason?: string } | { kind: "pending" };

/** One 250 ms probe sample: everything public the page could read at that instant. */
export type Sample = {
	/** Milliseconds since the page started sampling, on the viewer clock. */
	at: Ms;

	/**
	 * `audio.out.timestamp`: the playhead, in ms of media time.
	 *
	 * Undefined whenever the ring has no playhead: before the first insert anchors it, and from a
	 * flush until the next insert re-anchors it. That is a missing position rather than a zero one,
	 * so `analyze.ts` skips those samples rather than reading them as a plateau or a step.
	 */
	timestamp?: Ms;
	/** `audio.out.stalled`: the ring is refilling rather than playing. */
	stalled?: boolean;
	/** `audio.out.underruns`: cumulative count of partly-filled quanta. */
	underruns?: number;
	/** `audio.out.spread`: the measured arrival spread feeding the target, in ms. */
	spread?: Ms;
	/** `audio.out.buffered`: how much audio is ready to play, in ms. */
	buffered?: Ms;
	/** `audio.out.skipped`: cumulative groups the container consumer abandoned. */
	skipped?: number;
	/** `audio.out.stats`, passed through as-is: whatever the build publishes. */
	stats?: Record<string, unknown>;
	/**
	 * `audio.out.thread`: which thread fed the ring. Absent on a build without the signal, which is a
	 * different answer from `pending`: that build cannot say, rather than has not started.
	 */
	thread?: Thread;

	/** `sync.out.delay`: the resolved playout target, in ms. */
	delay?: Ms;
	/** `sync.out.jitter`: the jitter estimate feeding it, in ms. */
	jitter?: Ms;
	/** `sync.out.maxAge`: the subscription's age budget, in ms. */
	maxAge?: Ms;
	/** `sync.out.reference`: the clock reference the renderer is pacing against. */
	reference?: number;
	/** `sync.out.timestamp`: the media time `sync` believes should be playing now. */
	syncTimestamp?: Ms;
	/**
	 * `sync.out.clock`: whose playhead playback is paced against.
	 *
	 * `"none"` is the wall clock, which is a different answer from the field being absent: absent
	 * means the build predates the signal, and grading those two the same would read a player that
	 * never handed the clock to audio as one that could not be asked.
	 */
	clock?: "audio" | "video" | "none";

	/** RMS at the audio graph output over this window, from an AnalyserNode. */
	rms?: number;
	/** `AudioContext.renderCapacity` load, a share of the quantum budget. */
	renderLoad?: number;
	/** `AudioContext.outputLatency`, in ms. */
	outputLatency?: Ms;
	/** `AudioContext.baseLatency`, in ms. */
	baseLatency?: Ms;
	/** `AudioContext.currentTime`, in ms: the device clock, which must track wall time. */
	contextTime?: Ms;
	/**
	 * `AudioContext.sampleRate`, in Hz: the device's rate, not the stream's.
	 *
	 * It is what a render quantum is worth in wall time, so `worklet_cadence` is unreadable without
	 * it, and it is routinely not the catalog's: a 44.1 kHz stream still renders at whatever the
	 * output device runs at. Sampled rather than reported once in the {@link Environment}, because
	 * the context does not exist yet when the catalog first makes the rest of that readable.
	 */
	contextRate?: number;
};

/** What the page reports once, at the start, rather than every sample. */
export type Environment = {
	/** Whether the document is cross-origin isolated, and therefore which ring can run. */
	crossOriginIsolated: boolean;
	/**
	 * The transport the page's session negotiated. Anything but WebTransport bypasses the UDP shaper. The
	 * audio worker's own session is a second one, reported in {@link Sample.thread}.
	 */
	transport?: string;
	/** Round-trip time the connection reports, in ms. */
	rtt?: Ms;
	/** The audio track's codec string from the catalog. */
	catalogCodec?: string;
	/** The audio track's sample rate from the catalog, in Hz. */
	catalogRate?: number;
	/** The publisher's declared flush span, in ms: the `publish_flush` stage, declared not measured. */
	catalogJitter?: Ms;
	/** `performance.timeOrigin`, so the viewer clock can be put on the host epoch. */
	timeOrigin: number;
};

/** One batch of samples, as the page POSTs it to the sink. */
export type Beacon = {
	/** The row this page is playing, as a directory-safe key. */
	tag: string;
	/** Sent on the first batch that has it, and not again. */
	environment?: Environment;
	/** The samples in this batch. */
	samples: Sample[];
	/** Console warnings and errors the page saw, truncated. */
	notes?: string[];
};

// ── what the analyzer produces ──────────────────────────────────────────────

/** A series reduced every way the schema reports it. Nulls mean the series was empty. */
export type Stats = {
	n: number;
	p50: number | null;
	p95: number | null;
	max: number | null;
	min: number | null;
};

/** The shaper's own counters for one direction, copied through so a row records its impairment. */
export type ShaperCounters = {
	delivered: number;
	dropped: number;
	delayed: number;
	reordered: number;
	rate_limited: number;
	queue_max: number;
};

/** Why a row is not gradeable. A void row is reported, never silently passed. */
export type Void = {
	/** The assertion that failed, as a name. */
	assertion: string;
	/** What was seen instead. */
	detail: string;
};

/**
 * Why a browser row's audio did not run where every such row expects it, or undefined when it did: on the
 * page's audio worker, whose own session negotiated `transport`, the lane's. That session is a second one,
 * which the page's `transport` does not show. A build that cannot say which thread is not voided for it.
 */
export function threadVoid(thread: Thread | undefined, transport: string): Void | undefined {
	if (thread === undefined) return undefined;
	if (thread.kind === "pending") return { assertion: "thread", detail: "the audio worker never started" };
	if (thread.kind === "main") {
		const why = thread.reason === undefined ? "" : `: ${thread.reason}`;
		return { assertion: "thread", detail: `the audio played on the main thread${why}` };
	}
	if (thread.transport === transport) return undefined;
	const detail = thread.transport
		? `the audio worker's session negotiated ${thread.transport}`
		: "the audio worker had no session";
	return { assertion: "transport", detail };
}

/** Everything one matrix row produced: the graded numbers plus what makes them trustworthy. */
export type Summary = {
	/** Schema version, bumped when a metric's meaning changes rather than when one is added. */
	version: 1;
	/** The matrix cell. */
	row: Row;
	/** The shaper profile's seed, so a failing row can be replayed. */
	seed: number;
	/** Seconds of run graded, after the warmup window. */
	windowSec: number;
	/** Warmup discarded before grading, in seconds. */
	warmupSec: number;
	/** Sample rate the counters were converted at, in Hz. */
	rate: number;
	/** What the page reported about itself. */
	environment: Environment | null;
	/**
	 * Which thread fed the ring when the run ended. The page never gives the audio back to its worker once
	 * it takes it, so this is the one that held. Null on a build that cannot say; absent on a lane with no
	 * page.
	 */
	thread?: Thread | null;
	/** Reasons this row is not gradeable. Empty means it is. */
	voids: Void[];

	/** Every metric in {@link METRICS}, flattened to `<name>_<aggregation>` keys. */
	metrics: Record<string, number | null>;
	/** The resolved-target series, so a plateau can be looked at rather than inferred. */
	targetSeries: { at: Ms; ms: Ms }[];
	/** Underrun episode durations, in ms. */
	episodes: Ms[];
	/** The stage breakdown, and its named remainder. */
	stages: Record<Stage, StageSpan>;
	/** The measured end-to-end delay the stages have to sum to, in ms. */
	endToEndMs: Ms | null;
	/** Whether the stages summed to the end-to-end within {@link identityTolerance}. */
	identityHolds: boolean | null;
	/** What each non-viewer clock needed to be reduced to the viewer reference. */
	drift: Drift[];
	/** The shaper's counters, both directions. */
	shaper: { profile: string; seed: number; up: ShaperCounters; down: ShaperCounters } | null;
	/** Console warnings and errors, truncated. */
	notes: string[];
};

/** A budget row: the matrix cell it applies to, plus a ceiling per graded key. */
export type Budget = Row & {
	/** True while the values are what was measured rather than what is required. */
	recorded?: boolean;
	/** Why this row's ceilings are what they are. */
	note?: string;
	/** Every other key is `<metric>_<aggregation>` to a ceiling. */
	[key: string]: unknown;
};

/** The checked-in budget file. */
export type Budgets = {
	version: 1;
	/** What the values mean right now. */
	note: string;
	rows: Budget[];
};

/** Reduce a series to {@link Stats}. Empty in, nulls out. */
export function stats(values: number[]): Stats {
	if (values.length === 0) return { n: 0, p50: null, p95: null, max: null, min: null };
	const sorted = [...values].sort((a, b) => a - b);
	const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? null;
	return { n: values.length, p50: at(50), p95: at(95), max: at(100), min: at(0) };
}

/** One sample of "was the ring underrunning here", on whatever grid the lane samples at. */
export type Point = {
	/** When the sample was taken, on the viewer clock. */
	at: Ms;
	/** Whether the underrun counter rose between the previous sample and this one. */
	rising: boolean;
	/** Whether this sample is not gradeable: a stalled ring is silent on purpose. */
	excluded?: boolean;
};

/**
 * Maximal runs of consecutive rising samples, as durations in ms: one audible gap each.
 *
 * A point's `rising` describes the interval that ended at it, so an episode runs from the sample
 * before the first rising one to the last rising one. The sample that closes it is the first that
 * did not rise, and the interval before it carried no underrun, so it is not part of the gap.
 *
 * A run open at the last sample is closed at `endAt`. An excluded sample closes any run it lands in
 * rather than extending it, because a stall is silence the player chose and is graded on its own.
 *
 * Shared by every lane so "one long gap" and "forty scattered ones" are separated the same way
 * whether the samples came from a page, from a replay, or later from a native run.
 */
export function episodes(points: Point[], endAt: Ms): Ms[] {
	const out: Ms[] = [];
	let open: Ms | undefined;
	for (let i = 1; i < points.length; i++) {
		const prev = points[i - 1];
		const cur = points[i];
		if (!prev || !cur) continue;
		if (cur.rising && !cur.excluded && !prev.excluded) {
			open ??= prev.at;
		} else if (open !== undefined) {
			out.push(prev.at - open);
			open = undefined;
		}
	}
	if (open !== undefined) out.push(endAt - open);
	return out;
}

/**
 * Seconds from `startAt` until `series` stayed within `band` of its final value for the rest of it.
 *
 * Measured backwards from the end, because a target that settles and then moves again has not
 * converged: the question is when the last move was, not when the first plateau began.
 */
export function convergence(series: { at: Ms; ms: Ms }[], startAt: Ms, band: Ms, endAt: Ms): number | null {
	if (series.length === 0) return null;
	const final = series.at(-1)?.ms ?? 0;
	let last = -1;
	for (let i = series.length - 1; i >= 0; i--) {
		if (Math.abs((series[i]?.ms ?? 0) - final) > band) {
			last = i;
			break;
		}
	}
	const at = last < 0 ? (series[0]?.at ?? 0) : (series[last + 1]?.at ?? endAt);
	return Math.max(0, (at - startAt) / 1000);
}

/** One estimator bucket. A target within this of its final value is settled, not still moving. */
export const BUCKET_MS = 20;

/** Round to one decimal, passing null through, so a summary diff is readable. */
export const round1 = (x: number | null | undefined): number | null =>
	x === null || x === undefined || Number.isNaN(x) ? null : Math.round(x * 10) / 10;

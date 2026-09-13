import { describe, expect, it } from "bun:test";
import * as Catalog from "@moq/hang/catalog";
import * as Container from "@moq/hang/container";
import * as Moq from "@moq/net";
import { Time } from "@moq/net";
import { Signal } from "@moq/signals";
import { maxAgeHeadroom } from "./config";
import fourKWebm from "./fixtures/4k-webm.json" with { type: "json" };
import lanBbb from "./fixtures/lan-bbb.json" with { type: "json" };
import micLocal from "./fixtures/mic-local.json" with { type: "json" };
import micRemote from "./fixtures/mic-remote.json" with { type: "json" };
import relayBbb7Frame from "./fixtures/relay-bbb-7frame.json" with { type: "json" };
import { zeroRun } from "./playout/fixture";
import {
	type Arrival,
	type Build,
	CHUNK_MS,
	type Fixture,
	replay as play,
	type Result,
	recorded,
	rings,
	target as targetOf,
	trace,
} from "./replay";

// Replay arrival traces through the real estimator and both rings, and count what a listener would
// hear: quanta rendered short (an underrun) and samples the ring threw away (a skip). Both rings
// run the same harness, since the postMessage fallback is the path every page without cross-origin
// isolation takes.
//
// The recorded fixtures are arrival timing only, trimmed from the traces attached to
// moq-dev/moq#3477. Synthetic traces of the same shape come first because they say which property
// broke; the recordings say whether it broke in the field.

const RATE = 48000;
const CHUNK = (RATE * CHUNK_MS) / 1000;
// What the catalog advertises for 48kHz Opus: one frame. Sync holds this as a floor under the
// measured target.
const FLOOR = CHUNK_MS;

/** Let the consumer's spawned group readers and its delivery loop run. */
function settle(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

/** The trace's settled target, at this suite's rate and floor. */
const target = (t: Arrival[]): number => targetOf(t, FLOOR);

/** One replay at this suite's rate and floor, keeping what it rendered so silence can be found in it. */
const replay = (build: Build, t: Arrival[], warmupMs: number, fixed?: number, conceal = true): Result =>
	play(build, t, { rate: RATE, floorMs: FLOOR, warmupMs, fixed, conceal, capture: true });

/** Drop everything but what a listener would notice, so a clean run compares as a whole object. */
function clean({ underruns, skipped }: Result): { underruns: number; skipped: number } {
	return { underruns, skipped };
}

const RINGS = rings(RATE);

describe.each(RINGS)("%s ring replay", (_name, build) => {
	// The target starts at the cold-start guess and falls once a second, and a fall costs the ring
	// the bucket it lands on. Counting starts once it has settled; the traces are 12s long.
	const WARMUP = 6000;

	it("plays an evenly paced sender without underruns or skips", () => {
		const t = trace(600, 1, 10);
		expect(clean(replay(build, t, WARMUP))).toEqual({ underruns: 0, skipped: 0 });
	});

	it("plays a bursty sender at the measured target", () => {
		// Three frames flushed at once, which is what an importer packing PES payloads produces.
		const t = trace(600, 3, 5);
		expect(target(t)).toBeGreaterThan(2 * CHUNK_MS);
		expect(clean(replay(build, t, WARMUP))).toEqual({ underruns: 0, skipped: 0 });
	});

	it("keeps a five frame flush span playing", () => {
		// A hundred milliseconds of arrivals landing at once. The target covers the flush and the
		// slack above it absorbs the peak, so the flush plays instead of being cut down to the
		// target on arrival.
		const t = trace(600, 5, 5);
		expect(clean(replay(build, t, WARMUP))).toEqual({ underruns: 0, skipped: 0 });
	});

	it("runs dry when the target ignores the arrival spread", () => {
		// 46ms is what the round-trip formula produced on the connection this was measured on: it
		// describes the network and says nothing about a sender that flushes five frames at once.
		// The time stretch bends a few percent; it cannot invent the fifty milliseconds the target
		// is short by, so the ring still runs dry between flushes.
		const t = trace(600, 5, 5);
		const result = replay(build, t, WARMUP, 46, false);
		expect(result.underruns).toBeGreaterThan(20);
		// Nothing is thrown away even here: a flush only inflates the ring until it drains again,
		// which the reader no longer mistakes for a surplus. A target this shallow costs silence,
		// not audio.
		expect(result.skipped).toBe(0);
	});

	it("conceals a target that ignores the arrival spread instead of playing the gaps", () => {
		// The same too-shallow target with concealment on. Every concealed block hands the ring the
		// cushion the target was short of, so after a few of them during the warmup the ring stops
		// running dry at all: what a listener would have heard as a gap every flush is the pitch of
		// the audio around it, once, and then nothing.
		const t = trace(600, 5, 5);
		const result = replay(build, t, WARMUP, 46);
		expect(result.underruns).toBe(0);
		expect(result.short).toBe(0);
		expect(result.skipped).toBe(0);
	});
});

/**
 * Each recording, and what it is here to hold once the target has settled.
 *
 * Two of the three are zero on both counts: a target sized from the arrivals and a reader that
 * bends the media to reach it neither runs dry nor throws anything away.
 *
 * The 4k recording is not, and its budget names why rather than rounding it off. It carries real
 * holes in its media, because it was captured through a client whose age budget was skipping
 * groups. Nobody can play audio that never arrived, so the ring runs dry where a hole is and the
 * playhead steps over it; what concealment changes is what a listener hears while that happens,
 * which is why every recording holds zero silent quanta whatever else it does.
 *
 * `measured` is above the round trip, which is the claim about the estimator: the LAN trace has
 * almost no spread, so the round trip is already about the right size there and the only claim
 * worth making is that measuring does not make it worse in kind.
 */
interface Budget {
	/** Times the ring may run dry after the warmup. */
	underruns: number;
	/** Samples that may be stepped over or thrown away after the warmup. */
	skipped: number;
	/** Whether the measured target should come out above the 46ms round trip. */
	deeper: boolean;
}

const FIXTURES: Array<[string, Fixture, Budget]> = [
	// One sample over twelve seconds: the AAC frame is 23.22ms, so a rounded frame boundary
	// eventually lands a sample behind the playhead. Twenty microseconds of audio.
	["lan-bbb", lanBbb as Fixture, { underruns: 0, skipped: 1, deeper: false }],
	["relay-bbb-7frame", relayBbb7Frame as Fixture, { underruns: 0, skipped: 0, deeper: true }],
	// Holes in the recording: the ring runs dry at each one and the playhead steps over the media
	// that never arrived, which is 400ms of the 92 second capture.
	["4k-webm", fourKWebm as Fixture, { underruns: 3, skipped: 20 * CHUNK, deeper: true }],
	// The two real-microphone recordings, which are the shape a conference call has: 20ms Opus, one
	// frame per group, and an arrival spread so narrow the estimator sits on its lowest value.
	["mic-local", micLocal as Fixture, { underruns: 0, skipped: 0, deeper: false }],
	["mic-remote", micRemote as Fixture, { underruns: 0, skipped: 0, deeper: false }],
];

describe.each(RINGS)("%s ring, recorded traces", (ring, build) => {
	for (const [name, fixture, budget] of FIXTURES) {
		it(`plays ${name} without running dry or throwing audio away`, () => {
			const t = recorded(fixture);
			const settled = target(t);
			const measured = replay(build, t, 4000);
			const rtt = replay(build, t, 4000, 46);

			// Printed, because a regression in the estimator shows up as a different target long
			// before it shows up as an underrun.
			console.log(
				`${ring}/${name}: target ${settled}ms, ${measured.underruns} underruns and ${measured.skipped} skipped samples over ${measured.quanta} quanta, with ${measured.accelerates} accelerates, ${measured.expands} expands, ${measured.concealed} concealed samples and ${measured.merges} merges, against ${rtt.underruns} and ${rtt.skipped} at the 46ms round-trip target`,
			);

			expect(settled % Container.Jitter.BUCKET).toBe(0);
			expect(measured.underruns).toBeLessThanOrEqual(budget.underruns);
			expect(measured.skipped).toBeLessThanOrEqual(budget.skipped);

			// Whatever else a recording does, nothing reaches the device short: a dry ring is
			// covered rather than heard.
			//
			// Digital silence is a weaker claim, and deliberately not made here. A hole that reaches
			// the playhead with nothing behind it is concealed, but one that arrives while later
			// media is already buffered is zero-filled in place, because the ring stores PCM and has
			// no way to say which of it was invented. The native engine holds frames rather than
			// samples and does not have that hole; closing it here is a frame buffer, not a
			// concealment.
			expect(measured.short).toBe(0);

			if (budget.deeper) {
				expect(settled).toBeGreaterThan(46);
				// The control: the round trip describes the network and says nothing about a
				// publisher that flushes several frames at once, and no reader can bend media it
				// was never given time to hold.
				expect(measured.underruns).toBeLessThan(rtt.underruns);
				expect(measured.skipped).toBeLessThan(rtt.skipped);
			}
		});
	}
});

/**
 * The two microphone recordings replayed at the target the estimator settles on for them, which is
 * its lowest value: 20ms, one Opus frame.
 *
 * This is the moment the ring's own rule decides everything. The target counts the frame being
 * played, the way NetEq's does, so what the ring has to hold is the target plus one chunk; holding
 * the target alone leaves nothing unplayed and the first arrival a millisecond late finds an empty
 * ring, re-stalls, refills to the same empty level, and stutters there for as long as the call
 * lasts. That is what a listener reported hearing at "jitter buffer 20ms".
 *
 * The `fixed` target is what makes the lens: the estimator's own warmup starts at 80ms and leaves
 * the ring a cushion it never spends inside a twelve second window, which hides the steady state a
 * real call reaches within a minute.
 */
const MIC: Array<[string, Fixture, { underruns: number; short: number; trough: number }]> = [
	// One arrival 31ms late, which is past the 95th percentile the estimator reports and past what a
	// 40ms level covers. Concealment carries it: zero quanta reach the device short.
	["mic-local", micLocal as Fixture, { underruns: 1, short: 0, trough: 2 }],
	["mic-remote", micRemote as Fixture, { underruns: 0, short: 0, trough: 19 }],
];

describe.each(RINGS)("%s ring, a microphone at the settled target", (ring, build) => {
	for (const [name, fixture, budget] of MIC) {
		it(`holds a chunk above the target on ${name}`, () => {
			const t = recorded(fixture);
			const level = (result: Result) =>
				result.samples
					.filter((sample) => sample.at >= 1000 && !sample.debug.stalled)
					.map((sample) => ((sample.debug.buffered + sample.debug.queued) / RATE) * 1000);

			for (const conceal of [true, false]) {
				const measured = play(build, t, {
					rate: RATE,
					floorMs: FLOOR,
					warmupMs: 1000,
					fixed: CHUNK_MS,
					conceal,
					sampleMs: 2,
				});
				const held = level(measured);

				console.log(
					`${ring}/${name}/conceal=${conceal}: ${measured.underruns} underruns, ${measured.short} short quanta, ${measured.skipped} skipped samples, level ${Math.min(...held).toFixed(1)} to ${Math.max(...held).toFixed(1)}ms`,
				);

				expect(measured.underruns).toBeLessThanOrEqual(budget.underruns);
				expect(measured.short).toBeLessThanOrEqual(conceal ? 0 : 7);
				expect(measured.skipped).toBe(0);
				// The trough, which is the whole point: the ring is one chunk deeper than the target
				// it was told to hold, so the ordinary cadence never takes it to empty.
				expect(Math.min(...held)).toBeGreaterThanOrEqual(budget.trough);
				// And it settles inside the band rather than above it: the target, the chunk, and the
				// 20ms the decision loop tolerates on top before it accelerates.
				expect(Math.max(...held)).toBeLessThanOrEqual(CHUNK_MS + CHUNK_MS + 20 + CHUNK_MS);
			}
		});
	}
});

/**
 * The rare tail, which is what concealment is actually for.
 *
 * The traces above are steady: the target covers them and the time stretch closes what is left. The
 * gaps that made the public player stutter were none of that. They were single outages of 165, 220
 * and 111ms recorded on the relay, far past anything a stretch can bend and far past the target the
 * arrivals around them justify, and they arrive as media that simply never comes.
 */
const RARE = [165, 220, 111];

/** Drop every arrival inside `holes`, which is what a censored or lost group leaves behind. */
function holed(t: Arrival[], holes: number[]): Arrival[] {
	const first = t[0].media;
	const last = t[t.length - 1].media;
	const spacing = (last - first) / (holes.length + 1);

	return t.filter(({ media }) =>
		holes.every((hole, index) => {
			const from = first + spacing * (index + 1);
			return media < from || media >= from + hole;
		}),
	);
}

describe.each(RINGS)("%s ring, the rare tail", (ring, build) => {
	it("conceals a 165, 220 and 111ms outage rather than playing them as silence", () => {
		const t = holed(recorded(lanBbb as Fixture), RARE);
		const measured = replay(build, t, 4000);
		const ramped = replay(build, t, 4000, undefined, false);

		console.log(
			`${ring}/rare-tail: ${measured.concealed} concealed samples over ${measured.merges} merges and ${measured.underruns} underruns, against ${ramped.short} silent quanta with concealment off`,
		);

		// Every outage is covered end to end: nothing reaches the device short. The concealment
		// fades out under the muting slope, so the tail of each outage is digital silence rather
		// than room tone, and no run of it is longer than the outage that caused it.
		expect(measured.short).toBe(0);
		expect(zeroRun(measured.played)).toBeLessThan((RATE * Math.max(...RARE)) / 1000);
		expect(measured.merges).toBe(RARE.length);
		// The three outages, less the 45ms or so the ring still held when each one started.
		expect(measured.concealed).toBeGreaterThan((RATE * 300) / 1000);

		// The control, which is what the same three outages sound like without it.
		expect(ramped.short).toBeGreaterThan(0);
		expect(ramped.concealed).toBe(0);
	});
});

// --- The age budget above the decoder ---

/** The recording's own frame duration, which is the catalog floor `Sync` holds the target above. */
function frameFloor(t: Arrival[]): number {
	const sorted = [...t].map((a) => a.media).sort((a, b) => a - b);
	const gaps = sorted.slice(1).map((m, i) => m - sorted[i]);
	// The nominal spacing, not the mean: a hole in the media would drag an average up.
	return Math.ceil(Math.min(...gaps.filter((g) => g > 0)));
}

/** Frames that reached the receiver together, which is what a publisher flushes at once. */
function flushes(t: Arrival[], frame: number): Arrival[][] {
	const out: Arrival[][] = [];
	for (const a of t) {
		const open = out[out.length - 1];
		// Half a frame of slack: within a flush the arrivals are sub-millisecond apart, between
		// flushes they are a hundred milliseconds apart.
		if (open && a.arrival - open[0].arrival < frame / 2) open.push(a);
		else out.push([a]);
	}
	return out;
}

/**
 * Replay a recording into a real `Container.Consumer` through a real subscription, and count the
 * groups the age budget threw away after the estimator settled.
 *
 * The wire cursor and `#checkMaxAge` both rule on media timestamps alone, so the replay runs as
 * fast as the event loop drains rather than on the trace's wall clock; only the estimator reads
 * arrival times, and it is fed the recorded ones.
 */
async function censored(fixture: Fixture, budgetFor: (target: number) => number, warmupMs: number) {
	const t = recorded(fixture);
	const floor = frameFloor(t);
	const jitter = new Container.Jitter();

	const track = new Moq.Track.Producer("audio");
	const budget = new Signal<Time.Milli>(Time.Milli(budgetFor(floor)));
	const sub = track.subscribe({ priority: 0, maxAge: budget.peek() });
	const consumer = new Container.Consumer(sub, { format: new Container.Legacy.Format("audio"), maxAge: budget });

	// The decoder pulls as fast as frames arrive; in live playback the ring, not the consumer,
	// is what holds the delay.
	const drain = (async () => {
		for (;;) {
			if (!(await consumer.next())) break;
		}
	})();

	// The wire numbers a group by where it sits on the media timeline, not by when it turned up.
	// This recording holds seven reordered arrivals, and numbering those in arrival order would
	// build a track whose timeline goes backwards, which a consumer refuses outright. Numbering by
	// media leaves them as what they really are: a low-numbered group that arrived late.
	const sequenceOf = new Map<Arrival, number>(
		[...t].sort((x, y) => x.media - y.media).map((a, rank) => [a, rank] as const),
	);

	let warmed = 0;
	let groups = 0;

	for (const flush of flushes(t, floor)) {
		for (const { media, arrival } of flush) {
			jitter.observe(Time.Micro.fromMilli(media as Time.Milli), arrival as Time.Milli);
		}

		const target = Time.Milli(budgetFor(Math.max(floor, jitter.value.peek())));
		budget.set(target);
		sub.update({ priority: 0, maxAge: target });

		// One group per frame, because every audio frame is a keyframe and the legacy producer
		// opens a group on each one. A flush therefore delivers a run of groups at once, and the
		// oldest of them is already the whole flush behind the live edge the moment it lands.
		for (const arrival of flush) {
			// Round once here: the fixture records whole microseconds, and the millisecond form
			// this harness works in cannot always represent them exactly.
			const timestamp = Math.round(arrival.media * 1000) as Time.Micro;
			const sequence = sequenceOf.get(arrival);
			if (sequence === undefined) throw new Error("arrival is not in the recording");
			const group = new Moq.Group.Producer(sequence);
			group.writeFrame({
				payload: Container.Legacy.encodeFrame(new Uint8Array([1]), timestamp),
				timestamp: Moq.Time.Timestamp.fromMicros(timestamp),
			});
			group.close();
			track.writeGroup(group);
			if (flush[0].arrival >= warmupMs) groups++;
		}
		await settle();

		if (flush[0].arrival < warmupMs) warmed = consumer.skipped.peek();
	}

	track.close();
	await drain;

	const skipped = consumer.skipped.peek() - warmed;
	consumer.close();
	return { skipped, groups };
}

// The finding this guards, stated plainly: the age budget is the wire subscription's max age and
// the container consumer's skip threshold at once, and both rule on media timestamps. A publisher
// that flushes seven frames together puts the oldest of them a whole flush behind the live edge the
// moment it lands, so a budget below the flush span convicts content that had already arrived, and
// the estimator underneath it can then only ever confirm the budget it was cut to.
describe("budget-censors-the-tail", () => {
	it("reports what the age budget throws away above the decoder", async () => {
		const headroom = maxAgeHeadroom(
			Catalog.AudioConfigSchema.parse({
				codec: "mp4a.40.2",
				container: { kind: "legacy" },
				sampleRate: 44100,
				numberOfChannels: 2,
			}),
		);

		const bare = await censored(relayBbb7Frame as Fixture, (target) => target, 4000);
		const padded = await censored(relayBbb7Frame as Fixture, (target) => target + headroom, 4000);
		// What the round-trip formula asked for before the target was measured. The control that
		// makes the two numbers above mean something: the budget really does censor, it just has
		// to fall below the publisher's flush span first.
		const roundTrip = await censored(relayBbb7Frame as Fixture, () => 46, 4000);

		console.log(
			`budget-censors-the-tail: ${bare.skipped}/${bare.groups} groups convicted at the measured target, ${padded.skipped} with ${headroom}ms of headroom, ${roundTrip.skipped} at the 46ms round-trip budget`,
		);

		expect(roundTrip.skipped).toBeGreaterThan(0);

		// The measured target already sits far above this publisher's 139ms flush span, so it
		// censors nothing here with or without the headroom: the headroom is insurance against a
		// path whose target lands close to the flush, not a fix for this recording. Pinned at zero
		// so a change that starts convicting at the measured target fails here.
		expect(bare.skipped).toBe(0);
		expect(padded.skipped).toBe(0);
	}, 25_000);
});

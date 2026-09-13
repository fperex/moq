import { describe, expect, it } from "bun:test";
import * as Container from "@moq/hang/container";
import { Time } from "@moq/net";
import fourKWebm from "./fixtures/4k-webm.json" with { type: "json" };
import lanBbb from "./fixtures/lan-bbb.json" with { type: "json" };
import relayBbb7Frame from "./fixtures/relay-bbb-7frame.json" with { type: "json" };
import { AudioRingBuffer } from "./ring-buffer";
import { allocSharedRingBuffer, SharedRingBuffer } from "./shared-ring-buffer";

// Replay arrival traces through the real estimator and both rings, and count what a listener would
// hear: quanta rendered short (an underrun) and samples the ring threw away (a skip). Both rings
// run the same harness, since the postMessage fallback is the path every page without cross-origin
// isolation takes.
//
// The recorded fixtures are arrival timing only, trimmed from the traces attached to
// moq-dev/moq#3477. Synthetic traces of the same shape come first because they say which property
// broke; the recordings say whether it broke in the field.

const RATE = 48000;
const QUANTUM = 128; // an AudioWorklet render quantum
const CHUNK_MS = 20; // one Opus frame
const CHUNK = (RATE * CHUNK_MS) / 1000;
// What the catalog advertises for 48kHz Opus: one frame. Sync holds this as a floor under the
// measured target.
const FLOOR = CHUNK_MS;

/** Deterministic PRNG, so a trace is the same on every machine. */
function rng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** One frame of a trace: when it was captured, and the wall time it reached us. */
interface Arrival {
	media: number;
	arrival: number;
}

/**
 * A sender emitting a frame every `CHUNK_MS`, holding `burst - 1` of them back and flushing the
 * run at once, plus `spread` ms of per-flush network jitter. `burst` of 1 is an evenly paced
 * sender; anything above it is the PES packing an importer produces.
 */
function trace(frames: number, burst: number, spread: number, seed = 7): Arrival[] {
	const rand = rng(seed);
	const out: Arrival[] = [];
	let held: number[] = [];
	for (let i = 0; i < frames; i++) {
		const media = i * CHUNK_MS;
		held.push(media);
		if (held.length < burst) continue;
		// Every frame keeps its own capture time; the whole run shares one arrival.
		const arrival = media + 50 + rand() * spread;
		for (const m of held) out.push({ media: m, arrival });
		held = [];
	}
	return out;
}

/** A recorded fixture, as trimmed into `./fixtures`. */
interface Fixture {
	source: string;
	description: string;
	arrivals: { timestamp_us: number; arrival_ms: number }[];
}

function recorded(fixture: Fixture): Arrival[] {
	return fixture.arrivals.map(({ timestamp_us, arrival_ms }) => ({
		media: timestamp_us / 1000,
		arrival: arrival_ms,
	}));
}

/**
 * The target the estimator settles on for a trace: the real `Jitter`, fed the same arrivals, held
 * above the catalog floor the way `Sync` holds it.
 *
 * Also the whole point of the exercise. Nothing here approximates the estimator, so a change that
 * moves it moves what these rings are sized to.
 */
function target(t: Arrival[]): number {
	const jitter = new Container.Jitter();
	for (const { media, arrival } of t) {
		jitter.observe(Time.Micro.fromMilli(media as Time.Milli), arrival as Time.Milli);
	}
	return Math.max(FLOOR, jitter.value.peek());
}

/** The two rings behind one interface, since the harness drives them identically. */
interface Ring {
	insert(timestamp: Time.Micro, data: Float32Array[]): void;
	read(output: Float32Array[]): number;
	setLatency(ms: number): void;
	readonly length: number;
}

// Sized for the estimator's ceiling up front, the way `SharedAudioBuffer` does, so a rising target
// never reallocates.
function shared(latencyMs: number): Ring {
	const ceiling = Math.ceil((RATE * Container.Jitter.CEILING) / 1000);
	const ring = new SharedRingBuffer(allocSharedRingBuffer(1, ceiling, RATE));
	ring.setLatency(Math.ceil((RATE * latencyMs) / 1000));
	return {
		insert: (timestamp, data) => ring.insert(timestamp, data),
		read: (output) => ring.read(output),
		setLatency: (ms) => ring.setLatency(Math.ceil((RATE * ms) / 1000)),
		get length() {
			return ring.length;
		},
	};
}

function post(latencyMs: number): Ring {
	const ring = new AudioRingBuffer({ rate: RATE, channels: 1, latency: latencyMs as Time.Milli });
	return {
		insert: (timestamp, data) => ring.write(timestamp, data),
		read: (output) => ring.read(output),
		setLatency: (ms) => ring.resize(ms as Time.Milli),
		get length() {
			return ring.length;
		},
	};
}

interface Result {
	/** Quanta rendered short of a full block after the warmup, i.e. audible underruns. */
	underruns: number;
	/** Samples inserted after the warmup that were never played: skipped or overflow-dropped. */
	skipped: number;
	/** Quanta rendered after the warmup, so `underruns` can be read as a rate. */
	quanta: number;
}

/**
 * How many samples each frame carries, taken from the distance to the next frame on the media
 * timeline. A recorded AAC trace is 23.22ms per frame, not the 20ms a synthetic Opus trace uses, and
 * inserting the wrong count leaves the ring gap-filling silence between every pair of frames.
 */
function frameSamples(t: Arrival[]): number[] {
	const sorted = [...t].sort((a, b) => a.media - b.media);
	const spacing = new Map<number, number>();

	for (let i = 0; i < sorted.length - 1; i++) {
		const gap = sorted[i + 1].media - sorted[i].media;
		// A gap far past one frame is missing media, not a long frame: keep the frame its own size
		// and let the ring fill the hole.
		spacing.set(sorted[i].media, gap > 0 && gap < 100 ? gap : 0);
	}

	const nominal = Math.max(...spacing.values().filter((v) => v > 0));
	return t.map(({ media }) => Math.round((RATE * (spacing.get(media) || nominal)) / 1000));
}

/**
 * Play `t` through `ring` in real time: insert every frame the moment it arrives, and pull one
 * render quantum every quantum's worth of wall time, which is what the AudioWorklet does.
 */
function replay(build: (latencyMs: number) => Ring, t: Arrival[], warmupMs: number, fixed?: number): Result {
	const step = (QUANTUM / RATE) * 1000;
	const output = [new Float32Array(QUANTUM)];
	const end = t[t.length - 1].arrival;
	const samples = frameSamples(t);

	// The estimator runs live, exactly as `Container.Consumer` drives it: observe at arrival, and
	// let `Sync` and `Decoder.#runLatency` push the new target into the ring. A settled number
	// measured up front would hide the thing the design turns on, which is that the target rises the
	// moment an arrival proves the buffer too shallow.
	const jitter = new Container.Jitter();
	const latency = () => fixed ?? Math.max(FLOOR, jitter.value.peek());

	const ring = build(latency());

	let next = 0;
	let played = 0;
	let inserted = 0;
	let short = 0;
	let started = false;
	let quanta = 0;
	let mark: { played: number; inserted: number; buffered: number; short: number; quanta: number } | undefined;

	for (let now = 0; now < end; now += step) {
		while (next < t.length && t[next].arrival <= now) {
			const count = samples[next];
			jitter.observe(Time.Micro.fromMilli(t[next].media as Time.Milli), now as Time.Milli);
			ring.setLatency(latency());
			ring.insert(Time.Micro.fromMilli(t[next].media as Time.Milli), [new Float32Array(count).fill(0.5)]);
			inserted += count;
			next++;
		}

		const count = ring.read(output);
		played += count;
		quanta++;
		if (started && count < QUANTUM) short++;
		if (count > 0) started = true;

		if (now >= warmupMs && !mark) mark = { played, inserted, buffered: ring.length, short, quanta };
	}

	const from = mark ?? { played, inserted, buffered: ring.length, short, quanta };
	return {
		underruns: short - from.short,
		skipped: inserted - from.inserted - (played - from.played) - (ring.length - from.buffered),
		quanta: quanta - from.quanta,
	};
}

/** Drop the quantum count, so a clean run compares as a whole object. */
function clean({ underruns, skipped }: Result): { underruns: number; skipped: number } {
	return { underruns, skipped };
}

const RINGS: Array<[string, (latencyMs: number) => Ring]> = [
	["shared", shared],
	["post", post],
];

describe.each(RINGS)("%s ring replay", (_name, build) => {
	// The target starts at the cold-start guess and falls one bucket per second, and a fall costs
	// the ring the bucket it lands on. Counting starts once it has settled; the traces are 12s long.
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

	it("underruns constantly when the target ignores the arrival spread", () => {
		// 46ms is what the round-trip formula produced on the connection this was measured on: it
		// describes the network and says nothing about a sender that flushes five frames at once.
		const t = trace(600, 5, 5);
		const result = replay(build, t, WARMUP, 46);
		expect(result.underruns).toBeGreaterThan(100);
		expect(result.skipped).toBeGreaterThan(10 * CHUNK);
	});
});

/**
 * Each recording, and what it is here to hold.
 *
 * `improvement` is how much better than the 46ms round-trip target the measured one has to be. The
 * LAN trace has almost no spread, so the round trip is already about the right size there and the
 * claim worth making is only that measuring does not make it worse in kind.
 *
 * `shortRate` is the share of quanta allowed to end short, and it is not zero. The target is a 95th
 * percentile, so the tail above it lands by construction, and the two remote recordings also carry
 * real holes in their media: they were captured through a client whose age budget was skipping
 * groups, which is the finding the next quest is about. Absorbing the rest without a deeper buffer
 * is what the time-stretch quest is for. These are ceilings, not goals.
 */
const FIXTURES: Array<[string, Fixture, { improvement: number; shortRate: number }]> = [
	["lan-bbb", lanBbb as Fixture, { improvement: 0, shortRate: 0.02 }],
	["relay-bbb-7frame", relayBbb7Frame as Fixture, { improvement: 4, shortRate: 0.05 }],
	["4k-webm", fourKWebm as Fixture, { improvement: 4, shortRate: 0.05 }],
];

describe.each(RINGS)("%s ring, recorded traces", (ring, build) => {
	for (const [name, fixture, budget] of FIXTURES) {
		it(`sizes ${name} from what arrived rather than from the round trip`, () => {
			const t = recorded(fixture);
			const settled = target(t);
			const measured = replay(build, t, 4000);
			const rtt = replay(build, t, 4000, 46);

			// Printed, because a regression in the estimator shows up as a different target long
			// before it shows up as an underrun.
			console.log(
				`${ring}/${name}: target ${settled}ms, ${measured.underruns}/${measured.quanta} short quanta and ${measured.skipped} skipped samples, against ${rtt.underruns} and ${rtt.skipped} at the 46ms round-trip target`,
			);

			expect(settled % Container.Jitter.BUCKET).toBe(0);
			expect(measured.underruns / measured.quanta).toBeLessThan(budget.shortRate);

			if (budget.improvement > 0) {
				expect(settled).toBeGreaterThan(46);
				expect(measured.underruns * budget.improvement).toBeLessThan(rtt.underruns);
				expect(measured.skipped * budget.improvement).toBeLessThan(rtt.skipped);
			}
		});
	}
});

import { describe, expect, it } from "bun:test";
import * as Catalog from "@moq/hang/catalog";
import * as Container from "@moq/hang/container";
import * as Moq from "@moq/net";
import { Time } from "@moq/net";
import { Signal } from "@moq/signals";
import { maxAgeHeadroom } from "./config";
import fourKWebm from "./fixtures/4k-webm.json" with { type: "json" };
import lanBbb from "./fixtures/lan-bbb.json" with { type: "json" };
import relayBbb7Frame from "./fixtures/relay-bbb-7frame.json" with { type: "json" };
import { type RingReader, type Snapshot, Stretcher } from "./playout";
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

/** Let the consumer's spawned group readers and its delivery loop run. */
function settle(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

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
	readonly reader: RingReader;
	insert(timestamp: Time.Micro, data: Float32Array[]): void;
	setLatency(ms: number): void;
	debug(): Snapshot;
	readonly length: number;
}

// Sized for the estimator's ceiling up front, the way `SharedAudioBuffer` does, so a rising target
// never reallocates.
function shared(latencyMs: number): Ring {
	const ceiling = Math.ceil((RATE * Container.Jitter.CEILING) / 1000);
	const ring = new SharedRingBuffer(allocSharedRingBuffer(1, ceiling, RATE));
	ring.setLatency(Math.ceil((RATE * latencyMs) / 1000));
	return {
		reader: ring,
		insert: (timestamp, data) => ring.insert(timestamp, data),
		setLatency: (ms) => ring.setLatency(Math.ceil((RATE * ms) / 1000)),
		debug: () => ring.debug(),
		get length() {
			return ring.length;
		},
	};
}

function post(latencyMs: number): Ring {
	const ring = new AudioRingBuffer({ rate: RATE, channels: 1, latency: latencyMs as Time.Milli });
	return {
		reader: ring,
		insert: (timestamp, data) => ring.write(timestamp, data),
		setLatency: (ms) => ring.resize(ms as Time.Milli),
		debug: () => ring.debug(),
		get length() {
			return ring.length;
		},
	};
}

interface Result {
	/** Times the reader ran dry mid-playback after the warmup. */
	underruns: number;
	/** Samples thrown away after the warmup: the reader skipped them or the writer dropped them. */
	skipped: number;
	/** Quanta rendered after the warmup, so `underruns` can be read as a rate. */
	quanta: number;
	/** Quanta that came back short of a full block after the warmup. */
	short: number;
	/** Blocks the time stretch shortened and lengthened after the warmup. */
	accelerates: number;
	expands: number;
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
 * render quantum every quantum's worth of wall time through the real playout engine, which is what
 * the AudioWorklet does.
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
	const engine = new Stretcher(RATE, 1);

	let next = 0;
	let outputFrame = 0;
	let started = false;
	let quanta = 0;
	let short = 0;
	let mark: { quanta: number; short: number; debug: Snapshot } | undefined;

	for (let now = 0; now < end; now += step) {
		while (next < t.length && t[next].arrival <= now) {
			const count = samples[next];
			jitter.observe(Time.Micro.fromMilli(t[next].media as Time.Milli), now as Time.Milli);
			ring.setLatency(latency());
			// A 200Hz tone rather than a constant: a splice on a constant is seamless whatever the
			// correlation search decides, which would hide a kernel that picked the wrong lag.
			ring.insert(Time.Micro.fromMilli(t[next].media as Time.Milli), [voice(count)]);
			next++;
		}

		const count = engine.render(ring.reader, output, outputFrame);
		outputFrame += QUANTUM;
		quanta++;
		if (started && count < QUANTUM) short++;
		if (count > 0) started = true;

		if (now >= warmupMs && !mark) mark = { quanta, short, debug: ring.debug() };
	}

	const debug = ring.debug();
	const from = mark ?? { quanta, short, debug };
	return {
		underruns: debug.underruns - from.debug.underruns,
		skipped: debug.skipped - from.debug.skipped + (debug.discarded - from.debug.discarded),
		quanta: quanta - from.quanta,
		short: short - from.short,
		accelerates: debug.accelerates - from.debug.accelerates,
		expands: debug.expands - from.debug.expands,
	};
}

/** A 200Hz tone the correlation search can find a period in. */
const TONE = new Float32Array(RATE);
for (let i = 0; i < TONE.length; i++) TONE[i] = 0.5 * Math.sin((2 * Math.PI * 200 * i) / RATE);

let voiceAt = 0;
function voice(count: number): Float32Array {
	const start = voiceAt % (TONE.length - count);
	voiceAt += count;
	return TONE.slice(start, start + count);
}

/** Drop everything but what a listener would notice, so a clean run compares as a whole object. */
function clean({ underruns, skipped }: Result): { underruns: number; skipped: number } {
	return { underruns, skipped };
}

const RINGS: Array<[string, (latencyMs: number) => Ring]> = [
	["shared", shared],
	["post", post],
];

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
		const result = replay(build, t, WARMUP, 46);
		expect(result.underruns).toBeGreaterThan(20);
		// Nothing is thrown away even here: a flush only inflates the ring until it drains again,
		// which the reader no longer mistakes for a surplus. A target this shallow costs silence,
		// not audio.
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
 * groups: no reader can play audio that never arrived, so the ring runs dry where the hole is and
 * the frame that lands after it is entirely older than the playhead. Concealment is the next quest;
 * until then those quanta are silence.
 *
 * `measured` is above the round trip, which is the claim about the estimator: the LAN trace has
 * almost no spread, so the round trip is already about the right size there and the only claim
 * worth making is that measuring does not make it worse in kind.
 */
interface Budget {
	/** Times the ring may run dry after the warmup. */
	underruns: number;
	/** Samples that may be thrown away after the warmup. */
	skipped: number;
	/** Whether the measured target should come out above the 46ms round trip. */
	deeper: boolean;
}

const FIXTURES: Array<[string, Fixture, Budget]> = [
	["lan-bbb", lanBbb as Fixture, { underruns: 0, skipped: 0, deeper: false }],
	["relay-bbb-7frame", relayBbb7Frame as Fixture, { underruns: 0, skipped: 0, deeper: true }],
	// One hole in the recording: one dry ring, and one frame that arrived entirely too late.
	["4k-webm", fourKWebm as Fixture, { underruns: 2, skipped: CHUNK, deeper: true }],
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
				`${ring}/${name}: target ${settled}ms, ${measured.underruns} underruns and ${measured.skipped} skipped samples over ${measured.quanta} quanta, with ${measured.accelerates} accelerates and ${measured.expands} expands, against ${rtt.underruns} and ${rtt.skipped} at the 46ms round-trip target`,
			);

			expect(settled % Container.Jitter.BUCKET).toBe(0);
			expect(measured.underruns).toBeLessThanOrEqual(budget.underruns);
			expect(measured.skipped).toBeLessThanOrEqual(budget.skipped);

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

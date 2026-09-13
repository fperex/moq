import { describe, expect, it } from "bun:test";
import { Time } from "@moq/net";
import {
	type Counters,
	frames,
	type RingReader,
	type RingView,
	type Snapshot,
	STRETCH_BOUND,
	Stretcher,
} from "./playout";
import { maxStep, speech, zeroRun } from "./playout/fixture";
import { AudioRingBuffer } from "./ring-buffer";
import { allocSharedRingBuffer, SharedRingBuffer } from "./shared-ring-buffer";

// The worklet's produce/drain loop, driven over both ring transports on a simulated output clock.
// Everything here is the real `Stretcher` against the real rings; only the AudioWorklet's `process`
// callback is replaced, by a loop that advances `currentFrame` a quantum at a time.

const RATE = 48000;
const QUANTUM = 128;
const CHUNK_MS = 20;
const CHUNK = frames(RATE, CHUNK_MS);

/** Milliseconds as samples at the harness rate. */
function ms(value: number): number {
	return frames(RATE, value);
}

/** One ring behind the surface the harness drives it through. */
interface Harness {
	readonly reader: RingReader;
	insert(start: number, count: number): void;
	setLatency(samples: number): void;
	debug(): Snapshot;
}

function shared(targetMs: number, buffered = false): Harness {
	const ring = new SharedRingBuffer(allocSharedRingBuffer(1, RATE * 2, RATE, buffered));
	ring.setLatency(ms(targetMs));
	return {
		reader: ring,
		insert: (start, count) => ring.insert(micro(start), [media(start, count)]),
		setLatency: (samples) => ring.setLatency(samples),
		debug: () => ring.debug(),
	};
}

function post(targetMs: number, buffered = false): Harness {
	const ring = new AudioRingBuffer({ rate: RATE, channels: 1, latency: targetMs as Time.Milli, buffered });
	return {
		reader: ring,
		insert: (start, count) => ring.write(micro(start), [media(start, count)]),
		setLatency: (samples) => ring.resize(((samples / RATE) * 1000) as Time.Milli),
		debug: () => ring.debug(),
	};
}

const RINGS: Array<[string, (targetMs: number, buffered?: boolean) => Harness]> = [
	["shared", shared],
	["post", post],
];

/**
 * A 200Hz tone that pauses, over a quiet room: a splice that is not seamless shows up as a step,
 * and the pauses are what let the background estimate learn a level for concealment to fade into.
 */
const FLOOR = 0.002;
const SOURCE = speech(RATE, 40, 200, 0.5, FLOOR)[0];

/** The steepest a sample-to-sample step can be and still be the fixture rather than a click. */
const SLOPE = (0.5 * 2 * Math.PI * 200) / RATE + 2 * FLOOR;

function media(start: number, count: number): Float32Array {
	return SOURCE.slice(start % (SOURCE.length - count), (start % (SOURCE.length - count)) + count);
}

function micro(samples: number): Time.Micro {
	return Time.Micro.fromSecond((samples / RATE) as Time.Second);
}

interface Script {
	/** The playout target, in milliseconds. */
	target: number;
	/** Whether a gap is concealed rather than rendered as a ramp into silence. Defaults to on. */
	conceal?: boolean;
	/** A hole in the media, as a fraction of the run and a length in milliseconds. */
	hole?: { at: number; ms: number };
	/** Media inserted before the first quantum is pulled, in milliseconds. */
	prefill: number;
	/** How long to run, in seconds of output. */
	seconds: number;
	/**
	 * How fast the sender runs relative to the output clock: 1 is exact, 0.98 is a sender running
	 * two percent slow, which drains the ring at the same rate.
	 */
	pace?: number;
	/** Output frame at which to park the ring, as a fraction of the run. */
	stallAt?: number;
}

interface Report extends Snapshot {
	/** Everything the engine emitted, so a splice can be checked for continuity. */
	played: Float32Array;
	/** Quanta that came back short of a full block. */
	shortQuanta: number;
	/** Whether `READ == output - concealed + stretched + queued + skipped` held on every quantum. */
	balanced: boolean;
	/** Whether the media playhead ever stepped backwards. */
	monotone: boolean;
}

function run(build: (targetMs: number, buffered?: boolean) => Harness, script: Script): Report {
	const harness = build(script.target);
	const engine = new Stretcher(RATE, 1, script.conceal ?? true);
	const out = [new Float32Array(QUANTUM)];

	const quanta = Math.floor((RATE * script.seconds) / QUANTUM);
	const played = new Float32Array(quanta * QUANTUM);
	const pace = script.pace ?? 1;
	const stallAt = script.stallAt === undefined ? undefined : Math.floor(quanta * script.stallAt);

	// Where the sender is on the media timeline, and how far the media it actually sent reaches:
	// the two differ by a hole, which is the part nobody can account for.
	let written = 0;
	let inserted = 0;
	while (written < ms(script.prefill)) {
		harness.insert(written, CHUNK);
		written += CHUNK;
		inserted = written;
	}

	// Where the hole sits on the media timeline, and how much of it never arrives.
	const hole = script.hole && {
		from: written + Math.floor(quanta * script.hole.at) * QUANTUM,
		frames: ms(script.hole.ms),
	};

	let outputFrame = 0;
	let nextArrival = CHUNK / pace;
	let shortQuanta = 0;
	let length = 0;
	let balanced = true;
	let monotone = true;
	let playhead = Number.NEGATIVE_INFINITY;

	for (let q = 0; q < quanta; q++) {
		while (outputFrame >= nextArrival) {
			// A hole is media that never arrives: the timeline keeps its place, so what lands after
			// it is the audio that follows the hole rather than the audio inside it.
			const missing = hole && written >= hole.from && written < hole.from + hole.frames;
			if (!missing) {
				harness.insert(written, CHUNK);
				inserted = written + CHUNK;
			}
			written += CHUNK;
			nextArrival += CHUNK / pace;
		}
		if (q === stallAt) harness.reader.starve();

		out[0].fill(0);
		const got = engine.render(harness.reader, out, outputFrame);
		played.set(out[0].subarray(0, got), length);
		length += got;
		if (got < QUANTUM) shortQuanta++;

		const debug = harness.debug();
		// What the ring handed over is what was played, less the frames that were made up rather
		// than read, plus what a stretch moved, plus what is still in flight, plus what a jump
		// passed over. `inserted - buffered` is READ.
		const read = inserted - debug.buffered;
		const heard = debug.output - debug.concealed;
		if (read !== heard + debug.stretched + debug.queued + debug.skipped + debug.discarded) {
			balanced = false;
		}
		const media = read - debug.queued;
		if (media < playhead) monotone = false;
		playhead = media;

		outputFrame += QUANTUM;
	}

	return {
		...harness.debug(),
		played: played.subarray(0, length),
		shortQuanta,
		balanced,
		monotone,
	};
}

describe.each(RINGS)("%s ring worklet", (name, build) => {
	it("converges from the top of the band without skipping or running dry", () => {
		// 180ms is inside the 195ms band (target, a chunk, and the stretch bound) and well above the
		// 140ms upper limit an accelerate works down to. Past the band the reader jumps rather than
		// stretching, which is the next test. Every prefill here is a whole number of chunks,
		// because a ring is only ever a chunk at a time full.
		const report = run(build, { target: 100, prefill: 180, seconds: 6 });

		console.log(
			`${name}: converged to ${(report.buffered / RATE) * 1000}ms with ${report.accelerates} accelerates, ${report.expands} expands, ${report.skips} skips, ${report.underruns} underruns`,
		);

		expect(report.skips).toBe(0);
		expect(report.underruns).toBe(0);
		expect(report.shortQuanta).toBe(0);
		expect(report.accelerates).toBeGreaterThan(0);
		expect(report.balanced).toBe(true);
		expect(report.monotone).toBe(true);

		// The band's upper limit, which is where an accelerate stops: NetEq converges into the band,
		// not onto a point.
		expect(report.buffered).toBeLessThanOrEqual(ms(100 + CHUNK_MS + 20));
		// A chunk of slack below, because the ring is only refilled once per chunk.
		expect(report.buffered).toBeGreaterThanOrEqual(ms(100) - CHUNK);

		// Every splice landed on a pitch period, so the tone came out a tone.
		expect(zeroRun(report.played)).toBeLessThanOrEqual(2);
		expect(maxStep(report.played)).toBeLessThan(1.5 * SLOPE);
	});

	it("tracks a sender running slow instead of running dry", () => {
		// Two percent slow drains the ring in five seconds. An expansion consumes less media than it
		// emits, so the ring holds its depth instead. The prefill is what the ring holds: the 100ms
		// target with the 20ms chunk being played on top of it.
		const report = run(build, { target: 100, prefill: 120, seconds: 10, pace: 0.98 });

		console.log(
			`${name}: slow sender left ${(report.buffered / RATE) * 1000}ms buffered after ${report.expands} expands and ${report.underruns} underruns`,
		);

		expect(report.expands).toBeGreaterThan(0);
		expect(report.underruns).toBe(0);
		expect(report.shortQuanta).toBe(0);
		expect(report.balanced).toBe(true);
		expect(report.monotone).toBe(true);
		expect(zeroRun(report.played)).toBeLessThanOrEqual(2);
	});

	it("skips only past the band", () => {
		const inside = run(build, { target: 100, prefill: 180, seconds: 2 });
		expect(inside.skips).toBe(0);
		expect(inside.skipped + inside.discarded).toBe(0);

		// 300ms is well past the 195ms band, and past what an accelerate closes before the ring is
		// next looked at. The shared ring jumps its reader; the post ring's writer bounds it on the
		// way in, so the same audio is dropped a step earlier.
		const outside = run(build, { target: 100, prefill: 300, seconds: 2 });
		expect(outside.skipped + outside.discarded).toBeGreaterThan(0);
	});

	it("parks and resumes without losing the balance", () => {
		const script: Script = { target: 100, prefill: 100 + CHUNK_MS, seconds: 6, stallAt: 0.5 };
		const report = run(build, script);

		expect(report.balanced).toBe(true);
		expect(report.monotone).toBe(true);
		// The park itself is the one underrun; the refill covers the rest.
		expect(report.underruns).toBe(1);
		// Concealment covers the refill, so nothing reaches the device short.
		expect(report.shortQuanta).toBe(0);
		expect(report.concealed).toBeGreaterThan(0);

		// And the same park without it is the silence the ramp was written for.
		const ramped = run(build, { ...script, conceal: false });
		expect(ramped.balanced).toBe(true);
		expect(ramped.underruns).toBe(1);
		expect(ramped.shortQuanta).toBeGreaterThan(0);
		expect(ramped.concealed).toBe(0);
	});

	it("conceals a hole in the media instead of playing it as silence", () => {
		// 150ms of media that never arrives, which is longer than any stretch can cover and is what
		// a censored group leaves behind.
		const script: Script = { target: 100, prefill: 100 + CHUNK_MS, seconds: 6, hole: { at: 0.4, ms: 150 } };
		const report = run(build, script);

		console.log(
			`${name}: a 150ms hole left ${report.concealed} concealed samples over ${report.merges} merges, ${report.shortQuanta} short quanta and ${report.underruns} underruns`,
		);

		expect(report.balanced).toBe(true);
		expect(report.monotone).toBe(true);
		expect(report.concealed).toBeGreaterThan(ms(100));
		expect(report.merges).toBeGreaterThan(0);
		// Nothing reached the device short, and nothing came out as digital silence.
		expect(report.shortQuanta).toBe(0);
		expect(zeroRun(report.played)).toBeLessThanOrEqual(2);
		// The concealment is spliced on a pitch period at both ends, like every other operation.
		expect(maxStep(report.played)).toBeLessThan(1.5 * SLOPE);
	});

	it("renders the same hole as a ramped gap with concealment off", () => {
		const report = run(build, {
			target: 100,
			prefill: 100 + CHUNK_MS,
			seconds: 6,
			hole: { at: 0.4, ms: 150 },
			conceal: false,
		});

		expect(report.balanced).toBe(true);
		expect(report.concealed).toBe(0);
		expect(report.merges).toBe(0);
		// The gap is the thing being measured: quanta that came back short, and the silence after.
		expect(report.shortQuanta).toBeGreaterThan(0);
	});
});

describe("both rings", () => {
	it("count the same operations for the same script", () => {
		const script: Script = { target: 100, prefill: 180, seconds: 6 };
		const a = run(shared, script);
		const b = run(post, script);

		expect({ accelerates: b.accelerates, expands: b.expands, skips: b.skips, underruns: b.underruns }).toEqual({
			accelerates: a.accelerates,
			expands: a.expands,
			skips: a.skips,
			underruns: a.underruns,
		});
		expect(b.output).toBe(a.output);
		expect(b.stretched).toBe(a.stretched);
	});
});

describe("a ring that moves under the reader", () => {
	/** A reader that hands over one block and then refuses the commit, as a rebase does. */
	class Moving implements RingReader {
		readonly rate = RATE;
		readonly channels = 1;
		commits = 0;
		reports: Counters[] = [];

		view(): RingView {
			return {
				buffered: ms(200),
				target: ms(100),
				chunk: CHUNK,
				skip: ms(STRETCH_BOUND),
				stalled: false,
				unstable: false,
				converge: true,
				skipped: 0,
				generation: 1,
			};
		}

		peek(dst: Float32Array[], count: number, offset = 0): void {
			dst[0].set(SOURCE.subarray(0, count), offset);
		}

		commit(): boolean {
			this.commits++;
			return false;
		}

		starve(): void {}

		report(counters: Counters): void {
			this.reports.push(counters);
		}
	}

	it("queues nothing when the commit is refused", () => {
		const ring = new Moving();
		const engine = new Stretcher(RATE, 1);
		const out = [new Float32Array(QUANTUM)];

		expect(engine.render(ring, out, 0)).toBe(0);
		expect(ring.commits).toBe(1);
		expect(out[0].every((sample) => sample === 0)).toBe(true);

		const last = ring.reports[ring.reports.length - 1];
		expect(last.queued).toBe(0);
		expect(last.output).toBe(0);
		expect(last.stretched).toBe(0);
	});
});

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

/** Either ring, with the calls the two transports spell differently behind one name. */
interface Ring {
	/** The ring itself, for everything both transports spell alike. */
	readonly buffer: AudioRingBuffer | SharedRingBuffer;
	insert(timestamp: Time.Micro, data: Float32Array[]): void;
	setLatency(ms: number): void;
	/** Every counter, copied: the postMessage ring refills one object, as its state message copies it. */
	debug(): Snapshot;
}

/** Build a ring already holding a target of `latencyMs`. */
type Build = (latencyMs: number) => Ring;

/** The shared-memory ring a cross-origin isolated page runs, sized for a two second target. */
function shared(rate: number): Build {
	return (latencyMs: number) => {
		const buffer = new SharedRingBuffer(allocSharedRingBuffer(1, rate * 4, rate));
		buffer.setLatency(Math.ceil((rate * latencyMs) / 1000));
		return {
			buffer,
			insert: (timestamp, data) => buffer.insert(timestamp, data),
			setLatency: (ms) => buffer.setLatency(Math.ceil((rate * ms) / 1000)),
			debug: () => buffer.debug(),
		};
	};
}

/** The postMessage ring, which is the path every page without cross-origin isolation takes. */
function post(rate: number): Build {
	return (latencyMs: number) => {
		const buffer = new AudioRingBuffer({ rate, channels: 1, latency: latencyMs as Time.Milli });
		return {
			buffer,
			insert: (timestamp, data) => buffer.write(timestamp, data),
			setLatency: (ms) => buffer.resize(ms as Time.Milli),
			debug: () => ({ ...buffer.debug() }),
		};
	};
}

const RINGS: Array<[string, Build]> = [
	["shared", shared(RATE)],
	["post", post(RATE)],
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

/** Insert `count` samples of the fixture at sample `start`. */
function insert(ring: Ring, start: number, count: number): void {
	ring.insert(micro(start), [media(start, count)]);
}

interface Script {
	/** The playout target, in milliseconds: the level the ring holds, as `target()` resolves it. */
	target: number;
	/** Whether a gap is concealed rather than rendered as a ramp into silence. Defaults to on. */
	conceal?: boolean;
	/** A hole in the media, as a fraction of the run and a length in milliseconds. */
	hole?: { at: number; ms: number };
	/** Media inserted before the first quantum is pulled, in milliseconds. */
	prefill: number;
	/**
	 * Media handed over in one go once playback has started, in milliseconds.
	 *
	 * How a surplus arrives in a real stream: a publisher's flush, or a path that stalled. The sender
	 * keeps its own schedule afterwards, so the ring stays that much deeper.
	 */
	burst?: number;
	/** How long to run, in seconds of output. */
	seconds: number;
	/**
	 * How fast the sender runs relative to the output clock: 1 is exact, 0.98 is a sender running
	 * two percent slow, which drains the ring at the same rate.
	 */
	pace?: number;
	/** Output frame at which to park the ring, as a fraction of the run. */
	stallAt?: number;
	/**
	 * Target changes once playback is under way, as a fraction of the run and the new target in
	 * milliseconds: what the estimator's walk does to a ring that is already playing.
	 */
	steps?: Array<{ at: number; target: number }>;
}

interface Report extends Snapshot {
	/** Everything the engine emitted, so a splice can be checked for continuity. */
	played: Float32Array;
	/** Every quantum as the device receives it, so what a short one leaves behind is visible too. */
	rendered: Float32Array;
	/** Quanta that came back short of a full block. */
	shortQuanta: number;
	/** Whether `READ == output - concealed + stretched + queued + skipped` held on every quantum. */
	balanced: boolean;
	/** Whether the media playhead ever stepped backwards. */
	monotone: boolean;
	/** The engine's smoothed buffer level after every quantum, which is what it has learned. */
	levels: number[];
	/** How many timelines the ring handed the engine, told apart by generation. */
	timelines: number;
	/** The ring as each of the script's steps left it. */
	stepped: Snapshot[];
}

function run(build: Build, script: Script): Report {
	const harness = build(script.target);
	const engine = new Stretcher(RATE, 1, script.conceal ?? true);
	const out = [new Float32Array(QUANTUM)];

	// Every timeline the engine was shown, noted on its own reads: the shared ring's `view` applies
	// the skip-ahead, so reading it from here as well would change what the engine gets.
	const generations = new Set<number>();
	const ring = harness.buffer;
	const reader: RingReader = {
		rate: ring.rate,
		channels: ring.channels,
		view: () => {
			const view = ring.view();
			generations.add(view.generation);
			return view;
		},
		peek: (dst, count, offset) => ring.peek(dst, count, offset),
		commit: (count) => ring.commit(count),
		starve: () => ring.starve(),
		report: (counters) => ring.report(counters),
	};

	const quanta = Math.floor((RATE * script.seconds) / QUANTUM);
	const played = new Float32Array(quanta * QUANTUM);
	const rendered = new Float32Array(quanta * QUANTUM);
	const pace = script.pace ?? 1;
	const stallAt = script.stallAt === undefined ? undefined : Math.floor(quanta * script.stallAt);

	// Where the sender is on the media timeline, and how far the media it actually sent reaches:
	// the two differ by a hole, which is the part nobody can account for.
	let written = 0;
	let inserted = 0;
	while (written < ms(script.prefill)) {
		insert(harness, written, CHUNK);
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
	const levels: number[] = [];
	const stepped: Snapshot[] = [];

	for (let q = 0; q < quanta; q++) {
		// The surplus lands once the reader has taken a block, which is what makes it a surplus.
		if (q === 1 && script.burst) {
			for (let sent = 0; sent < ms(script.burst); sent += CHUNK) {
				insert(harness, written, CHUNK);
				written += CHUNK;
				inserted = written;
			}
		}

		while (outputFrame >= nextArrival) {
			// A hole is media that never arrives: the timeline keeps its place, so what lands after
			// it is the audio that follows the hole rather than the audio inside it.
			const missing = hole && written >= hole.from && written < hole.from + hole.frames;
			if (!missing) {
				insert(harness, written, CHUNK);
				inserted = written + CHUNK;
			}
			written += CHUNK;
			nextArrival += CHUNK / pace;
		}
		if (q === stallAt) harness.buffer.starve();
		for (const step of script.steps ?? []) {
			if (q !== Math.floor(quanta * step.at)) continue;
			harness.setLatency(step.target);
			stepped.push(harness.debug());
		}

		out[0].fill(0);
		const got = engine.render(reader, out, outputFrame);
		played.set(out[0].subarray(0, got), length);
		rendered.set(out[0], q * QUANTUM);
		length += got;
		if (got < QUANTUM) shortQuanta++;
		levels.push(engine.level);

		const debug = harness.debug();
		// What the ring handed over is what was played, less the frames that were made up rather
		// than read, plus what a stretch moved, plus what is still in flight, plus what a jump
		// passed over or the writer dropped. `inserted - buffered` is READ.
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
		rendered,
		shortQuanta,
		balanced,
		monotone,
		levels,
		timelines: generations.size,
		stepped,
	};
}

/** The first index at which two runs differ, or -1 when they are the same. */
function diverge(a: ArrayLike<number>, b: ArrayLike<number>): number {
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		if (a[i] !== b[i]) return i;
	}
	return -1;
}

describe.each(RINGS)("%s ring worklet", (name, build) => {
	it("converges from the top of the band without skipping or running dry", () => {
		// 180ms is inside the 195ms band (the target and the stretch bound) and well above the 140ms
		// upper limit an accelerate works down to. Past the band the reader jumps rather than
		// stretching, which is the next test. The ring is filled to what it holds and the rest lands
		// once playback has started. Everything here is a whole number of chunks, because a ring is
		// only ever a chunk at a time full.
		const report = run(build, { target: 120, prefill: 120, burst: 60, seconds: 6 });

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
		expect(report.buffered).toBeLessThanOrEqual(ms(120 + 20));
		// A chunk of slack below, because the ring is only refilled once per chunk.
		expect(report.buffered).toBeGreaterThanOrEqual(ms(100) - CHUNK);

		// Every splice landed on a pitch period, so the tone came out a tone.
		expect(zeroRun(report.played)).toBeLessThanOrEqual(2);
		expect(maxStep(report.played)).toBeLessThan(1.5 * SLOPE);
	});

	it("tracks a sender running slow instead of running dry", () => {
		// Two percent slow drains the ring in five seconds. An expansion consumes less media than it
		// emits, so the ring holds its depth instead.
		const report = run(build, { target: 120, prefill: 120, seconds: 10, pace: 0.98 });

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
		const inside = run(build, { target: 120, prefill: 120, burst: 60, seconds: 2 });
		expect(inside.skips).toBe(0);
		expect(inside.skipped + inside.discarded).toBe(0);

		// 300ms is well past the 195ms band, and past what an accelerate closes before the ring is
		// next looked at. The shared ring jumps its reader; the post ring's writer bounds it on the
		// way in, so the same audio is dropped a step earlier.
		const outside = run(build, { target: 120, prefill: 120, burst: 180, seconds: 2 });
		expect(outside.skipped + outside.discarded).toBeGreaterThan(0);
		expect(outside.balanced).toBe(true);
		expect(outside.monotone).toBe(true);
	});

	it("brings a fill deeper than the band back onto the level it holds", () => {
		// The unmute: the subscription restarts at the live edge and the relay follows it with every
		// cached group inside the age budget, so a backlog well past what the ring holds decodes
		// before the reader has taken a single block. Seconds of it stretched away would be seconds
		// of bent speech, so the part past the band is jumped and only the band is stretched.
		const report = run(build, { target: 120, prefill: 300, seconds: 4 });

		expect(report.underruns).toBe(0);
		expect(report.balanced).toBe(true);
		expect(report.monotone).toBe(true);
		expect(report.skipped + report.discarded).toBeGreaterThan(0);
		expect(report.buffered).toBeLessThanOrEqual(ms(120 + 20));
	});

	it("parks and resumes without losing the balance", () => {
		const script: Script = { target: 120, prefill: 120, seconds: 6, stallAt: 0.5 };
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
		const script: Script = { target: 120, prefill: 120, seconds: 6, hole: { at: 0.4, ms: 150 } };
		const report = run(build, script);

		console.log(
			`${name}: a 150ms hole left ${report.concealed} concealed samples over ${report.merges} merges, ${report.shortQuanta} short quanta and ${report.underruns} underruns`,
		);

		expect(report.balanced).toBe(true);
		expect(report.monotone).toBe(true);
		expect(report.concealed).toBeGreaterThan(ms(100));
		expect(report.merges).toBeGreaterThan(0);
		// Nothing reached the device short. The concealment fades out under the muting slope, so
		// the tail of a hole this long is digital silence rather than room tone, and the silence is
		// shorter than the hole it covers.
		expect(report.shortQuanta).toBe(0);
		expect(zeroRun(report.played)).toBeLessThan(ms(150));
		// The concealment is spliced on a pitch period at both ends, like every other operation.
		expect(maxStep(report.played)).toBeLessThan(1.5 * SLOPE);
	});

	it("ends an outage that never ends in digital silence", () => {
		// Ten seconds without a frame: the concealment fades under the muting slope until nothing is
		// left of it, so a stream that does not come back is not a sound.
		const report = run(build, { target: 120, prefill: 120, seconds: 12, hole: { at: 0.1, ms: 10_000 } });

		expect(report.balanced).toBe(true);
		expect(report.concealed).toBeGreaterThan(ms(200));
		// The outage runs from 1.2s to 11.2s, and the last of it is nothing at all.
		const tail = report.rendered.subarray(ms(6000), ms(10_000));
		expect(zeroRun(tail)).toBe(tail.length);
	});

	it("renders the same hole as a ramped gap with concealment off", () => {
		const report = run(build, {
			target: 120,
			prefill: 120,
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
		const script: Script = { target: 120, prefill: 180, seconds: 6 };
		const a = run(shared(RATE), script);
		const b = run(post(RATE), script);

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

describe("a target step", () => {
	// The postMessage ring sizes its storage from the target, so every step the estimator takes moves
	// its samples into an array of a new size. The shared ring's `setLatency` only stores the number,
	// which makes it the reference for what a step sounds like when nothing else changes.

	it("plays the same on both rings", () => {
		// 60ms to 40ms and back, each landing mid-tone. A fall is closed by accelerating, and a rise
		// parks the ring until it holds the deeper level.
		const script: Script = {
			target: 60,
			prefill: 60,
			seconds: 4,
			steps: [
				{ at: 0.375, target: 40 },
				{ at: 0.625, target: 60 },
			],
		};
		const a = run(shared(RATE), script);
		const b = run(post(RATE), script);

		// Nothing the reader held was dropped and nothing it learned was forgotten: the same audio,
		// under the same buffer level at every decision.
		expect(diverge(b.rendered, a.rendered)).toBe(-1);
		expect(diverge(b.levels, a.levels)).toBe(-1);
		expect(b.timelines).toBe(1);
		expect(b.balanced).toBe(true);
		expect(b.monotone).toBe(true);
		expect(maxStep(b.played)).toBeLessThan(1.5 * SLOPE);
	});

	// A late arrival runs the ring dry and raises the estimator's target, so the step lands while
	// concealment is covering the gap: before the media is back, or once the refill has started.
	it.each([
		["on the empty ring", 0.42, 0],
		["while the ring refills", 0.433, CHUNK],
	])("keeps concealing through a step that lands %s", (_, at, buffered) => {
		const script: Script = {
			target: 60,
			prefill: 60,
			seconds: 4,
			hole: { at: 0.4, ms: 100 },
			steps: [{ at, target: 80 }],
		};
		const a = run(shared(RATE), script);
		const b = run(post(RATE), script);

		expect(b.stepped[0].stalled).toBe(true);
		expect(b.stepped[0].underruns).toBe(1);
		expect(b.stepped[0].buffered).toBe(buffered);
		// The concealment runs until the media is back and is spliced onto it, rather than breaking
		// off into silence at the step.
		expect(b.shortQuanta).toBe(0);
		expect(b.merges).toBe(1);
		expect(diverge(b.rendered, a.rendered)).toBe(-1);
		expect(b.timelines).toBe(1);
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
				target: ms(120),
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
			// Copied, because the engine refills the one object it reports.
			this.reports.push({ ...counters });
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

describe.each(RINGS)("%s ring unmute", (name, build) => {
	it("resumes on the level it holds without bending the backlog for long", () => {
		// A viewer muting for three seconds and unmuting. The mute flushes the decoder's ring; the
		// resubscription is served the live edge and the relay follows it with the groups it still had
		// cached inside the age budget, so a backlog past the 120ms the ring holds is decoded before
		// the reader takes its next block. What is inside the band is stretched away over a moment,
		// and the playhead never steps back while it is.
		const harness = build(120);
		const engine = new Stretcher(RATE, 1, true);
		const out = [new Float32Array(QUANTUM)];
		const HOLD = ms(120);
		const BACKLOG = ms(180);

		let written = 0;
		let outputFrame = 0;
		let nextArrival = 0;

		// Fill to what the ring holds, then play for a second with the sender in step.
		const play = (quanta: number, arriving: boolean) => {
			for (let q = 0; q < quanta; q++) {
				while (arriving && outputFrame >= nextArrival) {
					insert(harness, written, CHUNK);
					written += CHUNK;
					nextArrival += CHUNK;
				}
				engine.render(harness.buffer, out, outputFrame);
				outputFrame += QUANTUM;
			}
		};

		while (written < HOLD) {
			insert(harness, written, CHUNK);
			written += CHUNK;
			nextArrival = written;
		}
		play(Math.floor(RATE / QUANTUM), true);

		const before = harness.debug();
		expect(before.underruns).toBe(0);

		// The mute: the ring is flushed and nothing is downloaded for three seconds, but the publisher
		// keeps producing, so the timeline moves on without us.
		harness.buffer.reset();
		play(Math.floor((3 * RATE) / QUANTUM), false);
		written += 3 * RATE;
		nextArrival = outputFrame;

		// The unmute: the backlog lands in one go, before the next block is pulled.
		for (let sent = BACKLOG; sent > 0; sent -= CHUNK) {
			insert(harness, written - sent, CHUNK);
		}
		nextArrival += CHUNK;

		expect(harness.debug().buffered).toBe(BACKLOG);

		// Three seconds of playback after it, which is the window a listener hears the catch-up in.
		let playhead = Number.NEGATIVE_INFINITY;
		let monotone = true;
		for (let q = 0; q < Math.floor((3 * RATE) / QUANTUM); q++) {
			while (outputFrame >= nextArrival) {
				insert(harness, written, CHUNK);
				written += CHUNK;
				nextArrival += CHUNK;
			}
			engine.render(harness.buffer, out, outputFrame);
			outputFrame += QUANTUM;

			const position = harness.buffer.timestamp;
			if (position < playhead) monotone = false;
			playhead = position;
		}

		const after = harness.debug();
		console.log(
			`${name}: the unmute stretched ${(1000 * (after.stretched - before.stretched)) / RATE}ms over ${after.accelerates - before.accelerates} accelerates`,
		);

		// What was past the target was compressed back, a bounded number of times, and nothing ran dry.
		expect(after.accelerates - before.accelerates).toBeGreaterThan(0);
		expect(after.accelerates - before.accelerates).toBeLessThan(20);
		expect(after.underruns - before.underruns).toBe(0);
		expect(after.buffered).toBeLessThanOrEqual(ms(120 + 20));
		expect(monotone).toBe(true);
	});
});

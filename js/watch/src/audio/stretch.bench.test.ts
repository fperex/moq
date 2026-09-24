import { expect, it } from "bun:test";
import { type Counters, frames, type RingReader, type RingView, STRETCH_BOUND, Stretcher } from "./playout";
import { tone } from "./playout/fixture";

// What one `process()` call costs on the audio thread, which is the only budget the AudioWorklet
// actually enforces: a render quantum is 2.67ms of wall time at 48kHz, and overrunning it is a
// dropout whatever the buffer holds.
//
// The ring is stubbed rather than driven, so the level the decision sees is fixed and the engine
// runs one operation per cooldown for the whole minute. That is far more stretching than any real
// stream asks for, which is the point: it is the ceiling, not the average.

const RATE = 48000;
const QUANTUM = 128;
const CHUNK = frames(RATE, 20);
const SECONDS = 60;

/** Milliseconds of output run before the stopwatch starts. */
const WARMUP = 5000;

/** A quarter of a 48kHz render quantum, so three quarters are left for everything else in the graph. */
const BUDGET = 0.67;

/** A minute of tone, long enough that the stub never repeats a window into the correlation search. */
const SOURCE = tone(RATE, 2, 220, 0.5)[0];

/** A ring that always reports the same depth, so the decision is the harness's to choose. */
class Fixed implements RingReader {
	readonly rate = RATE;
	readonly channels = 1;
	readonly #depth: number;
	// How many blocks out of every `#cycle` the ring is empty for, or zero to never run dry. A
	// short cycle forces a concealment run and the merge that ends it over and over.
	readonly #outage: number;
	readonly #cycle: number;
	#at = 0;
	// Blocks the engine has asked for, which is what the outage is counted in: the engine looks at
	// the ring once per block it produces.
	#asked = 0;

	constructor(depthMs: number, outage = 0, cycle = 0) {
		this.#depth = frames(RATE, depthMs);
		this.#outage = outage;
		this.#cycle = cycle;
	}

	view(): RingView {
		const dry = this.#cycle > 0 && this.#asked % this.#cycle < this.#outage;
		this.#asked++;

		return {
			buffered: dry ? 0 : this.#depth,
			target: frames(RATE, 100),
			chunk: CHUNK,
			skip: frames(RATE, STRETCH_BOUND),
			stalled: false,
			ended: false,
			unstable: false,
			converge: true,
			skipped: 0,
			generation: 1,
		};
	}

	peek(dst: Float32Array[], count: number, offset = 0): void {
		const start = this.#at % (SOURCE.length - count);
		dst[0].set(SOURCE.subarray(start, start + count), offset);
	}

	commit(count: number): boolean {
		this.#at += count;
		return true;
	}

	starve(): void {}

	report(_counters: Counters): void {}
}

interface Timing {
	p50: number;
	p95: number;
	p999: number;
	over: number;
	max: number;
	operations: number;
}

function measure(depthMs: number, outage = 0, cycle = 0): Timing {
	const ring = new Fixed(depthMs, outage, cycle);
	const engine = new Stretcher(RATE, 1);
	const out = [new Float32Array(QUANTUM)];
	const quanta = Math.floor((RATE * SECONDS) / QUANTUM);
	const samples = new Float64Array(quanta);

	// A few seconds of quanta before the stopwatch starts, so the figure is the steady state rather
	// than the engine's first pass through a just-in-time compiler. A worklet pays that once, at a
	// point where the ring is still filling.
	let frame = 0;
	for (let q = 0; q < frames(RATE, WARMUP) / QUANTUM; q++) {
		engine.render(ring, out, frame);
		frame += QUANTUM;
	}

	for (let q = 0; q < quanta; q++) {
		const started = performance.now();
		engine.render(ring, out, frame);
		samples[q] = performance.now() - started;
		frame += QUANTUM;
	}

	const counters = engine.counters();
	samples.sort();
	return {
		p50: samples[Math.floor(quanta * 0.5)],
		p95: samples[Math.floor(quanta * 0.95)],
		p999: samples[Math.floor(quanta * 0.999)],
		over: samples.reduce((n, v) => (v > 0.67 ? n + 1 : n), 0),
		max: samples[quanta - 1],
		operations: counters.accelerates + counters.expands + counters.merges,
	};
}

it("renders a quantum well inside its budget, stretching or not", () => {
	// 400ms against a 100ms target is past the upper limit however the filter smooths it, so the
	// engine accelerates on every cooldown for the whole minute.
	const stretching = measure(400);
	// Inside the band, so the engine copies the media through and nothing else.
	const normal = measure(120);
	// Three blocks of concealment out of every four, so the minute is one long alternation of
	// analysing a signal, expanding it, and splicing the media back on.
	const concealing = measure(120, 3, 4);

	const show = (name: string, timing: Timing) =>
		`${name}: p50 ${timing.p50.toFixed(4)}ms, p95 ${timing.p95.toFixed(4)}ms, p999 ${timing.p999.toFixed(4)}ms, max ${timing.max.toFixed(4)}ms, ${timing.over} over budget, ${timing.operations} operations`;
	console.log(show("stretching", stretching));
	console.log(show("normal", normal));
	console.log(show("concealing", concealing));

	// One operation per 100ms cooldown over a minute.
	expect(stretching.operations).toBeGreaterThan(500);
	expect(normal.operations).toBe(0);

	// The budget is held at the thousandth percentile rather than at the maximum. A `bun` process
	// pauses for the garbage collector and for the operating system in ways an audio thread does
	// not, and those pauses are tens of milliseconds: the plain run, which does nothing but copy,
	// shows the same handful of them. `max` is printed so a real regression is still visible.
	expect(stretching.p999).toBeLessThan(BUDGET);

	// And concealment, which is a pitch search, a sixth order fit, and a splice per outage.
	expect(concealing.operations).toBeGreaterThan(500);
	expect(concealing.p999).toBeLessThan(BUDGET);
}, 120_000);

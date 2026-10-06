/**
 * What one `process()` call costs on the audio thread, which is the only budget the AudioWorklet
 * actually enforces: a render quantum is 2.67ms of wall time at 48kHz, and overrunning it is a
 * dropout whatever the buffer holds.
 *
 * The ring is stubbed rather than driven, so the level the decision sees is fixed and the engine
 * runs one operation per cooldown for the whole minute. That is far more stretching than any real
 * stream asks for, which is the point: it is the ceiling, not the average.
 *
 * `just js stretch-bench` prints the percentiles against a quarter of a quantum. It asserts nothing
 * about time; `src/audio/playout/stretch.test.ts` holds the operation counts.
 */
import { frames, Stretcher } from "../src/audio/playout";
import { FixedRing, tone } from "../src/audio/playout/fixture";

const RATE = 48000;
const QUANTUM = 128;
const SECONDS = 60;

/** Milliseconds of output run before the stopwatch starts. */
const WARMUP = 5000;

/** A quarter of a 48kHz render quantum, so three quarters are left for everything else in the graph. */
const BUDGET = 0.67;

const SOURCE = tone(RATE, 2, 220, 0.5)[0];

function measure(name: string, depthMs: number, outage = 0, cycle = 0): void {
	const ring = new FixedRing(RATE, SOURCE, depthMs, outage, cycle);
	const engine = new Stretcher(RATE, 1);
	const out = [new Float32Array(QUANTUM)];
	const quanta = Math.floor((RATE * SECONDS) / QUANTUM);
	const samples = new Float64Array(quanta);

	// The steady state rather than the engine's first pass through a just-in-time compiler, which a
	// worklet pays once, while the ring is still filling.
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

	const { accelerates, expands, merges } = engine.counters();
	samples.sort();
	const at = (p: number) => samples[Math.floor(quanta * p)].toFixed(4);
	const over = samples.reduce((n, v) => (v > BUDGET ? n + 1 : n), 0);
	console.log(
		`${name}: p50 ${at(0.5)}ms, p95 ${at(0.95)}ms, p999 ${at(0.999)}ms, max ${samples[quanta - 1].toFixed(4)}ms, ${over} over budget, ${accelerates + expands + merges} operations`,
	);
}

// 400ms against a 120ms target: the engine accelerates on every cooldown for the whole minute.
measure("stretching", 400);
// Inside the band, so the engine copies the media through and nothing else.
measure("normal", 120);
// Three blocks of concealment out of every four: analysing, expanding, and splicing the media back on.
measure("concealing", 120, 3, 4);

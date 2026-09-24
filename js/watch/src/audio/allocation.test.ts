import { fullGC, heapStats } from "bun:jsc";
import { expect, it } from "bun:test";
import { Time } from "@moq/net";
import { frames, Stretcher } from "./playout";
import { speech } from "./playout/fixture";
import { AudioRingBuffer } from "./ring-buffer";

// What the audio thread leaves for its garbage collector: the playout engine and the postMessage
// ring, which the worklet owns both ends of. A collection there is a pause inside a 2.67ms render
// quantum, so the steady state allocates nothing at all.
//
// Counted with JavaScriptCore's per-type object counts, which include garbage the collector has not
// reached yet. A collection inside the window can only hide objects, so this can miss a regression
// but never invent one. It cannot see V8 boxing a double, which is what a for-of over a typed array
// costs there, because JavaScriptCore never boxes one.

const RATE = 48000;
const QUANTUM = 128;
const CHANNELS = 2;
const CHUNK = frames(RATE, 20);
const SOURCE = speech(RATE, 4, 180, 0.5, 0.003, CHANNELS);

/** Quanta run before counting, enough for every function on the path to reach the optimizing compiler. */
const WARMUP = 30_000;

/** Quanta counted. */
const WINDOW = 2_000;

/** Objects of each type `run` left on the heap, net of what counting them costs. */
function growth(run: () => void): Record<string, number> {
	fullGC();
	const before = heapStats().objectTypeCounts;
	const counted = heapStats().objectTypeCounts;
	run();
	const after = heapStats().objectTypeCounts;

	// Each count allocates its own result, so the second one costs what the first did.
	const grown: Record<string, number> = {};
	for (const type of new Set([...Object.keys(before), ...Object.keys(after)])) {
		grown[type] = (after[type] ?? 0) - 2 * (counted[type] ?? 0) + (before[type] ?? 0);
	}
	return grown;
}

/**
 * The worklet's loop on a simulated clock: a stereo sender at `pace` of real time whose last
 * `outage` chunks of every hundred never arrive, the engine pulling a quantum at a time, and the
 * playhead and counters read every fifth quantum the way the state message reads them.
 */
function worklet(pace: number, outage: number): { run(quanta: number): void; engine: Stretcher } {
	const ring = new AudioRingBuffer({ rate: RATE, channels: CHANNELS, latency: Time.Milli(60) });
	const engine = new Stretcher(RATE, CHANNELS);
	const out = Array.from({ length: CHANNELS }, () => new Float32Array(QUANTUM));

	// Built up front: what the main thread posts is decoded before the audio thread sees it.
	const chunks = Array.from({ length: 64 }, (_, index) => {
		const start = (index * CHUNK) % (SOURCE[0].length - CHUNK);
		return SOURCE.map((plane) => plane.slice(start, start + CHUNK));
	});

	let written = 0;
	let arrival = 0;
	let frame = 0;
	let quantum = 0;
	const run = (quanta: number) => {
		for (let q = 0; q < quanta; q++) {
			while (frame >= arrival) {
				if ((written / CHUNK) % 100 < 100 - outage) {
					const timestamp = Time.Micro.fromSecond((written / RATE) as Time.Second);
					ring.write(timestamp, chunks[(written / CHUNK) % chunks.length]);
				}
				written += CHUNK;
				arrival += CHUNK / pace;
			}
			engine.render(ring, out, frame);
			frame += QUANTUM;
			if (++quantum % 5 === 0) {
				void ring.playhead;
				ring.debug();
			}
		}
	};
	return { run, engine };
}

it("plays a steady stream without allocating", () => {
	const { run, engine } = worklet(1, 0);
	run(WARMUP);

	const { output } = engine.counters();
	const grown = growth(() => run(WINDOW));
	// Every quantum played in full, so the window is the path a healthy stream takes.
	expect(engine.counters().output - output).toBe(WINDOW * QUANTUM);

	expect({ objects: grown.Object ?? 0, views: grown.Float32Array ?? 0, searches: grown.Float64Array ?? 0 }).toEqual({
		objects: 0,
		views: 0,
		searches: 0,
	});
});

it("stretches and conceals without allocating objects or correlations", () => {
	// Three percent slow, so the engine expands on every cooldown, and 120ms lost every two seconds,
	// which runs the ring dry, so it conceals and splices the media back on as well. The splice still
	// copies through views, which this does not count.
	const { run, engine } = worklet(0.97, 6);
	run(WARMUP);

	const { expands, merges } = engine.counters();
	const grown = growth(() => run(WINDOW));
	expect(engine.counters().expands).toBeGreaterThan(expands);
	expect(engine.counters().merges).toBeGreaterThan(merges);

	expect({ objects: grown.Object ?? 0, searches: grown.Float64Array ?? 0 }).toEqual({ objects: 0, searches: 0 });
});

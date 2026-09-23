import { describe, expect, it } from "bun:test";
import * as Container from "@moq/hang/container";
import { Time } from "@moq/net";
import { WORKLET_QUANTUM } from "./config";
import type { Snapshot } from "./playout";
import { Starvation } from "./starvation";

const RATE = 48000;

/** Milliseconds as samples at the ring's rate. */
function ms(value: number): number {
	return (RATE * value) / 1000;
}

/** A ring playing along on a 40ms level, with whatever a case changes. */
function snapshot(fields: Partial<Snapshot> = {}): Snapshot {
	return {
		buffered: ms(40),
		target: ms(20),
		chunk: ms(20),
		skip: ms(75),
		stalled: false,
		underruns: 0,
		skips: 0,
		skipped: 0,
		discarded: 0,
		trimmed: 0,
		fresh: false,
		anchor: 0,
		queued: 0,
		stretched: 0,
		output: ms(10_000),
		concealed: 0,
		accelerates: 0,
		expands: 0,
		merges: 0,
		short: 0,
		...fields,
	};
}

// Reads a second or so after the estimate settled, so every report lands on the same clock.
const NOW = Time.Milli(11_000);

/**
 * An estimate settled on one bucket, which is what a clean path leaves it at, that has just read a
 * frame out of a page block: the only kind of run-dry it takes a report of.
 */
function settled(): Container.Jitter {
	const jitter = new Container.Jitter();
	for (let i = 0; i < 500; i++) jitter.observe(Time.Micro.fromMilli(Time.Milli(i * 20)), Time.Milli(i * 20 + 50));
	jitter.observe(Time.Micro.fromMilli(Time.Milli(10_000)), Time.Milli(NOW - 10), { stalled: true });
	expect(jitter.value.peek()).toBe(Container.Jitter.BUCKET as Time.Milli);
	return jitter;
}

describe("a ring that runs dry", () => {
	it("is reported as soon as a read shows it", () => {
		const jitter = settled();
		const watch = new Starvation(RATE);
		watch.update(snapshot(), jitter, NOW);

		// The main thread comes back from a freeze to a ring that has been dry for 82ms.
		watch.update(snapshot({ underruns: 1, stalled: true, buffered: 0, concealed: ms(82) }), jitter, NOW);
		expect(jitter.value.peek()).toBe(120 as Time.Milli);
	});

	it("is reported at every read while it lasts, without adding its own reports up", () => {
		const jitter = settled();
		const watch = new Starvation(RATE);
		watch.update(snapshot(), jitter, NOW);

		// The first read after the freeze was composed 40ms into it, the next once it had run 82ms:
		// the second asks only for what the first did not cover.
		watch.update(snapshot({ underruns: 1, stalled: true, buffered: 0, concealed: ms(40) }), jitter, NOW);
		expect(jitter.value.peek()).toBe(60 as Time.Milli);
		watch.update(snapshot({ underruns: 1, stalled: true, buffered: 0, concealed: ms(82) }), jitter, NOW);
		expect(jitter.value.peek()).toBe(120 as Time.Milli);
	});

	it("stops counting once media is back, whatever the refill waits for after", () => {
		const jitter = settled();
		const watch = new Starvation(RATE);
		watch.update(snapshot(), jitter, NOW);

		watch.update(snapshot({ underruns: 1, stalled: true, buffered: 0, concealed: ms(60) }), jitter, NOW);
		expect(jitter.value.peek()).toBe(80 as Time.Milli);

		// Media is back but the ring is still refilling to the level the report raised. That wait is
		// the report's own doing, so it is not what the player ran out of.
		watch.update(snapshot({ underruns: 1, stalled: true, buffered: ms(20), concealed: ms(65) }), jitter, NOW);
		expect(jitter.value.peek()).toBe(100 as Time.Milli);
		watch.update(snapshot({ underruns: 1, stalled: true, buffered: ms(60), concealed: ms(105) }), jitter, NOW);
		watch.update(snapshot({ underruns: 1, stalled: false, buffered: ms(100), concealed: ms(125) }), jitter, NOW);
		expect(jitter.value.peek()).toBe(100 as Time.Milli);
	});

	it("counts the quanta that went out short when nothing covered them", () => {
		// Concealment off, or not ready yet: the reader renders silence and counts short quanta.
		const jitter = settled();
		const watch = new Starvation(RATE);
		watch.update(snapshot({ short: 4 }), jitter, NOW);

		const quanta = Math.ceil(ms(80) / WORKLET_QUANTUM);
		watch.update(snapshot({ underruns: 1, stalled: true, buffered: 0, short: 4 + quanta }), jitter, NOW);
		expect(jitter.value.peek()).toBe(
			Time.Milli(Math.ceil((20 + (quanta * WORKLET_QUANTUM * 1000) / RATE) / 20) * 20),
		);
	});

	it("starts a second report from the target the first one raised", () => {
		// A later run-dry at the raised target: covering it takes that target and the new gap.
		const jitter = settled();
		const watch = new Starvation(RATE);
		watch.update(snapshot(), jitter, NOW);
		watch.update(snapshot({ underruns: 1, stalled: false, concealed: ms(82) }), jitter, NOW);
		expect(jitter.value.peek()).toBe(120 as Time.Milli);

		watch.update(snapshot({ underruns: 1, stalled: false, concealed: ms(90) }), jitter, NOW);
		watch.update(snapshot({ underruns: 2, stalled: false, concealed: ms(95) }), jitter, NOW);
		expect(jitter.value.peek()).toBe(140 as Time.Milli);
	});
});

describe("what is not a ring running dry", () => {
	it("a first read, which only says where the counters start", () => {
		const jitter = settled();
		const watch = new Starvation(RATE);
		watch.update(snapshot({ underruns: 5, stalled: true, buffered: 0, concealed: ms(500) }), jitter, NOW);
		expect(jitter.value.peek()).toBe(Container.Jitter.BUCKET as Time.Milli);
	});

	it("a fresh timeline, which is filling", () => {
		const jitter = settled();
		const watch = new Starvation(RATE);
		watch.update(snapshot(), jitter, NOW);
		watch.update(
			snapshot({ underruns: 1, fresh: true, stalled: true, buffered: 0, concealed: ms(82) }),
			jitter,
			NOW,
		);
		expect(jitter.value.peek()).toBe(Container.Jitter.BUCKET as Time.Milli);
	});

	it("a flush under a run-dry, which ends it without another report", () => {
		const jitter = settled();
		const watch = new Starvation(RATE);
		watch.update(snapshot(), jitter, NOW);
		watch.update(snapshot({ underruns: 1, stalled: true, buffered: 0, concealed: ms(40) }), jitter, NOW);
		expect(jitter.value.peek()).toBe(60 as Time.Milli);

		// A mute flushes the ring; what the reader then waits for is the next timeline's fill.
		watch.update(
			snapshot({ underruns: 1, fresh: true, stalled: true, buffered: 0, concealed: ms(200) }),
			jitter,
			NOW,
		);
		watch.update(snapshot({ underruns: 1, stalled: false, buffered: ms(40), concealed: ms(400) }), jitter, NOW);
		expect(jitter.value.peek()).toBe(60 as Time.Milli);
	});

	it("a timeline replaced under a run-dry between two reads", () => {
		const jitter = settled();
		const watch = new Starvation(RATE);
		watch.update(snapshot(), jitter, NOW);
		watch.update(snapshot({ underruns: 1, stalled: true, buffered: 0, concealed: ms(40) }), jitter, NOW);

		// Flushed and filled again from a new anchor before the next read saw it fresh.
		watch.update(snapshot({ underruns: 1, anchor: ms(60_000), stalled: false, concealed: ms(400) }), jitter, NOW);
		expect(jitter.value.peek()).toBe(60 as Time.Milli);
	});

	it("a read with no estimate to report to, which still moves the counters on", () => {
		const jitter = settled();
		const watch = new Starvation(RATE);
		watch.update(snapshot(), jitter, NOW);
		watch.update(snapshot({ underruns: 1, stalled: true, buffered: 0, concealed: ms(82) }), undefined, NOW);
		watch.update(snapshot({ underruns: 1, stalled: true, buffered: 0, concealed: ms(90) }), jitter, NOW);
		expect(jitter.value.peek()).toBe(Container.Jitter.BUCKET as Time.Milli);
	});
});

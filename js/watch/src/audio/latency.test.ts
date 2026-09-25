import { describe, expect, it } from "bun:test";
import type { Time } from "@moq/net";
import { LOWER_INTERVAL, nextLatency, ringSamples } from "./latency";

const ms = (value: number) => value as Time.Milli;

describe("ringSamples", () => {
	// `delay="instant"` reports a zero buffer. Passed through, the ring rejects it and the
	// worklet is left with no backend that any later resize can revive.
	it("floors a zero delay at one render quantum", () => {
		expect(ringSamples(48_000, ms(0))).toBe(128);
	});

	it("floors a delay too short to fill a quantum", () => {
		// 1ms at 48kHz is 48 samples.
		expect(ringSamples(48_000, ms(1))).toBe(128);
	});

	it("leaves a delay above the floor alone", () => {
		expect(ringSamples(48_000, ms(100))).toBe(4_800);
	});
});

describe("nextLatency", () => {
	// The cold start a browser publisher gives every viewer: nothing is declared, so the estimator
	// holds an 80ms guess until its first measurement, which lands at 20ms. Spent at once, the ring
	// time-compresses 60ms of speech inside half a second, which is the fast-forward heard in the
	// first seconds of a self-publish.
	it("sheds a cold-start seed one bucket at a time", () => {
		expect(nextLatency(ms(80), ms(20), LOWER_INTERVAL)).toBe(ms(60));
		expect(nextLatency(ms(60), ms(20), LOWER_INTERVAL)).toBe(ms(40));
		expect(nextLatency(ms(40), ms(20), LOWER_INTERVAL)).toBe(ms(20));
	});

	it("holds a depth for the interval before shedding any of it", () => {
		expect(nextLatency(ms(80), ms(20), ms(0))).toBe(ms(80));
		expect(nextLatency(ms(80), ms(20), ms(999))).toBe(ms(80));
	});

	// A rise is a cushion the ring parks once to refill. Walking it would only lengthen the shallow
	// window an underrun is waiting in.
	it("lands a rise at once", () => {
		expect(nextLatency(ms(20), ms(200), LOWER_INTERVAL)).toBe(ms(200));
		expect(nextLatency(ms(20), ms(40), ms(0))).toBe(ms(40));
	});

	// Past the reader's stretch bound it skips ahead instead of stretching, which is one
	// discontinuity. Walking a viewer's 2s delay down to 100ms would turn that into a minute of
	// bent audio.
	it("lands a fall the reader would skip rather than stretch at once", () => {
		expect(nextLatency(ms(2_000), ms(100), ms(0))).toBe(ms(100));
	});

	it("leaves a target it already holds alone", () => {
		expect(nextLatency(ms(40), ms(40), LOWER_INTERVAL)).toBe(ms(40));
	});
});

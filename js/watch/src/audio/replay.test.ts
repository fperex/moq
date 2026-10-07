import { afterEach, beforeEach, describe, expect, it, type Mock, spyOn } from "bun:test";
import type * as Catalog from "@moq/hang/catalog";
import { Time } from "@moq/net";
import type { Counters } from "./playout";
import { type Arrival, type Options, QUANTUM, replay } from "./replay";

const RATE = 48000;
const CONFIG = { codec: "opus", sampleRate: RATE, numberOfChannels: 1 } as Catalog.AudioConfig;

/** Twenty ms frames for `seconds`, one per group, each arriving `lateness(i)` ms after it was captured. */
function paced(seconds: number, lateness: (i: number) => number): Arrival[] {
	return Array.from({ length: seconds * 50 }, (_, i) => ({ at: i * 20 + lateness(i), timestamp: i * 20, group: i }));
}

/** How long {@link paced} observes `seconds` of frames: the frames, plus one more. */
const observed = (seconds: number) => seconds * 1000 + 20;

/**
 * Quanta that came back short or empty once the ring had first played. A ring that runs dry
 * re-stalls until it refills, and that refill is silence too.
 */
async function underruns(trace: Arrival[], options: Options): Promise<number> {
	let started = false;
	let short = 0;
	for await (const { output } of replay(trace, options)) {
		const filled = output.findLastIndex((v) => v !== 0) + 1;
		if (started && filled < QUANTUM) short++;
		if (filled > 0) started = true;
	}
	return short;
}

/**
 * What the engine did with a trace: the quanta that came back short, as {@link underruns} counts them,
 * and the counters it ended on.
 */
async function played(trace: Arrival[], options: Options): Promise<{ short: number; counters: Counters }> {
	let started = false;
	let short = 0;
	let counters: Counters | undefined;
	for await (const quantum of replay(trace, options)) {
		const filled = quantum.output.findLastIndex((v) => v !== 0) + 1;
		if (started && filled < QUANTUM) short++;
		if (filled > 0) started = true;
		counters = { ...quantum.counters };
	}
	if (!counters) throw new Error("the replay rendered nothing");
	return { short, counters };
}

describe.each(["shared", "post"] as const)("%s ring", (ring) => {
	// The consumer warns on every group it skips.
	let warn: Mock<typeof console.warn>;
	beforeEach(() => {
		warn = spyOn(console, "warn").mockImplementation(() => {});
	});
	afterEach(() => warn.mockRestore());

	it("plays an evenly paced sender without a gap", async () => {
		expect(
			await underruns(
				paced(10, () => 30),
				{ ring, rate: RATE, config: CONFIG, delay: Time.Milli(100), duration: observed(10) },
			),
		).toBe(0);
	});

	// The ring on its own, without the synthesized audio a page covers a gap with: what a listener who
	// turned `conceal` off hears.
	it("underruns when a flush span outlasts the target, and not when it is covered", async () => {
		// Five frames held and flushed at once: 80 ms of arrival spread.
		const trace = paced(10, (i) => 30 + (4 - (i % 5)) * 20);
		const options = { ring, rate: RATE, config: CONFIG, conceal: false, duration: observed(10) };
		expect(await underruns(trace, { ...options, delay: Time.Milli(40) })).toBeGreaterThan(50);
		expect(await underruns(trace, { ...options, delay: Time.Milli(150) })).toBe(0);
	});

	it("covers the gaps a short target leaves with synthesized audio, and plays through them", async () => {
		const trace = paced(10, (i) => 30 + (4 - (i % 5)) * 20);
		const options = { ring, rate: RATE, config: CONFIG, delay: Time.Milli(40), duration: observed(10) };
		const control = await played(trace, { ...options, conceal: false });
		const concealed = await played(trace, options);

		// The same ring runs dry, and a listener hears a short quantum for each of the control's. With
		// concealment on, the engine fills them: almost none reach the device short, and what covered
		// them is counted.
		expect(control.counters.concealed).toBe(0);
		expect(control.short).toBeGreaterThan(50);
		expect(concealed.counters.concealed).toBeGreaterThan(0);
		expect(concealed.short).toBeLessThan(control.short / 5);
	});

	it("holds newer groups behind a missing one until the max age gives up on it", async () => {
		const trace = paced(10, () => 30).filter((arrival) => arrival.group !== 250);
		// The consumer delivers in group order, so the ring runs dry for longer than the missing frame
		// while the groups behind it wait. Writing arrivals straight into the ring plays straight through.
		const frame = Math.ceil((20 / 1000) * (RATE / QUANTUM));
		const options = { ring, rate: RATE, config: CONFIG, delay: Time.Milli(100), duration: observed(10) };
		expect(await underruns(trace, { ...options, conceal: false })).toBeGreaterThan(frame);
		expect(warn).toHaveBeenCalled();

		// With concealment the page covers what the groups behind it wait for.
		expect((await played(trace, options)).counters.concealed).toBeGreaterThan(0);
	});

	it("leaves a frame missing inside a group as missing audio", async () => {
		// Five frames a group, delivered on time, with one from the middle of a group never sent.
		const trace = paced(10, () => 30)
			.map((arrival, i) => ({ ...arrival, group: Math.floor(i / 5) }))
			.filter((_, i) => i !== 252);
		expect(
			await underruns(trace, {
				ring,
				rate: RATE,
				config: CONFIG,
				delay: Time.Milli(100),
				duration: observed(10),
			}),
		).toBeGreaterThan(0);
	});

	it("renders through the end of the observation, past the last arrival", async () => {
		let last = 0;
		let heard = 0;
		for await (const { at, output } of replay(
			paced(10, () => 30),
			{
				ring,
				rate: RATE,
				config: CONFIG,
				delay: Time.Milli(100),
				duration: 15_000,
			},
		)) {
			last = at;
			if (at > 11_000 && output.some((v) => v !== 0)) heard++;
		}
		expect(last).toBeGreaterThanOrEqual(15_000);
		expect(heard).toBe(0);
	});
});

describe.each(["shared", "post"] as const)("%s ring at auto", (ring) => {
	/** The delay the replay resolved once `seconds` of {@link paced} frames played out. */
	async function settled(seconds: number, lateness: (i: number) => number): Promise<number> {
		let delay = 0;
		const options: Options = { ring, rate: RATE, config: CONFIG, delay: "auto", duration: observed(seconds) };
		for await (const quantum of replay(paced(seconds, lateness), options)) delay = quantum.delay;
		return delay;
	}

	// A minute, so the estimator's startup ramp hands over to its steady forget factor.
	it("sizes the target from the arrival spread, not a round trip", async () => {
		// Evenly paced, the target is the estimator's 20 ms floor plus one frame.
		expect(await settled(60, () => 30)).toBe(40);
		// Five frames flushed at once: 80 ms of spread to cover, plus one frame.
		expect(await settled(60, (i) => 30 + (4 - (i % 5)) * 20)).toBeGreaterThanOrEqual(100);
	});
});

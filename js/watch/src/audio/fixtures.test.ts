import { afterEach, beforeEach, describe, expect, it, type Mock, spyOn } from "bun:test";
import type * as Catalog from "@moq/hang/catalog";
import fourKWebm from "./fixtures/4k-webm.json" with { type: "json" };
import lanBbb from "./fixtures/lan-bbb.json" with { type: "json" };
import micFirefox from "./fixtures/mic-firefox.json" with { type: "json" };
import micLocal from "./fixtures/mic-local.json" with { type: "json" };
import micLocalMute from "./fixtures/mic-local-mute.json" with { type: "json" };
import micRemote from "./fixtures/mic-remote.json" with { type: "json" };
import relayBbb7Frame from "./fixtures/relay-bbb-7frame.json" with { type: "json" };
import type { Counters } from "./playout";
import { type Arrival, type Fixture, QUANTUM, recorded, replay } from "./replay";

// Recorded arrival traces, replayed through the real container consumer, estimator, rings and playout
// engine on a simulated clock, with what a listener would have heard counted at the output.
//
// A fixture is arrival timing only: when each frame reached the receiver, and its media timestamp.
// The ceilings are what the replay measured: it is deterministic, so any change that
// moves one fails here, and an improvement is tightened in.

const OPUS = { codec: "opus", sampleRate: 48_000, numberOfChannels: 1 } as Catalog.AudioConfig;
const AAC = { codec: "mp4a.40.2", sampleRate: 44_100, numberOfChannels: 2 } as unknown as Catalog.AudioConfig;

/** What a listener heard, counted after the warmup the lane discards too. */
interface Heard {
	/** Quanta that came back short of a full block once playing. */
	short: number;
	/** Quanta that were digital silence once playing. */
	silent: number;
	/** What the engine did, cumulative. */
	counters: Counters;
	/** The delay the replay resolved by the end of the trace, in ms. */
	delay: number;
}

const WARMUP = 5_000;

async function hear(trace: Arrival[], ring: "shared" | "post", config: Catalog.AudioConfig, conceal: boolean) {
	let started = false;
	const heard: Heard = { short: 0, silent: 0, counters: undefined as unknown as Counters, delay: 0 };
	const duration = trace[trace.length - 1].at + 20;
	for await (const quantum of replay(trace, {
		ring,
		rate: config.sampleRate,
		config,
		delay: "auto",
		conceal,
		duration,
	})) {
		const filled = quantum.output.findLastIndex((v) => v !== 0) + 1;
		if (quantum.at >= WARMUP) {
			if (started && filled < QUANTUM) heard.short++;
			if (started && filled === 0) heard.silent++;
		}
		if (filled > 0) started = true;
		heard.counters = { ...quantum.counters };
		heard.delay = quantum.delay;
	}
	return heard;
}

/** The ceilings one fixture is graded against, with concealment on. */
interface Budget {
	short: number;
	silent: number;
	/** What concealment may not have covered: the control's short quanta, which only a gap leaves. */
	control: number;
	delay: number;
}

const FIXTURES: Array<[string, Fixture, Catalog.AudioConfig, Budget]> = [
	["4k-webm", fourKWebm, OPUS, { short: 67, silent: 65, control: 142, delay: 200 }],
	["lan-bbb", lanBbb, AAC, { short: 0, silent: 0, control: 12, delay: 103.3 }],
	["mic-firefox", micFirefox, OPUS, { short: 830, silent: 828, control: 920, delay: 1620 }],
	["mic-local", micLocal, OPUS, { short: 0, silent: 0, control: 0, delay: 40 }],
	["mic-remote", micRemote, OPUS, { short: 0, silent: 0, control: 0, delay: 40 }],
	["relay-bbb-7frame", relayBbb7Frame, AAC, { short: 264, silent: 249, control: 265, delay: 263.3 }],
];

describe.each(["shared", "post"] as const)("%s ring, recorded arrivals", (ring) => {
	// The consumer warns on every group it skips.
	let warn: Mock<typeof console.warn>;
	beforeEach(() => {
		warn = spyOn(console, "warn").mockImplementation(() => {});
	});
	afterEach(() => warn.mockRestore());

	it.each(FIXTURES)(
		"plays %s within its budget",
		async (_name, fixture, config, budget) => {
			const trace = recorded(fixture);
			const concealed = await hear(trace, ring, config, true);
			const control = await hear(trace, ring, config, false);

			expect(concealed.short).toBeLessThanOrEqual(budget.short);
			expect(concealed.silent).toBeLessThanOrEqual(budget.silent);
			expect(concealed.delay).toBeLessThanOrEqual(budget.delay);
			// Concealment never makes it worse, and the control is the gap the ring left on its own.
			expect(control.short).toBeLessThanOrEqual(budget.control);
			expect(concealed.short).toBeLessThanOrEqual(control.short);
			expect(control.counters.concealed).toBe(0);
		},
		30_000,
	);

	it("covers the gaps a flush-heavy stream leaves, which a ring alone leaves audible", async () => {
		const trace = recorded(fourKWebm);
		const concealed = await hear(trace, ring, OPUS, true);
		const control = await hear(trace, ring, OPUS, false);

		// The video track the audio shares a connection with queues it behind a keyframe, so the ring
		// runs dry mid-stream. Half the quanta the gap would have cost are covered by synthesized audio.
		expect(concealed.counters.concealed).toBeGreaterThan(0);
		expect(concealed.short).toBeLessThan(control.short * 0.6);
	}, 30_000);

	it("renders a declared pause as silence, rather than inventing audio over it", async () => {
		// The publisher mutes six seconds in, says so, and speaks again three seconds later. Nothing is
		// missing, so there is nothing to conceal: the ring is flushed on the endpoint, and with it
		// whatever the engine would have repeated.
		const trace = recorded(micLocalMute);
		expect(trace.some((arrival) => arrival.endpoint)).toBe(true);
		const heard = await hear(trace, ring, OPUS, true);

		expect(heard.counters.concealed).toBe(0);
		// The pause is the audio: about three seconds of it, in whole quanta.
		expect(heard.silent).toBeGreaterThan((3 * 48_000) / QUANTUM - 100);
		expect(heard.silent).toBeLessThan((3.5 * 48_000) / QUANTUM);
	}, 30_000);
});

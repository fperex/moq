import { afterEach, describe, expect, it, type Mock, spyOn } from "bun:test";
import type * as Catalog from "@moq/hang/catalog";
import { Time } from "@moq/net";
import { Signal } from "@moq/signals";
import { ClockSource } from "./audio/buffer";
import lanBbb from "./audio/fixtures/lan-bbb.json" with { type: "json" };
import { recorded, replay } from "./audio/replay";
import { type Delay, Sync } from "./sync";

// Video is paced against the audio playhead, so this replays a recorded trace through the real
// consumer, estimator, ring and playout engine and watches where `Sync` puts the picture relative to
// the audio a listener hears. The same replay with the playhead withheld is the control: the wall-clock
// pacing this replaces, which knows nothing of the ring re-buffering, stretching or skipping.
//
// The trace is the LAN recording from `audio/fixtures.test.ts`: arrival timing only.

const RATE = 44_100;
const CONFIG = { codec: "mp4a.40.2", sampleRate: RATE, numberOfChannels: 2 } as unknown as Catalog.AudioConfig;
// How often the audio buffer samples the ring and republishes the clock.
const POLL = 50;

// The consumer warns on every group it skips.
let warn: Mock<typeof console.warn> | undefined;
afterEach(() => warn?.mockRestore());

interface Result {
	/** The furthest the picture ran ahead of the audio a listener can hear, in ms. */
	ahead: number;
	/** The furthest it lagged the audio playhead, in ms. */
	behind: number;
	/** Quanta where both clocks were running, so the numbers above can be read as a rate. */
	quanta: number;
}

/**
 * Replay the trace, and measure `Sync.now()` against the ring's playhead on every quantum.
 *
 * With `nominate`, the ring publishes its playhead the way `SharedAudioBuffer` and `Audio.Decoder` do
 * and video follows it. Without, nothing nominates and playback runs on the wall-clock anchor that
 * arrivals set.
 */
async function run(nominate: boolean): Promise<Result> {
	warn = spyOn(console, "warn").mockImplementation(() => {});
	const trace = recorded(lanBbb);
	const delay = new Signal<Delay>(Time.Milli(100));
	const sync = new Sync({ delay });
	const track = sync.track("audio");
	const source = new ClockSource();

	const result: Result = { ahead: 0, behind: 0, quanta: 0 };
	let next = 0;
	let poll = Number.NEGATIVE_INFINITY;
	const duration = trace[trace.length - 1].at + 20;

	for await (const quantum of replay(trace, {
		ring: "shared",
		rate: RATE,
		config: CONFIG,
		delay: "auto",
		duration,
	})) {
		// What the decoder does with every frame it reads, nominated or not.
		while (next < trace.length && trace[next].at <= quantum.at) {
			sync.received(trace[next].timestamp as Time.Milli, "audio");
			next++;
		}
		delay.set(Time.Milli(quantum.delay));

		// What `SharedAudioBuffer` does on its poll, and what `Audio.Decoder` does with it.
		const playhead = quantum.playhead();
		if (quantum.at - poll >= POLL) {
			poll = quantum.at;
			if (nominate) track.clock.set(source.sample(playhead));
			await new Promise((resolve) => setTimeout(resolve, 0));
		}

		const position = sync.now();
		if (playhead === undefined || position === undefined) continue;

		const media = Time.Milli.fromMicro(playhead.timestamp);
		result.ahead = Math.max(result.ahead, position - media);
		result.behind = Math.max(result.behind, media - position);
		result.quanta++;
	}

	sync.close();
	return result;
}

describe("video follows the audio playhead", () => {
	it("paces a recorded trace against the ring rather than the wall clock", async () => {
		const driven = await run(true);
		const wall = await run(false);

		console.log(
			`sync replay: the picture ${driven.ahead.toFixed(1)}ms ahead / ${driven.behind.toFixed(1)}ms behind the audio playhead over ${driven.quanta} quanta, against ${wall.ahead.toFixed(1)}ms / ${wall.behind.toFixed(1)}ms on the wall clock`,
		);

		expect(driven.quanta).toBeGreaterThan(1000);

		// Both bounds are structurally the sampling interval: the clock cannot learn that the ring
		// parked, resumed or skipped before the next poll.
		expect(driven.ahead).toBeLessThan(POLL);
		expect(driven.behind).toBeLessThan(POLL + 60);

		// The control: pacing the picture off arrivals lets it drift from the audio being played,
		// because nothing in that anchor knows the ring re-buffered, stretched or skipped.
		expect(wall.ahead + wall.behind).toBeGreaterThan(2 * (driven.ahead + driven.behind));
	}, 60_000);
});

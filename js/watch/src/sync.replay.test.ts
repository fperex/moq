import { afterEach, describe, expect, it } from "bun:test";
import * as Container from "@moq/hang/container";
import { Time } from "@moq/net";
import { ClockSource } from "./audio/buffer";
import lanBbb from "./audio/fixtures/lan-bbb.json" with { type: "json" };
import { ringSamples } from "./audio/latency";
import { allocSharedRingBuffer, SharedRingBuffer } from "./audio/shared-ring-buffer";
import { Sync } from "./sync";

// Video is paced against the audio playhead, so this drives a recorded trace through the real ring
// and the real estimator and watches where the two clocks end up relative to each other. The same
// replay with the playhead withheld is the control: it is the wall-clock pacing this replaces.
//
// The trace is the LAN recording from `audio/replay.test.ts`: arrival timing only, trimmed from the
// traces attached to moq-dev/moq#3477.

const RATE = 48000;
const QUANTUM = 128; // an AudioWorklet render quantum
const STEP = (QUANTUM / RATE) * 1000; // the wall time one quantum covers, in ms
// How often the audio buffer samples the ring and republishes the clock. `SharedAudioBuffer` polls
// the shared control array on this interval; the clock rides along rather than adding a timer.
const POLL = 50;
// 30fps of video over the same timeline, which is what the trace was recorded alongside.
const FRAME = 1000 / 30;

// Effects in @moq/signals flush on a microtask, so let pending updates drain before asserting.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// `Time.Milli.now()` reads `performance.now()` on every call, so stubbing it replays a twelve second
// trace in a fraction of that. Timers and microtasks stay real.
function fakeClock() {
	const real = performance.now.bind(performance);
	let at = 0;
	performance.now = () => at;
	return {
		set(ms: number) {
			at = ms;
		},
		restore() {
			performance.now = real;
		},
	};
}

let clock: ReturnType<typeof fakeClock> | undefined;
afterEach(() => {
	clock?.restore();
	clock = undefined;
});

interface Arrival {
	media: number;
	arrival: number;
}

const ARRIVALS: Arrival[] = lanBbb.arrivals.map(({ timestamp_us, arrival_ms }) => ({
	media: timestamp_us / 1000,
	arrival: arrival_ms,
}));

/** How many samples each frame carries, from the distance to the next frame on the media timeline. */
function frameSamples(t: Arrival[]): number[] {
	const sorted = [...t].sort((a, b) => a.media - b.media);
	const spacing = new Map<number, number>();
	for (let i = 0; i < sorted.length - 1; i++) {
		const gap = sorted[i + 1].media - sorted[i].media;
		spacing.set(sorted[i].media, gap > 0 && gap < 100 ? gap : 0);
	}
	const nominal = Math.max(...spacing.values().filter((v) => v > 0));
	return t.map(({ media }) => Math.round((RATE * (spacing.get(media) || nominal)) / 1000));
}

interface Result {
	/** The furthest video ran ahead of the audio a listener can hear, in ms. */
	ahead: number;
	/** The furthest video lagged the audio playhead, in ms. */
	behind: number;
	/** Quanta where both clocks were running, so the two numbers above can be read as a rate. */
	quanta: number;
	/** Every frame `wait()` released: its timestamp, and where the ring was when it did. */
	rendered: Array<{ timestamp: number; playhead: number }>;
}

/**
 * Replay the trace through a real ring, a real estimator and a real `Sync`, pacing a video track
 * against it one `wait()` per frame.
 *
 * With `nominate`, the ring publishes its playhead the way `SharedAudioBuffer` and `Audio.Decoder`
 * do and video follows it. Without, nothing nominates and playback runs on the wall-clock anchor
 * that arrivals set, which is what this quest replaced.
 */
async function replay(nominate: boolean): Promise<Result> {
	const time = fakeClock();
	clock = time;

	const sync = new Sync();
	const track = sync.track("audio");
	const source = new ClockSource();
	const jitter = new Container.Jitter();

	// Sized for the estimator's ceiling up front, the way `SharedAudioBuffer` does.
	const ring = new SharedRingBuffer(
		allocSharedRingBuffer(1, Math.ceil((RATE * Container.Jitter.CEILING) / 1000), RATE),
	);
	const output = [new Float32Array(QUANTUM)];

	const samples = frameSamples(ARRIVALS);
	const end = ARRIVALS[ARRIVALS.length - 1].arrival;

	const rendered: Result["rendered"] = [];
	const pending: Promise<void>[] = [];
	let frame = ARRIVALS[0].media;

	let ahead = 0;
	let behind = 0;
	let quanta = 0;

	let next = 0;
	let poll = -POLL;
	let running = true;

	for (let now = 0; now < end; now += STEP) {
		time.set(now);

		while (next < ARRIVALS.length && ARRIVALS[next].arrival <= now) {
			const timestamp = Time.Micro.fromMilli(ARRIVALS[next].media as Time.Milli);
			jitter.observe(timestamp, now as Time.Milli);
			track.spread.set(jitter.value.peek());
			// What the decoder does with every frame it hands the ring, nominated or not.
			sync.received(ARRIVALS[next].media as Time.Milli, "audio");
			ring.insert(timestamp, [new Float32Array(samples[next]).fill(0.5)]);
			next++;
		}

		ring.read(output);

		if (now - poll >= POLL) {
			poll = now;
			// What `SharedAudioBuffer` does on its poll, and what `Audio.Decoder` does with it.
			if (nominate) track.clock.set(source.sample(ring.playhead));
			await flush();
			ring.setLatency(ringSamples(RATE, sync.out.delay.peek()));
		}

		const playhead = ring.playhead;
		const position = sync.now();
		if (playhead === undefined || position === undefined) continue;

		const media = Time.Milli.fromMicro(playhead.timestamp);
		ahead = Math.max(ahead, position - media);
		behind = Math.max(behind, media - position);
		quanta++;

		// Release every frame the decoder would have handed to `wait()` by now: a lookahead short of
		// due, so the wait is a real sleep rather than a formality.
		while (frame < position + 100) {
			const timestamp = frame as Time.Milli;
			pending.push(
				sync.wait(timestamp).then(() => {
					// Frames the trace ended before reaching are released by the reset below, which
					// is a teardown rather than a presentation.
					if (!running) return;
					rendered.push({
						timestamp,
						playhead: Time.Milli.fromMicro(ring.playhead?.timestamp ?? Time.Micro.zero),
					});
				}),
			);
			frame += FRAME;
		}
	}

	// Let whatever is still parked in `wait()` go, so the test never hangs on a frame the trace
	// ended before reaching.
	running = false;
	sync.reset();
	await Promise.all(pending);
	sync.close();

	return { ahead, behind, quanta, rendered };
}

describe("video follows the audio playhead", () => {
	it("paces a recorded trace against the ring rather than the wall clock", async () => {
		const driven = await replay(true);
		clock?.restore();
		const wall = await replay(false);

		console.log(
			`sync replay: video ${driven.ahead.toFixed(1)}ms ahead / ${driven.behind.toFixed(1)}ms behind the audio playhead over ${driven.quanta} quanta, against ${wall.ahead.toFixed(1)}ms / ${wall.behind.toFixed(1)}ms on the wall clock`,
		);

		expect(driven.quanta).toBeGreaterThan(1000);
		expect(driven.rendered.length).toBeGreaterThan(100);

		// Both bounds are structurally the sampling interval: the clock cannot learn that the ring
		// parked, resumed or skipped before the next poll. Ahead is the direction that matters, and
		// this trace stays well inside a poll there; behind also carries the ring's skip-ahead,
		// which moves the playhead by more than the wall time it took.
		expect(driven.ahead).toBeLessThan(12);
		expect(driven.behind).toBeLessThan(POLL + 60);

		// The control: pacing video off arrivals lets it drift from the audio being played, because
		// nothing in that anchor knows the ring re-buffered or skipped.
		expect(wall.ahead).toBeGreaterThan(4 * driven.ahead);

		// Every frame renders at the audio position it belongs to, never meaningfully before the ring
		// got there. Two terms allow the slack: `wait()` returns without sleeping under 5ms, since a
		// timer that coarse would overshoot anyway, and the clock is up to a poll stale.
		const early = Math.max(...driven.rendered.map(({ timestamp, playhead }) => timestamp - playhead));
		console.log(`sync replay: earliest frame presented ${early.toFixed(1)}ms before the audio reached it`);
		expect(early).toBeLessThan(5 + driven.ahead);
	}, 60_000);
});

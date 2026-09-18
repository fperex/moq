import { afterEach, describe, expect, it } from "bun:test";
import * as Container from "@moq/hang/container";
import { Time } from "@moq/net";
import { Signal } from "@moq/signals";
import { type AudioBuffer, ClockSource, createAudioBuffer } from "./audio/buffer";
import lanBbb from "./audio/fixtures/lan-bbb.json" with { type: "json" };
import { ringSamples } from "./audio/latency";
import type { Message, State } from "./audio/render";
import { allocSharedRingBuffer, SharedRingBuffer } from "./audio/shared-ring-buffer";
import { Terminal } from "./audio/terminal";
import { type Delay, Sync } from "./sync";

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

// ---------------------------------------------------------------------------
// The player's own controls, driven the way a viewer drives them.
// ---------------------------------------------------------------------------
//
// Muting stops the download, so the subscription that resumes starts at the live edge and the
// media between the two is simply gone. Two things have to survive that hole for video to stay on
// the audio a listener hears: the decoder has to be told about it (`Terminal.continues`), because
// it timestamps its output by accumulating frame durations from the chunk that opened its run and
// would otherwise put live audio seconds in the past; and the ring has to be flushed while nothing
// is draining it (`Audio.Decoder.#runFlush`), because replaying what it still holds steps the
// playhead back to where the mute started. Each is switched off in turn below as the control.

// 20ms of media per frame, the Opus packet this suite's traces carry.
const PACKET = RATE / 50;
// A well-paced publisher on a LAN: one frame every 20ms, landing a fixed path delay later.
const PATH = 30;

/** What the viewer did, as (wall time in ms, what they changed). */
type Control = { at: number; muted?: boolean; delay?: Delay };

const SEQUENCE: Control[] = [
	{ at: 4000, muted: true },
	{ at: 7000, muted: false },
	{ at: 11000, delay: 2000 as Time.Milli },
	{ at: 16000, delay: 100 as Time.Milli },
	{ at: 20000, delay: "auto" },
	// Five quick toggles, the way a viewer stabs at the speaker button.
	...[0, 1, 2, 3, 4].flatMap((i) => [
		{ at: 24000 + i * 1200, muted: true },
		{ at: 24600 + i * 1200, muted: false },
	]),
	{ at: 30000 },
];

/**
 * A WebCodecs `AudioDecoder`, as Chromium behaves: the first chunk of a run anchors the output
 * timeline and every later output is timestamped by accumulating decoded frame durations from it,
 * whatever timestamp the chunk itself carried. Measured against `demo/bbb-smooth.hang` on
 * Chromium 151; a hole in the input is swallowed rather than reported.
 */
class FakeDecoder {
	#anchor?: number;
	#frames = 0;

	decode(timestamp: Time.Micro, frames: number) {
		this.#anchor ??= timestamp;
		const out = Math.round(this.#anchor + (this.#frames * 1_000_000) / RATE);
		this.#frames += frames;
		return { timestamp: out, numberOfFrames: frames, sampleRate: RATE };
	}

	/** What `reset()` plus `configure()` does: the next chunk anchors a new run. */
	reset(): void {
		this.#anchor = undefined;
		this.#frames = 0;
	}
}

interface Session {
	/** The worst the painted frame ever was ahead of the audio playhead, in ms. */
	ahead: number;
	/** The worst it was behind, in ms. */
	behind: number;
	/** How far the playhead ended up behind the live edge, in ms. */
	lag: number;
	/** Frames video presented. */
	rendered: number;
	/**
	 * The worst the painted frame was ahead of the playhead the ring *reported*, in ms.
	 *
	 * This is the A/V skew a viewer sees and the harness measures, sampled only while audio is on
	 * and only after the first mute, which is the window the report grades. A ring with no playhead
	 * contributes no sample: there is no position to be skewed against.
	 */
	skew: number;
}

/**
 * The worklet end of the fallback transport: it owns the ring, applies what the buffer posts, and
 * hands state back only when asked.
 *
 * Delivery is the thing the real port decides, so driving it from the test is what makes a state
 * message that crossed a flush reproducible.
 */
class FakeWorklet extends EventTarget {
	readonly port = this;
	readonly #ring: SharedRingBuffer;
	#timeline = 0;

	constructor(ring: SharedRingBuffer) {
		super();
		this.#ring = ring;
	}

	postMessage(msg: Message): void {
		if (msg.type === "data") this.#ring.insert(msg.timestamp, msg.data);
		else if (msg.type === "reset") {
			this.#timeline = msg.timeline;
			this.#ring.reset();
		} else if (msg.type === "stall") this.#ring.stall();
		else if (msg.type === "latency") this.#ring.setLatency(Math.round(RATE * Time.Second.fromMilli(msg.latency)));
	}

	start(): void {}

	/** The state message the worklet would compose from the ring as it stands. */
	compose(): State {
		return {
			type: "state",
			timeline: this.#timeline,
			playhead: this.#ring.playhead,
			debug: this.#ring.debug(),
		};
	}

	/** Deliver one, as the port would. */
	deliver(state: State): void {
		this.dispatchEvent(Object.assign(new Event("message"), { data: state }));
	}
}

/** Build the fallback buffer: taking the global away is how the factory is made to pick it. */
function postAudioBuffer(worklet: FakeWorklet, latency: number): AudioBuffer {
	const shared = globalThis.SharedArrayBuffer;
	(globalThis as { SharedArrayBuffer?: SharedArrayBufferConstructor }).SharedArrayBuffer = undefined;
	try {
		return createAudioBuffer(worklet as unknown as AudioWorkletNode, {
			channels: 1,
			rate: RATE,
			latency,
			buffered: false,
			conceal: true,
		});
	} finally {
		globalThis.SharedArrayBuffer = shared;
	}
}

/**
 * Replay the viewer's sequence through a real ring, a real estimator and a real `Sync`.
 *
 * `reanchor` is `Audio.Decoder.#reanchor`, `flush` is `Audio.Decoder.#runFlush`; both are what this
 * is regression-testing, so each can be switched off to reproduce the desync it fixes.
 *
 * `port` runs the playhead through the real fallback transport instead of reading the ring directly:
 * the buffer only learns where the reader is from state messages, so every mute has one composed
 * before the worklet saw the flush.
 *
 * `videoOffset` is the publisher's audio/video epoch offset, which is what a mute exposes. See
 * the video feed below.
 */
async function session({
	reanchor = true,
	flush: doFlush = true,
	port = false,
	videoOffset = 0,
} = {}): Promise<Session> {
	const time = fakeClock();
	clock = time;

	const delay = new Signal<Delay>("auto");
	const sync = new Sync({ delay });
	const track = sync.track("audio");
	const source = new ClockSource();
	const jitter = new Container.Jitter();
	const terminal = new Terminal();
	const decoder = new FakeDecoder();
	terminal.clear();

	// `SharedAudioBuffer` sizes the ring once, for a target that never has to reallocate. 2^18
	// samples is 5.4s at 48kHz, which covers twice the deepest target the sequence asks for.
	const ring = new SharedRingBuffer(allocSharedRingBuffer(1, 2 ** 18, RATE));
	ring.setLatency(ringSamples(RATE, sync.out.delay.peek()));
	const output = [new Float32Array(QUANTUM)];

	// The fallback transport, when asked for. The ring above stands in for the one the worklet owns,
	// and everything the player does to it goes over the port.
	const worklet = port ? new FakeWorklet(ring) : undefined;
	const buffer = worklet ? postAudioBuffer(worklet, ringSamples(RATE, sync.out.delay.peek())) : undefined;

	const end = SEQUENCE[SEQUENCE.length - 1].at;
	const pending: Promise<void>[] = [];
	let controls = 0;
	let enabled = true;
	let target = sync.out.delay.peek();
	let frame = 0; // the next video frame's timestamp
	let videoMedia = 0; // the next video frame's capture instant, on the audio timeline
	let painted: number | undefined;
	let media = 0; // the next audio frame's timestamp, in ms
	let ahead = 0;
	let behind = 0;
	let skew = 0;
	let rendered = 0;
	let poll = -POLL;
	let running = true;
	let toggled = false; // the cold start is graded by the replay above, not here
	// The playhead the ring publishes, which is what `Audio.Decoder` mirrors onto `audio.out
	// .timestamp` and what every consumer of it reads. Undefined while the ring has none.
	let heard: Time.Micro | undefined;

	for (let now = 0; now < end; now += STEP) {
		time.set(now);

		while (controls < SEQUENCE.length && SEQUENCE[controls].at <= now) {
			const control = SEQUENCE[controls++];
			if (control.delay !== undefined) delay.set(control.delay);
			if (control.muted === undefined) continue;
			enabled = !control.muted;
			if (enabled) {
				// What `Audio.Decoder.#runClock` does the moment the track is enabled again: it
				// follows the ring's clock, whatever the ring is publishing right then.
				if (buffer) track.clock.set(buffer.clock.peek());
				continue;
			}
			toggled = true;
			// What the decoder does on the way out: the graph is disconnected, so nothing drains the
			// ring and it stops being a clock.
			track.clock.set(undefined);
			if (!doFlush) continue;
			// The flush takes the playhead with it, and the shared path only re-reads on its poll.
			heard = undefined;
			if (worklet && buffer) {
				// The message the worklet composed a port hop before the flush reached it, which is
				// therefore the last thing the main thread hears until the graph is connected again.
				const inflight = worklet.compose();
				buffer.reset();
				worklet.deliver(inflight);
			} else {
				ring.reset();
			}
		}

		// Video keeps downloading through a mute, and the decoder hands every arrival to `received()`.
		// With nothing nominating a clock that is the only thing moving the reference, so the mute
		// decides where the picture runs: the lookahead a held frame would need is over `maxAge`, so
		// playback skips ahead to the live edge and stays there until the clock comes back.
		//
		// `videoOffset` is the publisher's audio/video epoch offset. `js/publish` pins the video
		// timeline on the first camera frame's arrival (`video/processor.ts`'s `Epoch`), so whatever
		// sat between capture and that anchor leaves every video timestamp that far ahead of the
		// audio for the same instant, and the viewer holds the picture that much longer to match.
		while (videoMedia + PATH <= now) {
			sync.received((videoMedia + videoOffset) as Time.Milli, "video");
			videoMedia += FRAME;
		}

		// The publisher keeps producing whether or not anyone is listening, so the media a mute
		// covered is never downloaded: the subscription resumes at the live edge.
		if (!enabled) media = Math.max(media, now - PATH);

		while (enabled && media + PATH <= now) {
			const timestamp = Time.Micro.fromMilli(media as Time.Milli);
			jitter.observe(timestamp, now as Time.Milli);
			track.spread.set(jitter.value.peek());
			sync.received(media as Time.Milli, "audio");

			terminal.update({ discontinuity: 0, frame: { timestamp } });
			const hole = !terminal.continues(timestamp);
			if (hole && reanchor) {
				terminal.reanchor();
				decoder.reset();
			}
			const span = terminal.span(decoder.decode(timestamp, PACKET));
			if (span.frames > 0) {
				// What `insert` does on either transport: a park with media still landing in it is a
				// refill, so the clock waits it out rather than handing playback back to the wall.
				const data = [new Float32Array(span.frames).fill(0.5)];
				if (buffer) buffer.insert(span.timestamp, data);
				else {
					source.filling();
					ring.insert(span.timestamp, data);
				}
			}

			media += 1000 / 50;
		}

		// The worklet is only pulled while the graph is connected.
		if (enabled) ring.read(output);

		// Hand `wait()` every frame that has come due, 30fps, and keep the one it painted last. A
		// frame further out than that would park on a real timer, which the stubbed clock does not
		// move; the trace replay above is what covers a `wait()` that really sleeps.
		const present = () => {
			const position = sync.now();
			if (position === undefined) return;
			while (frame < position + 5) {
				const timestamp = frame as Time.Milli;
				pending.push(
					sync.wait(timestamp).then(() => {
						if (!running) return;
						rendered++;
						painted = timestamp;
					}),
				);
				frame += FRAME;
			}
		};
		present();

		// Every quantum, not every poll: the whole defect lives between an unmute and the next state
		// message, which is a fraction of one. A signal read costs nothing, so the postMessage path
		// reads what the buffer publishes directly; the shared ring's playhead getter is stateful, so
		// that path reuses the one read the poll below makes.
		if (buffer) heard = buffer.timestamp.peek();
		if (toggled && enabled && painted !== undefined && heard !== undefined) {
			skew = Math.max(skew, painted - Time.Milli.fromMicro(heard));
		}

		if (now - poll < POLL) continue;
		poll = now;

		if (enabled) {
			if (worklet && buffer) {
				worklet.deliver(worklet.compose());
				track.clock.set(buffer.clock.peek());
			} else {
				// Read once: the getter is stateful, since it measures the reader's rate between reads.
				const playhead = ring.playhead;
				heard = playhead?.timestamp;
				track.clock.set(source.sample(playhead));
			}
		}
		await flush();

		const next = sync.out.delay.peek();
		// `Audio.Decoder.#runLatencyReanchor`: a deepening target parks the ring so it refills
		// rather than keeping on at its old depth.
		if (next - target > 2 * Container.Jitter.BUCKET) {
			if (buffer) buffer.stall();
			else ring.stall();
		}
		target = next;
		if (buffer) buffer.setLatency(ringSamples(RATE, next));
		else ring.setLatency(ringSamples(RATE, next));

		// One sample of what the viewer sees: the frame on the canvas against the audio being
		// played, both settled on the position this poll published.
		present();
		await flush();
		const settled = sync.now();
		if (painted === undefined || settled === undefined) continue;
		ahead = Math.max(ahead, painted - settled);
		behind = Math.max(behind, settled - painted);
	}

	const lag = end - PATH - (sync.now() ?? 0);

	running = false;
	sync.reset();
	await Promise.all(pending);
	sync.close();
	buffer?.close();

	return { ahead, behind, lag, rendered, skew };
}

describe("mutes and latency presets keep video on the audio", () => {
	it("holds the painted frame on the playhead through the whole sequence", async () => {
		const fixed = await session();
		clock?.restore();
		const collapsed = await session({ reanchor: false });
		clock?.restore();
		const stale = await session({ flush: false });

		console.log(
			`sync sequence: painted frame ${fixed.ahead.toFixed(1)}ms ahead / ${fixed.behind.toFixed(1)}ms behind the playhead, ending ${fixed.lag.toFixed(0)}ms behind the live edge`,
		);

		expect(fixed.rendered).toBeGreaterThan(800);

		// One video frame is the resolution the picture has; the clock is up to a poll stale on top
		// of that, which is what a skip or a park costs before the next sample reports it.
		expect(fixed.ahead).toBeLessThan(FRAME + POLL);
		expect(fixed.behind).toBeLessThan(FRAME + POLL);

		// And the audio itself stays at the live edge, which is the reason video can follow it: the
		// only distance left is the delay the viewer asked for.
		expect(fixed.lag).toBeLessThan(500);

		// The controls: each fix alone, removed, puts the playhead seconds behind the live edge and
		// drags the picture there with it.
		console.log(
			`sync sequence: without the decoder re-anchor ${collapsed.ahead.toFixed(0)}ms ahead and ${collapsed.lag.toFixed(0)}ms behind live; without the ring flush ${stale.ahead.toFixed(0)}ms ahead and ${stale.lag.toFixed(0)}ms behind live`,
		);
		expect(collapsed.lag).toBeGreaterThan(2000);
		expect(collapsed.ahead).toBeGreaterThan(1000);
		expect(stale.ahead).toBeGreaterThan(500);
	}, 120_000);

	// What is left after the flush fix: the step the picture takes when the clock changes hands.
	// While audio is the clock the picture is painted at the audio playhead, so a publisher whose
	// two timelines disagree costs nothing visible. A mute takes the clock away and the video
	// arrivals re-anchor playback to the live edge; the unmute hands it back and the picture returns
	// to the playhead. The step between those two positions is the publisher's epoch offset, so a
	// broadcast whose clocks agree returns within a frame and one whose clocks are 350ms apart takes
	// 350ms to walk back. Measured on a browser publisher whose camera anchored 350 to 465ms ahead
	// of its microphone: worst skew 332.9ms, 0.3s after the unmute, converging inside a frame in
	// 0.8s, with no underruns.
	it("returns the picture to the playhead within a frame when the publisher's clocks agree", async () => {
		const aligned = await session({ port: true, videoOffset: 0 });
		clock?.restore();
		const offset = await session({ port: true, videoOffset: 350 });

		console.log(
			`sync sequence (unmute): worst skew ${aligned.skew.toFixed(1)}ms with the publisher's clocks aligned, ${offset.skew.toFixed(1)}ms with them 350ms apart`,
		);

		// One video frame is the resolution the picture has, and the reported playhead is up to a
		// poll stale on top of that.
		expect(aligned.skew).toBeLessThan(FRAME + POLL);

		// The offset and nothing else: hold the viewer adds of its own would show here rather than
		// hiding behind the publisher's.
		expect(offset.skew).toBeGreaterThan(350 - FRAME);
		expect(offset.skew).toBeLessThan(350 + FRAME + POLL);
	}, 120_000);

	// The same sequence over the fallback transport, which is what an engine without cross-origin
	// isolation runs: Firefox and WebKit both spiked about three seconds of skew for about a second
	// after every unmute, and Chromium on the shared ring did not. The difference is the port hop.
	// The buffer flushes and the message already on the wire describes the ring the flush threw
	// away, so it is the last playhead the main thread hears until the graph is connected again,
	// and it is a whole mute behind the one the reader resumes from.
	it("ignores the playhead in a state message that crossed the flush", async () => {
		const fixed = await session({ port: true });

		console.log(
			`sync sequence (postMessage): painted frame at most ${fixed.skew.toFixed(1)}ms ahead of the reported playhead, ${fixed.ahead.toFixed(1)}ms ahead of the sync position, ending ${fixed.lag.toFixed(0)}ms behind the live edge`,
		);

		expect(fixed.rendered).toBeGreaterThan(800);

		// One video frame is the resolution the picture has, and the reported playhead is up to a
		// poll stale on top of that. Anything beyond is a position the reader never resumed from.
		expect(fixed.skew).toBeLessThan(FRAME + POLL);
		expect(fixed.ahead).toBeLessThan(FRAME + POLL);

		// And the audio itself still ends at the live edge.
		expect(fixed.lag).toBeLessThan(500);
	}, 120_000);
});

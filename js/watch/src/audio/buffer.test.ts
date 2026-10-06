import { afterEach, describe, expect, it, jest } from "bun:test";
import { Time } from "@moq/net";
import { Effect } from "@moq/signals";
import { type AudioBuffer, ClockSource, createAudioBuffer } from "./buffer";
import { fakeClock } from "./fake";
import type { Playhead } from "./playhead";
import type { InitShared, Message, State } from "./render";
import { SharedRingBuffer } from "./shared-ring-buffer";

let clock: ReturnType<typeof fakeClock> | undefined;
afterEach(() => {
	clock?.restore();
	clock = undefined;
	jest.useRealTimers();
});

// No device clock to map the playhead onto, so none of the older tests publish one.
const context = { getOutputTimestamp: () => ({}) };

describe("SharedAudioBuffer", () => {
	// The worklet keeps reading the old ring until `init-shared` lands, so a rise that grows the ring
	// has to park that one too, or audio drains ahead of video in between.
	it("parks the ring the worklet still reads when a rise grows it", () => {
		const sent: InitShared[] = [];
		const worklet = { port: { postMessage: (msg: InitShared) => sent.push(msg) } } as unknown as AudioWorkletNode;
		const buffer = createAudioBuffer(worklet, {
			context,
			channels: 1,
			rate: 1000,
			latency: 100,
			buffered: false,
			conceal: true,
		});
		try {
			const old = new SharedRingBuffer(sent[0]);
			buffer.insert(0 as Time.Micro, [new Float32Array(100).fill(1.0)]);
			expect(old.read([new Float32Array(50)])).toBe(50);

			buffer.setLatency(1000);
			expect(sent.length).toBe(2);
			expect(old.stalled).toBe(true);
			expect(old.read([new Float32Array(50)])).toBe(0);
			expect(new SharedRingBuffer(sent[1]).stalled).toBe(true);
		} finally {
			buffer.close();
		}
	});

	// A decode loop can reach `wait` on a buffer a shape change already closed. Nothing advances a
	// closed buffer, so a gated wait would never settle and would hold the decoder effect's rerun.
	it("does not gate a wait on a closed buffer", async () => {
		const worklet = { port: { postMessage: () => {} } } as unknown as AudioWorkletNode;
		const buffer = createAudioBuffer(worklet, {
			context,
			channels: 1,
			rate: 1000,
			latency: 100,
			buffered: true,
			conceal: true,
		});
		buffer.insert(0 as Time.Micro, [new Float32Array(200)]);
		const settles = (wait: Promise<void>) =>
			Promise.race([
				wait.then(() => true),
				new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 0)),
			]);

		// Open, a frame this far ahead of the playhead is held.
		expect(await settles(buffer.wait(10_000_000 as Time.Micro))).toBe(false);

		buffer.close();
		expect(await settles(buffer.wait(10_000_000 as Time.Micro))).toBe(true);
	});
});

function playhead(media: number, rate: number): Playhead {
	return { timestamp: (media * 1000) as Time.Micro, rate };
}

describe("ClockSource", () => {
	it("stamps a moving playhead with the time it was sampled", () => {
		clock = fakeClock();
		const source = new ClockSource();

		expect(source.sample(playhead(500, 1))).toEqual({
			timestamp: 500_000 as Time.Micro,
			reference: 1000 as Time.Milli,
			rate: 1,
		});

		clock.advance(50);
		expect(source.sample(playhead(550, 1))).toEqual({
			timestamp: 550_000 as Time.Micro,
			reference: 1050 as Time.Milli,
			rate: 1,
		});
	});

	it("has no clock before the ring is anchored", () => {
		clock = fakeClock();
		expect(new ClockSource().sample(undefined)).toBeUndefined();
	});

	it("parks through a refill", () => {
		clock = fakeClock();
		const source = new ClockSource();
		source.sample(playhead(500, 1));

		// A re-stall is a refill, and playback pauses with it rather than running away from the
		// audio a listener can hear.
		clock.advance(50);
		expect(source.sample(playhead(500, 0))?.rate).toBe(0);
		clock.advance(500);
		expect(source.sample(playhead(500, 0))?.rate).toBe(0);
	});

	it("parks for as long as a refill keeps arriving", () => {
		// A deep target takes longer to refill than any fixed timeout would allow, and video has to
		// wait it out rather than run ahead and snap back when audio returns.
		clock = fakeClock();
		const source = new ClockSource();
		source.sample(playhead(500, 1));

		for (let i = 0; i < 10; i++) {
			clock.advance(400);
			source.filling();
			expect(source.sample(playhead(500, 0))?.rate).toBe(0);
		}
	});

	it("gives up the clock once a park stops looking like a refill", () => {
		clock = fakeClock();
		const source = new ClockSource();
		source.sample(playhead(500, 1));

		// The park is timed from the first sample that reports one.
		clock.advance(50);
		expect(source.sample(playhead(500, 0))?.rate).toBe(0);
		clock.advance(1001);
		expect(source.sample(playhead(500, 0))).toBeUndefined();

		// A refill landing again brings it back.
		clock.advance(10);
		source.filling();
		expect(source.sample(playhead(500, 0))?.rate).toBe(0);
	});
});

/**
 * A stand-in for the worklet node the buffer talks to: a port that records what was sent and can
 * hand back a state message on demand, which is what makes the postMessage path's ordering testable.
 */
class FakeWorklet extends EventTarget {
	readonly sent: Message[] = [];
	readonly port = this;

	postMessage(msg: Message): void {
		this.sent.push(msg);
	}

	start(): void {}

	/** Deliver a state message as the worklet's render quantum would. */
	deliver(state: State): void {
		this.dispatchEvent(Object.assign(new Event("message"), { data: state }));
	}

	/** The timeline of the last flush it was told about, as the worklet echoes it back. */
	get timeline(): number {
		let timeline = 0;
		for (const msg of this.sent) if (msg.type === "reset") timeline = msg.timeline;
		return timeline;
	}
}

function state(worklet: FakeWorklet, reader: Playhead | undefined, stalled: boolean): State {
	return {
		type: "state",
		timestamp: (reader?.timestamp ?? 0) as Time.Micro,
		contextTime: Time.Second((performance.now() - 1) / 1000),
		timeline: worklet.timeline,
		playhead: reader,
		stalled,
		underruns: 0,
		debug: {
			backend: "message",
			buffered: 0,
			target: 0,
			skip: 0,
			stalled,
			underruns: 0,
			skips: 0,
			skipped: 0,
			discarded: 0,
			queued: 0,
			stretched: 0,
			output: 0,
			concealed: 0,
			accelerates: 0,
			expands: 0,
			merges: 0,
			short: 0,
		},
	};
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The postMessage ring, which a page that is not cross-origin isolated runs. */
function messages<T>(run: () => T): T {
	const isolated = Object.getOwnPropertyDescriptor(globalThis, "crossOriginIsolated");
	Object.defineProperty(globalThis, "crossOriginIsolated", { configurable: true, value: false });
	const log = console.warn;
	console.warn = () => {};
	try {
		return run();
	} finally {
		console.warn = log;
		if (isolated) Object.defineProperty(globalThis, "crossOriginIsolated", isolated);
		else Reflect.deleteProperty(globalThis, "crossOriginIsolated");
	}
}

function build(worklet: FakeWorklet, props: Partial<Parameters<typeof createAudioBuffer>[1]> = {}): AudioBuffer {
	return createAudioBuffer(worklet as unknown as AudioWorkletNode, {
		context,
		channels: 1,
		rate: 48000,
		latency: 4800,
		buffered: false,
		conceal: true,
		...props,
	});
}

describe("AudioBuffer output clock", () => {
	it("keeps the audio timeline stable when worklet messages arrive unevenly", () => {
		clock = fakeClock(1010);
		const worklet = new FakeWorklet();
		let output = { contextTime: 0, performanceTime: 0 };
		const buffer = messages(() => build(worklet, { context: { getOutputTimestamp: () => output } }));
		try {
			worklet.deliver({ ...state(worklet, playhead(500, 1), false), contextTime: Time.Second(1) });
			expect(buffer.clock.peek()).toBeUndefined();
			output = { contextTime: 1, performanceTime: 1000 };
			worklet.deliver({ ...state(worklet, playhead(500, 1), false), contextTime: Time.Second(1) });
			expect(buffer.clock.peek()).toEqual({
				timestamp: Time.Micro(500_000),
				reference: Time.Milli(1000),
				rate: 1,
			});
			clock.advance(25);
			worklet.deliver({ ...state(worklet, playhead(520, 1), false), contextTime: Time.Second(1.02) });
			expect(buffer.clock.peek()).toEqual({
				timestamp: Time.Micro(520_000),
				reference: Time.Milli(1020),
				rate: 1,
			});
			clock.advance(1);
			worklet.deliver({ ...state(worklet, playhead(530, 1), false), contextTime: Time.Second(1.03) });
			expect(buffer.clock.peek()).toEqual({
				timestamp: Time.Micro(530_000),
				reference: Time.Milli(1030),
				rate: 1,
			});
		} finally {
			buffer.close();
		}
	});

	// Chromium 153 answered the first getOutputTimestamp() of a fresh AudioContext with a context
	// time and no device time yet. Mapping through it anchors the playhead to performance time ~0, so
	// `Sync` put the playhead as far ahead as the page was old until the next sample.
	it("publishes no clock while the output timestamp has no performance time", () => {
		clock = fakeClock(50_000);
		const worklet = new FakeWorklet();
		const output = { contextTime: 0.00535, performanceTime: 0 };
		const buffer = messages(() => build(worklet, { context: { getOutputTimestamp: () => output } }));
		try {
			worklet.deliver({ ...state(worklet, playhead(500, 1), false), contextTime: Time.Second(0.02) });
			expect(buffer.clock.peek()).toBeUndefined();
			output.contextTime = 0;
			output.performanceTime = 50_000;
			worklet.deliver({ ...state(worklet, playhead(500, 1), false), contextTime: Time.Second(0.02) });
			expect(buffer.clock.peek()).toEqual({
				timestamp: Time.Micro(500_000),
				reference: Time.Milli(50_020),
				rate: 1,
			});
		} finally {
			buffer.close();
		}
	});

	it("the shared ring's clock is anchored to when its samples leave the output device", () => {
		// The page polls at a fixed instant, 1000ms. The device is 40ms behind the render graph:
		// what was rendered up to context time 1.04s is only now (1000ms) at 1.00s on the output.
		jest.useFakeTimers();
		clock = fakeClock(1000);
		const buffer = build(new FakeWorklet(), {
			context: {
				getOutputTimestamp: () => ({ contextTime: 1, performanceTime: 1000 }),
				currentTime: 1.04,
			},
		});
		try {
			buffer.insert(3_000_000 as Time.Micro, [new Float32Array(4800)]);
			jest.advanceTimersByTime(50);

			// The post ring maps its playhead through getOutputTimestamp; the shared ring must too.
			// Stamped at the poll instead, video leads the sound by the device's output latency.
			expect(buffer.clock.peek()?.reference).toBe(Time.Milli(1040));
		} finally {
			buffer.close();
		}
	});

	it("a partial output timestamp neither throws nor strands backpressure", async () => {
		const worklet = new FakeWorklet();
		let output: Partial<AudioTimestamp> = { contextTime: 1, performanceTime: 1000 };
		const buffer = messages(() =>
			build(worklet, { context: { getOutputTimestamp: () => output as AudioTimestamp }, buffered: true }),
		);
		try {
			// Playing, 500ms in. A frame at 1s is more than the 100ms floor ahead, so it is held.
			worklet.deliver(state(worklet, playhead(500, 1), false));
			let released = false;
			const waiting = buffer.wait(1_000_000 as Time.Micro).then(() => {
				released = true;
			});
			await Promise.resolve();
			expect(released).toBe(false);

			// A runtime hands back only half of the output timestamp, and the playhead reaches the frame.
			output = { performanceTime: 1000 };
			worklet.deliver(state(worklet, playhead(950, 1), false));
			await Promise.resolve();
			expect(released).toBe(true);
			await waiting;
		} finally {
			buffer.close();
		}
	});
});

describe("AudioBuffer, flushed", () => {
	/** Record every clock the buffer publishes, so a stale one cannot slip through between assertions. */
	function record(buffer: AudioBuffer, effect: Effect): Array<Time.Micro | undefined> {
		const seen: Array<Time.Micro | undefined> = [];
		effect.run((inner) => seen.push(inner.get(buffer.clock)?.timestamp));
		return seen;
	}
	const output = { getOutputTimestamp: () => ({ contextTime: 0, performanceTime: 1 }), currentTime: 0 };

	it("never reports the old playhead once the postMessage ring is flushed", async () => {
		const worklet = new FakeWorklet();
		const buffer = messages(() => build(worklet, { context: output }));

		// A signal write notifies on the microtask, so each step settles before the next one.
		const settle = () => sleep(0);

		const effect = new Effect();
		const seen = record(buffer, effect);
		await settle();

		const before = { timestamp: 3_000_000 as Time.Micro, rate: 1 };
		worklet.deliver(state(worklet, before, false));
		expect(buffer.clock.peek()?.timestamp).toBe(before.timestamp);
		await settle();

		// The mute: the flush takes the ring's contents and its playhead with it.
		buffer.reset();
		expect(buffer.clock.peek()).toBeUndefined();
		await settle();

		// A state message composed before the worklet saw the flush. It carries a real playhead of
		// the timeline that is gone, and taking it would put the clock a whole mute behind the video
		// paced against it.
		worklet.deliver({ ...state(worklet, before, false), timeline: worklet.timeline - 1 });
		expect(buffer.clock.peek()).toBeUndefined();
		await settle();

		// The worklet's own post-flush messages, before anything has re-anchored the ring.
		worklet.deliver(state(worklet, undefined, true));
		expect(buffer.clock.peek()).toBeUndefined();
		await settle();

		// The unmute: the first insert re-anchors the ring at the live edge, and that is the first
		// position reported since the flush.
		const after = { timestamp: 6_000_000 as Time.Micro, rate: 1 };
		worklet.deliver(state(worklet, after, false));
		expect(buffer.clock.peek()?.timestamp).toBe(after.timestamp);
		await settle();

		expect(seen).toEqual([undefined, before.timestamp, undefined, after.timestamp]);

		effect.close();
		buffer.close();
	});

	it("never reports the old playhead once the shared ring is flushed", async () => {
		const worklet = new FakeWorklet();
		const buffer = build(worklet, { context: output });

		const effect = new Effect();
		const seen = record(buffer, effect);

		// The shared ring is polled rather than pushed, so each step waits out a poll interval.
		const poll = () => sleep(120);

		const before = 3_000_000 as Time.Micro;
		buffer.insert(before, [new Float32Array(4800)]);
		await poll();
		expect(buffer.clock.peek()?.timestamp).toBe(before);

		buffer.reset();
		expect(buffer.clock.peek()).toBeUndefined();

		// Polling a flushed ring must not bring the old position back.
		await poll();
		expect(buffer.clock.peek()).toBeUndefined();

		const after = 6_000_000 as Time.Micro;
		buffer.insert(after, [new Float32Array(4800)]);
		await poll();
		expect(buffer.clock.peek()?.timestamp).toBe(after);

		expect(seen).toEqual([undefined, before, undefined, after]);

		effect.close();
		buffer.close();
	});
});

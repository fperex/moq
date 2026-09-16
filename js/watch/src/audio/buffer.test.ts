import { afterEach, describe, expect, it } from "bun:test";
import type { Time } from "@moq/net";
import { Effect } from "@moq/signals";
import { type AudioBuffer, ClockSource, createAudioBuffer } from "./buffer";
import type { Playhead } from "./playhead";
import type { Message, State } from "./render";

// `Time.Milli.now()` reads `performance.now()` on every call, so stubbing it puts the park timer
// under the test's control.
function fakeClock(start = 1000) {
	const real = performance.now.bind(performance);
	let at = start;
	performance.now = () => at;
	return {
		advance(ms: number) {
			at += ms;
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

		// And takes it back as soon as the playhead moves again, e.g. after an unmute.
		clock.advance(10);
		expect(source.sample(playhead(500, 1))?.rate).toBe(1);
		clock.advance(10);
		expect(source.sample(playhead(510, 0))?.rate).toBe(0);
	});

	it("gives up the clock at once on a declared endpoint", () => {
		// A publisher that says it has paused is not refilling, so there is nothing to wait out:
		// holding video against the playhead would freeze the picture for a second first.
		clock = fakeClock();
		const source = new ClockSource();
		source.sample(playhead(500, 1));

		source.ended();
		expect(source.sample(playhead(500, 0))).toBeUndefined();

		// Media returning takes it back.
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
		timeline: worklet.timeline,
		playhead: reader,
		debug: {
			buffered: 0,
			target: 0,
			chunk: 0,
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

/** Record every value the buffer publishes, so a stale one cannot slip through between assertions. */
function record(buffer: AudioBuffer, effect: Effect): Array<Time.Micro | undefined> {
	const seen: Array<Time.Micro | undefined> = [];
	effect.run((inner) => seen.push(inner.get(buffer.timestamp)));
	return seen;
}

describe("AudioBuffer, flushed", () => {
	it("never reports the old playhead once the postMessage ring is flushed", async () => {
		const worklet = new FakeWorklet();
		const shared = globalThis.SharedArrayBuffer;
		// Taking the global away is how the factory is made to pick the fallback transport.
		(globalThis as { SharedArrayBuffer?: SharedArrayBufferConstructor }).SharedArrayBuffer = undefined;
		let buffer: AudioBuffer;
		try {
			buffer = createAudioBuffer(worklet as unknown as AudioWorkletNode, {
				channels: 1,
				rate: 48000,
				latency: 4800,
				buffered: false,
				conceal: true,
			});
		} finally {
			globalThis.SharedArrayBuffer = shared;
		}

		// A signal write notifies on the microtask, so each step settles before the next one.
		const settle = () => sleep(0);

		const effect = new Effect();
		const seen = record(buffer, effect);
		await settle();

		const before = { timestamp: 3_000_000 as Time.Micro, rate: 1 };
		worklet.deliver(state(worklet, before, false));
		expect(buffer.timestamp.peek()).toBe(before.timestamp);
		expect(buffer.clock.peek()?.timestamp).toBe(before.timestamp);
		await settle();

		// The mute: the flush takes the ring's contents and its playhead with it.
		buffer.reset();
		expect(buffer.timestamp.peek()).toBeUndefined();
		expect(buffer.clock.peek()).toBeUndefined();
		await settle();

		// A state message composed before the worklet saw the flush. It carries a real playhead of
		// the timeline that is gone, and taking it would put the reported position a whole mute
		// behind the video paced against it.
		worklet.deliver({ ...state(worklet, before, false), timeline: worklet.timeline - 1 });
		expect(buffer.timestamp.peek()).toBeUndefined();
		expect(buffer.clock.peek()).toBeUndefined();
		await settle();

		// The worklet's own post-flush messages, before anything has re-anchored the ring.
		worklet.deliver(state(worklet, undefined, true));
		expect(buffer.timestamp.peek()).toBeUndefined();
		await settle();

		// The unmute: the first insert re-anchors the ring at the live edge, and that is the first
		// position reported since the flush.
		const after = { timestamp: 6_000_000 as Time.Micro, rate: 1 };
		worklet.deliver(state(worklet, after, false));
		expect(buffer.timestamp.peek()).toBe(after.timestamp);
		expect(buffer.clock.peek()?.timestamp).toBe(after.timestamp);
		await settle();

		expect(seen).toEqual([undefined, before.timestamp, undefined, after.timestamp]);

		effect.close();
		buffer.close();
	});

	it("never reports the old playhead once the shared ring is flushed", async () => {
		const worklet = new FakeWorklet();
		const buffer = createAudioBuffer(worklet as unknown as AudioWorkletNode, {
			channels: 1,
			rate: 48000,
			latency: 4800,
			buffered: false,
			conceal: true,
		});

		const effect = new Effect();
		const seen = record(buffer, effect);

		// The shared ring is polled rather than pushed, so each step waits out a poll interval.
		const poll = () => sleep(120);

		const before = 3_000_000 as Time.Micro;
		buffer.insert(before, [new Float32Array(4800)]);
		await poll();
		expect(buffer.timestamp.peek()).toBe(before);

		buffer.reset();
		expect(buffer.timestamp.peek()).toBeUndefined();
		expect(buffer.clock.peek()).toBeUndefined();

		// Polling a flushed ring must not bring the old position back.
		await poll();
		expect(buffer.timestamp.peek()).toBeUndefined();

		const after = 6_000_000 as Time.Micro;
		buffer.insert(after, [new Float32Array(4800)]);
		await poll();
		expect(buffer.timestamp.peek()).toBe(after);

		expect(seen).toEqual([undefined, before, undefined, after]);

		effect.close();
		buffer.close();
	});
});

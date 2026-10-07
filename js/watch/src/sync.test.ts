import { afterEach, describe, expect, it } from "bun:test";
import { Time } from "@moq/net";
import { Signal } from "@moq/signals";
import { fakeClock } from "./audio/fake";
import { type Clock, type Delay, Sync } from "./sync";

// Effects in @moq/signals flush on a microtask, so let pending updates drain before asserting.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

let clock: ReturnType<typeof fakeClock> | undefined;
afterEach(() => {
	clock?.restore();
	clock = undefined;
});

/** A playhead sample: `media` milliseconds of media, held at `at`, advancing at `rate`. */
function sample(media: number, at: Time.Milli, rate = 1): Clock {
	return { timestamp: Time.Micro.fromMilli(media as Time.Milli), reference: at, rate };
}

describe("delay and buffer", () => {
	it("holds no lookahead by default", async () => {
		const sync = new Sync();
		await flush();
		expect(sync.out.buffered.peek()).toBe(false);
		sync.close();
	});

	it("caps maxAge at the delay when no buffer is configured", async () => {
		const sync = new Sync({ delay: 100 as Time.Milli });
		await flush();
		expect(sync.out.buffered.peek()).toBe(false);
		expect(sync.out.delay.peek()).toBe(100 as Time.Milli);
		expect(sync.out.maxAge.peek()).toBe(100 as Time.Milli);
		sync.close();
	});

	it("adds the buffer on top of the delay", async () => {
		// The buffer is measured from the live edge, so it does not swallow the delay: a frame may
		// sit `delay + buffer` ahead of the playhead before playback skips forward.
		const sync = new Sync({ delay: 100 as Time.Milli, buffer: 30_000 as Time.Milli });
		await flush();
		expect(sync.out.buffered.peek()).toBe(true);
		expect(sync.out.maxAge.peek()).toBe(30_100 as Time.Milli);
		sync.close();
	});

	it("stays unbuffered for a zero buffer", async () => {
		const sync = new Sync({ delay: 200 as Time.Milli, buffer: 0 as Time.Milli });
		await flush();
		expect(sync.out.buffered.peek()).toBe(false);
		expect(sync.out.maxAge.peek()).toBe(200 as Time.Milli);
		sync.close();
	});

	it("reacts to a buffer set after construction", async () => {
		const buffer = new Signal<Time.Milli>(0 as Time.Milli);
		const sync = new Sync({ delay: 100 as Time.Milli, buffer });
		await flush();
		expect(sync.out.buffered.peek()).toBe(false);

		buffer.set(30_000 as Time.Milli);
		await flush();
		expect(sync.out.buffered.peek()).toBe(true);
		expect(sync.out.maxAge.peek()).toBe(30_100 as Time.Milli);
		sync.close();
	});

	it("holds nothing when instant, whatever the buffer says", async () => {
		const sync = new Sync({ delay: "instant", buffer: 30_000 as Time.Milli });
		await flush();
		expect(sync.out.instant.peek()).toBe(true);
		expect(sync.out.buffered.peek()).toBe(false);
		expect(sync.out.delay.peek()).toBe(0 as Time.Milli);
		expect(sync.out.maxAge.peek()).toBe(0 as Time.Milli);
		sync.close();
	});
});

describe("auto delay", () => {
	it("holds nothing until a decoder registers", async () => {
		const sync = new Sync();
		await flush();
		expect(sync.out.delay.peek()).toBe(0 as Time.Milli);
		sync.close();
	});

	it("follows the deepest registered target until it unregisters", async () => {
		const audio = new Signal<Time.Milli | undefined>(120 as Time.Milli);
		const video = new Signal<Time.Milli | undefined>(40 as Time.Milli);
		const sync = new Sync();
		const unregisterAudio = sync.register(audio);
		sync.register(video);
		await flush();
		expect(sync.out.delay.peek()).toBe(120 as Time.Milli);
		expect(sync.out.jitter.peek()).toBe(120 as Time.Milli);

		// A publisher flushing 250ms at once needs 250ms of buffer, whatever the round trip is.
		audio.set(270 as Time.Milli);
		await flush();
		expect(sync.out.delay.peek()).toBe(270 as Time.Milli);

		unregisterAudio();
		await flush();
		expect(sync.out.delay.peek()).toBe(40 as Time.Milli);
		sync.close();
	});

	it("unregisters duplicate targets independently", async () => {
		const media = new Signal<Time.Milli | undefined>(20 as Time.Milli);
		const sync = new Sync();
		const unregisterFirst = sync.register(media);
		const unregisterSecond = sync.register(media);

		unregisterFirst();
		await flush();
		expect(sync.out.delay.peek()).toBe(20 as Time.Milli);

		unregisterSecond();
		await flush();
		expect(sync.out.delay.peek()).toBe(0 as Time.Milli);
		sync.close();
	});

	it("takes a fixed delay literally, ignoring the measured targets", async () => {
		const media = new Signal<Time.Milli | undefined>(250 as Time.Milli);
		const sync = new Sync({ delay: 100 as Time.Milli });
		sync.register(media);
		await flush();
		expect(sync.out.delay.peek()).toBe(100 as Time.Milli);
		expect(sync.out.jitter.peek()).toBe(100 as Time.Milli);
		sync.close();
	});
});

describe("clock", () => {
	it("follows the audio playhead while it is nominated", async () => {
		clock = fakeClock();
		const sync = new Sync({ delay: 100 as Time.Milli });
		await flush();

		sync.track("audio").clock.set(sample(5000, clock.at));
		await flush();

		expect(sync.out.clock.peek()).toBe("audio");
		expect(sync.now()).toBe(5000 as Time.Milli);

		// Between samples the playhead is extrapolated locally, so video never reaches across.
		clock.advance(40);
		expect(sync.now()).toBe(5040 as Time.Milli);

		// The ring skipped ahead 60ms: playback goes with it rather than measuring against a wall
		// clock that never skipped.
		sync.track("audio").clock.set(sample(5160, clock.at));
		await flush();
		expect(sync.now()).toBe(5160 as Time.Milli);

		sync.close();
	});

	it("prefers audio over video", async () => {
		clock = fakeClock();
		const sync = new Sync();
		await flush();

		sync.track("video").clock.set(sample(1000, clock.at));
		await flush();
		expect(sync.out.clock.peek()).toBe("video");
		expect(sync.now()).toBe(1000 as Time.Milli);

		sync.track("audio").clock.set(sample(2000, clock.at));
		await flush();
		expect(sync.out.clock.peek()).toBe("audio");
		expect(sync.now()).toBe(2000 as Time.Milli);

		sync.close();
	});

	it("keeps playing at wall speed when the playhead goes away", async () => {
		clock = fakeClock();
		const sync = new Sync({ delay: 100 as Time.Milli });
		await flush();

		sync.track("audio").clock.set(sample(5000, clock.at));
		await flush();
		clock.advance(40);
		const before = sync.now();

		// Muted, or the track ended: the ring stops being a clock.
		sync.track("audio").clock.set(undefined);
		await flush();

		expect(sync.out.clock.peek()).toBeUndefined();
		expect(sync.now()).toBe(before as Time.Milli); // no jump for video to sit through
		clock.advance(25);
		expect(sync.now()).toBe(5065 as Time.Milli); // and it keeps moving at wall speed

		sync.close();
	});

	it("parks with a re-stalled ring and resumes where it left off", async () => {
		clock = fakeClock();
		const sync = new Sync({ delay: 100 as Time.Milli });
		await flush();

		sync.track("audio").clock.set(sample(5000, clock.at));
		await flush();
		clock.advance(20);

		// The ring ran dry and is refilling: the playhead is not moving, so neither is playback.
		sync.track("audio").clock.set(sample(5020, clock.at, 0));
		await flush();
		expect(sync.now()).toBe(5020 as Time.Milli);
		clock.advance(60);
		expect(sync.now()).toBe(5020 as Time.Milli);

		// Still parked a poll later, still the same position.
		sync.track("audio").clock.set(sample(5020, clock.at, 0));
		await flush();
		expect(sync.now()).toBe(5020 as Time.Milli);

		// Refilled. Playback resumes from where it stopped rather than from where a wall clock
		// would have carried it during the stall.
		sync.track("audio").clock.set(sample(5020, clock.at, 1));
		await flush();
		expect(sync.now()).toBe(5020 as Time.Milli);
		clock.advance(30);
		expect(sync.now()).toBe(5050 as Time.Milli);

		sync.close();
	});

	it("extrapolates at the rate it was given", async () => {
		clock = fakeClock();
		const sync = new Sync();
		await flush();

		sync.track("audio").clock.set(sample(1000, clock.at, 0.5));
		await flush();
		clock.advance(100);
		expect(sync.now()).toBe(1050 as Time.Milli);
		clock.advance(100);
		expect(sync.now()).toBe(1100 as Time.Milli);

		sync.close();
	});

	it("holds the reference against arrivals while it is nominated", async () => {
		clock = fakeClock();
		const sync = new Sync({ delay: 100 as Time.Milli });
		await flush();

		sync.track("audio").clock.set(sample(5000, clock.at));
		await flush();
		const reference = sync.out.reference.peek();

		// An early arrival is the ring's problem, not the reference's: it lands in the buffer the
		// playhead is reporting from.
		sync.received(9000 as Time.Milli, "audio");
		expect(sync.out.reference.peek()).toBe(reference as Time.Milli);
		expect(sync.now()).toBe(5000 as Time.Milli);

		sync.close();
	});

	it("anchors on when a frame arrived rather than when it was reported", async () => {
		clock = fakeClock();
		const sync = new Sync({ delay: 100 as Time.Milli });
		await flush();

		// Read on another thread 300ms ago and reported now: playback is 300ms further along than a
		// frame arriving this instant would put it.
		sync.received(5000 as Time.Milli, "audio", Time.Milli.sub(clock.at, Time.Milli(300)));
		expect(sync.now()).toBe(5200 as Time.Milli);

		sync.close();
	});

	it("re-anchors on reset", async () => {
		clock = fakeClock();
		const sync = new Sync({ delay: 100 as Time.Milli });
		await flush();

		sync.track("audio").clock.set(sample(5000, clock.at));
		await flush();
		expect(sync.now()).toBe(5000 as Time.Milli);

		// The utterance ended: the ring is flushed alongside this, so whatever the playhead said
		// belongs to media that is gone.
		sync.reset();
		expect(sync.out.clock.peek()).toBeUndefined();
		expect(sync.now()).toBeUndefined();

		// The flushed ring anchors the next utterance and reports it.
		sync.track("audio").clock.set(sample(20, clock.at));
		await flush();
		expect(sync.out.clock.peek()).toBe("audio");
		expect(sync.now()).toBe(20 as Time.Milli);

		sync.close();
	});

	it("re-derives the reference when the clock comes back at a different playhead", async () => {
		clock = fakeClock();
		const sync = new Sync({ delay: 100 as Time.Milli });
		await flush();

		sync.track("audio").clock.set(sample(5000, clock.at));
		await flush();

		// Muted: the download stops and the flushed ring stops being a clock. Playback carries on at
		// wall speed from where the playhead was.
		sync.track("audio").clock.set(undefined);
		await flush();
		clock.advance(3000);
		expect(sync.now()).toBe(8000 as Time.Milli);

		// Unmuted: the subscription restarts at the live edge, so the ring anchors three seconds on
		// from where it stopped. The reference follows the playhead in one step rather than
		// extrapolating across the hole, so the position is the new playhead exactly.
		sync.track("audio").clock.set(sample(8300, clock.at));
		await flush();
		expect(sync.out.clock.peek()).toBe("audio");
		expect(sync.now()).toBe(8300 as Time.Milli);
		// The delay is still the distance from the reference to the playhead, which is what an
		// arrival is measured against.
		expect(sync.out.reference.peek()).toBe(Time.Milli.sub(clock.at, 8400 as Time.Milli));

		sync.close();
	});

	it("keeps playing through a clock that comes back where it left off", async () => {
		clock = fakeClock();
		const sync = new Sync({ delay: 100 as Time.Milli });
		await flush();

		sync.track("audio").clock.set(sample(5000, clock.at));
		await flush();

		sync.track("audio").clock.set(undefined);
		await flush();
		clock.advance(3000);

		// A flushed ring that refills from the same point on the timeline as the wall clock reached
		// costs no step at all: `now()` is continuous across the hand-back.
		const before = sync.now();
		sync.track("audio").clock.set(sample(8000, clock.at));
		await flush();
		expect(sync.now()).toBe(before as Time.Milli);

		sync.close();
	});

	it("presents the frames a re-nominated playhead is already past", async () => {
		clock = fakeClock();
		const sync = new Sync({ delay: 100 as Time.Milli });
		await flush();

		sync.track("audio").clock.set(sample(5000, clock.at));
		await flush();

		// Video held these while audio was off: the picture is paced against a playhead that stopped.
		let rendered = 0;
		const held = [5100, 5200, 7000].map((ts) => sync.wait(ts as Time.Milli).then(() => rendered++));
		sync.track("audio").clock.set(undefined);
		await flush();
		expect(rendered).toBe(0);

		// The ring re-anchored past all of them, so they are due now rather than after the wall
		// clock walks up to each one.
		clock.advance(3000);
		sync.track("audio").clock.set(sample(8300, clock.at));
		await Promise.all(held);
		expect(rendered).toBe(3);

		sync.close();
	});

	it("keeps a frame waiting until the running audio clock reaches its timestamp", async () => {
		clock = fakeClock();
		const sync = new Sync({ delay: Time.Milli(100) });
		await flush();
		sync.track("audio").clock.set(sample(5000, clock.at));
		await flush();
		let rendered = false;
		const frame = sync.wait(Time.Milli(5030)).then(() => {
			rendered = true;
		});
		try {
			await flush();
			expect(rendered).toBe(false);
			clock.advance(20);
			sync.track("audio").clock.set(sample(5020, clock.at));
			await flush();
			expect(rendered).toBe(false);
			clock.advance(10);
			sync.track("audio").clock.set(sample(5030, clock.at));
			await frame;
			expect(rendered).toBe(true);
		} finally {
			sync.close();
			await frame;
		}
	});

	it.each([1, 20])("keeps a frame %d ms ahead waiting while the audio playhead is parked", async (ahead) => {
		clock = fakeClock();
		const sync = new Sync({ delay: Time.Milli(100) });
		await flush();
		sync.track("audio").clock.set(sample(5000, clock.at, 0));
		await flush();
		let rendered = false;
		const frame = sync.wait(Time.Milli(5000 + ahead)).then(() => {
			rendered = true;
		});
		try {
			await new Promise((resolve) => setTimeout(resolve, 40));
			expect(rendered).toBe(false);
			sync.track("audio").clock.set(sample(5000 + ahead, clock.at, 0));
			await frame;
			expect(rendered).toBe(true);
		} finally {
			sync.reset();
			sync.close();
			await frame;
		}
	});

	it("rechecks a slowed audio playhead when the frame timer expires", async () => {
		clock = fakeClock();
		const sync = new Sync({ delay: Time.Milli(100) });
		await flush();
		sync.track("audio").clock.set(sample(5000, clock.at, 0.5));
		await flush();
		let rendered = false;
		const frame = sync.wait(Time.Milli(5020)).then(() => {
			rendered = true;
		});
		try {
			clock.advance(20);
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(rendered).toBe(false);
			sync.track("audio").clock.set(sample(5020, clock.at, 0));
			await frame;
			expect(rendered).toBe(true);
		} finally {
			sync.close();
			await frame;
		}
	});

	it("releases a parked frame when closed", async () => {
		clock = fakeClock();
		const sync = new Sync({ delay: Time.Milli(100) });
		await flush();
		sync.track("audio").clock.set(sample(5000, clock.at, 0));
		await flush();
		const frame = sync.wait(Time.Milli(5020));
		sync.close();
		await frame;
	});

	it("paces a frame against the playhead rather than the wall clock", async () => {
		clock = fakeClock();
		const sync = new Sync({ delay: 100 as Time.Milli });
		await flush();

		sync.track("audio").clock.set(sample(5000, clock.at));
		await flush();

		let rendered = false;
		const frame = sync.wait(5200 as Time.Milli).then(() => {
			rendered = true;
		});
		await flush();
		expect(rendered).toBe(false);

		// The ring skipped forward past the frame, so it is due now even though no wall time passed.
		sync.track("audio").clock.set(sample(5300, clock.at));
		await frame;
		expect(rendered).toBe(true);

		sync.close();
	});
});

describe("Sync wakes a waiting frame only when its deadline moves", () => {
	// Counts the timers `wait()` arms while one frame waits and the audio clock republishes its
	// playhead `count` times, 5ms apart, each sample off the ideal line by `jitter(i)` ms. Every timer
	// after the first is a wake: the sleep was cut short, its listeners dropped and re-armed.
	async function timersWhileSampling(jitter: (i: number) => number, count = 20): Promise<number> {
		clock = fakeClock(1000);
		const sync = new Sync({ delay: Time.Milli(100) });
		const audio = sync.track("audio");
		audio.clock.set(sample(500, clock.at));
		await flush();

		const real = globalThis.setTimeout;
		let armed = 0;
		globalThis.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
			// Only the sleep's own timer (a positive deadline), not the test's zero-delay flushes.
			if (ms !== undefined && ms > 0) armed++;
			return real(fn, ms, ...rest);
		}) as typeof setTimeout;
		try {
			// A frame 200ms ahead of the playhead waits.
			const waiting = sync.wait(Time.Milli(700));
			await flush();
			for (let i = 1; i <= count; i++) {
				clock.advance(5);
				audio.clock.set(sample(500 + 5 * i + jitter(i), clock.at));
				await flush();
			}
			sync.close();
			await waiting;
		} finally {
			globalThis.setTimeout = real;
		}
		return armed;
	}

	it("samples exactly on the extrapolated line do not wake it", async () => {
		expect(await timersWhileSampling(() => 0)).toBeLessThanOrEqual(2);
	});

	it("samples within a millisecond of the extrapolated line do not wake it", async () => {
		// What a real clock delivers: the worklet's playhead and the reference it is stamped with
		// never line up to the microsecond, so each sample lands a fraction of a millisecond off.
		const jitter = (i: number) => [0.25, -0.25, 0.1, -0.1][i % 4];
		expect(await timersWhileSampling(jitter)).toBeLessThanOrEqual(2);
	});
});

describe("wait", () => {
	it("returns at once when constructed instant, before effects flush", async () => {
		const sync = new Sync({ delay: "instant" });
		await sync.wait(Time.Milli.zero);
		sync.close();
	});

	it("wakes a sleeping wait when the delay switches to instant", async () => {
		const delay = new Signal<Delay>(10_000 as Time.Milli);
		const sync = new Sync({ delay });
		await flush();
		sync.received(Time.Milli.now());

		let woke = false;
		const waiting = sync.wait(Time.Milli.now()).then(() => {
			woke = true;
		});
		await flush();
		expect(woke).toBe(false);

		delay.set("instant");
		await waiting;
		expect(woke).toBe(true);
		sync.close();
	});

	it("wakes a sleeping wait on reset", async () => {
		const sync = new Sync({ delay: 10_000 as Time.Milli });
		await flush();
		sync.received(Time.Milli.now());

		const waiting = sync.wait(Time.Milli.now());
		await flush();
		sync.reset();
		await waiting;
		sync.close();
	});
});

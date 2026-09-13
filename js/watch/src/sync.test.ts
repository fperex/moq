import { afterEach, describe, expect, it } from "bun:test";
import { Time } from "@moq/net";
import { Signal } from "@moq/signals";
import { type Clock, Sync } from "./sync";

// Effects in @moq/signals flush on a microtask, so let pending updates drain before asserting.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// `Time.Milli.now()` reads `performance.now()` on every call, so stubbing it runs playback on a
// clock the test steps by hand. Everything else (timers, microtasks) stays real.
function fakeClock(start = 1000) {
	const real = performance.now.bind(performance);
	let at = start;
	performance.now = () => at;
	return {
		get at(): Time.Milli {
			return at as Time.Milli;
		},
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
		expect(sync.out.buffered.peek()).toBe(false);
		expect(sync.out.delay.peek()).toBe(0 as Time.Milli);
		expect(sync.out.maxAge.peek()).toBe(0 as Time.Milli);
		sync.close();
	});
});

describe("auto delay", () => {
	it("starts at the advertised delay and follows the measured arrivals", async () => {
		const sync = new Sync();
		sync.track("audio").advertised.set(20 as Time.Milli);
		sync.track("video").advertised.set(33 as Time.Milli);
		await flush();

		// Nothing measured yet, so the delay is what the catalog advertises.
		expect(sync.out.jitter.peek()).toBe(0 as Time.Milli);
		expect(sync.out.delay.peek()).toBe(33 as Time.Milli);

		// A publisher flushing 250ms of audio at once needs 250ms of buffer, whatever the RTT is.
		// The measured spread already covers what the catalog advertises, so it replaces the
		// advertised delay rather than stacking on it.
		sync.track("audio").spread.set(250 as Time.Milli);
		await flush();
		expect(sync.out.jitter.peek()).toBe(250 as Time.Milli);
		expect(sync.out.delay.peek()).toBe(250 as Time.Milli);

		sync.close();
	});

	it("takes the largest spread across tracks", async () => {
		const sync = new Sync();
		sync.track("audio").spread.set(40 as Time.Milli);
		sync.track("video").spread.set(120 as Time.Milli);
		await flush();
		expect(sync.out.jitter.peek()).toBe(120 as Time.Milli);

		sync.track("audio").spread.set(200 as Time.Milli);
		await flush();
		expect(sync.out.jitter.peek()).toBe(200 as Time.Milli);

		// Captions are a track like any other: they join without a new pair of inputs.
		sync.track("text").spread.set(300 as Time.Milli);
		await flush();
		expect(sync.out.jitter.peek()).toBe(300 as Time.Milli);

		sync.close();
	});

	it("ignores the measured spread when the delay is a fixed number", async () => {
		const sync = new Sync({ delay: 500 as Time.Milli });
		sync.track("audio").advertised.set(20 as Time.Milli);
		sync.track("audio").spread.set(250 as Time.Milli);
		await flush();
		expect(sync.out.jitter.peek()).toBe(500 as Time.Milli);
		expect(sync.out.delay.peek()).toBe(520 as Time.Milli);
		sync.close();
	});

	it("keeps the advertised delay as a floor", async () => {
		// The advertised value is a publisher-declared flush span and the measurement is of the
		// network. When the measurement is the smaller of the two the publisher still knows
		// something the receiver has not seen yet, so it holds.
		const sync = new Sync();
		sync.track("audio").advertised.set(250 as Time.Milli);
		sync.track("audio").spread.set(20 as Time.Milli);
		await flush();
		expect(sync.out.jitter.peek()).toBe(20 as Time.Milli);
		expect(sync.out.delay.peek()).toBe(250 as Time.Milli);
		sync.close();
	});

	it("bounds the measured jitter at the estimator's ceiling", async () => {
		// The estimator's histogram covers 2s and drops anything past it, so a reading above that is
		// not a reading. Nothing should be able to size a buffer past it either way.
		const sync = new Sync();
		sync.track("audio").spread.set(10_000 as Time.Milli);
		await flush();
		expect(sync.out.jitter.peek()).toBe(2000 as Time.Milli);
		expect(sync.out.delay.peek()).toBe(2000 as Time.Milli);
		sync.close();
	});

	it("holds nothing when instant, whatever the spread says", async () => {
		const sync = new Sync({ delay: "instant" });
		sync.track("audio").advertised.set(250 as Time.Milli);
		sync.track("audio").spread.set(500 as Time.Milli);
		await flush();
		expect(sync.out.jitter.peek()).toBe(0 as Time.Milli);
		expect(sync.out.delay.peek()).toBe(0 as Time.Milli);
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

	it("never lets captions drive it", async () => {
		// Captions render on `now()`, so nominating one would leave the clock chasing itself. The
		// handle has no way to publish a playhead at all.
		const sync = new Sync();
		expect("clock" in sync.track("text")).toBe(false);
		expect("clock" in sync.track("audio")).toBe(true);
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

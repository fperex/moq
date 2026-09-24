import { afterEach, describe, expect, it } from "bun:test";
import * as Container from "@moq/hang/container";
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
	it("follows the measured arrivals and nothing else", async () => {
		const sync = new Sync();
		await flush();

		// Nothing reported yet. The estimator publishes its own cold start, which is seeded from
		// what the rendition advertises, so there is no second term for it here.
		expect(sync.out.jitter.peek()).toBe(0 as Time.Milli);
		expect(sync.out.delay.peek()).toBe(0 as Time.Milli);

		// A publisher flushing 250ms of audio at once needs 250ms of buffer, whatever the RTT is.
		sync.track("audio").spread.set(250 as Time.Milli);
		await flush();
		expect(sync.out.jitter.peek()).toBe(250 as Time.Milli);
		expect(sync.out.delay.peek()).toBe(250 as Time.Milli);

		// And a path that turns out to be clean gets the shallow buffer it measured, rather than
		// being pinned at whatever the publisher declared.
		sync.track("audio").spread.set(20 as Time.Milli);
		await flush();
		expect(sync.out.delay.peek()).toBe(20 as Time.Milli);

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

	it("keeps a departed track's reading for a window, so a rendition that blinks moves nothing", async () => {
		// A publisher hiding its camera takes the rendition out of the catalog for a few hundred
		// milliseconds. Dropping its reading the instant it goes takes the delay down to whatever
		// the remaining tracks measured and its return puts it straight back, and the audio ring
		// pays for both: resized down, then parked to refill, which is an underrun the listener
		// hears. Three of five watchers on the bench took one from a 300ms camera hide.
		clock = fakeClock();
		const sync = new Sync();
		sync.track("audio").spread.set(40 as Time.Milli);
		sync.track("video").spread.set(120 as Time.Milli);
		await flush();
		expect(sync.out.jitter.peek()).toBe(120 as Time.Milli);

		// The window starts where the track goes, not where its reading last moved: a steady path
		// republishes the same number, which notifies nothing, so a deadline taken on the last
		// change would have run out long before the camera was ever hidden.
		clock.advance(30_000);
		sync.track("video").spread.set(undefined);
		await flush();
		expect(sync.out.jitter.peek()).toBe(120 as Time.Milli);

		// And it comes back, having measured the same path it was measuring before.
		sync.track("video").spread.set(120 as Time.Milli);
		await flush();
		expect(sync.out.jitter.peek()).toBe(120 as Time.Milli);

		// A track that really has gone stops holding the buffer open. Any reading re-taken past the
		// window drops it; here the audio track publishing again is what re-takes it.
		sync.track("video").spread.set(undefined);
		await flush();
		clock.advance(2_001);
		sync.track("audio").spread.set(40 as Time.Milli, true);
		await flush();
		expect(sync.out.jitter.peek()).toBe(40 as Time.Milli);

		sync.close();
	});

	it("is exactly the number asked for when the delay is fixed", async () => {
		// A viewer picking 500ms gets 500ms. Adding the publisher's declared flush span on top made
		// the 100ms preset read 400ms on a source declaring 300, which is not what the label says.
		const sync = new Sync({ delay: 500 as Time.Milli });
		sync.track("audio").spread.set(250 as Time.Milli);
		await flush();
		expect(sync.out.jitter.peek()).toBe(500 as Time.Milli);
		expect(sync.out.delay.peek()).toBe(500 as Time.Milli);
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

	it("keeps a frame waiting until the running audio clock reaches its timestamp", async () => {
		clock = fakeClock();
		const sync = new Sync({ delay: Time.Milli(100) });
		await flush();
		sync.track("audio").clock.set(sample(5000, clock.at));
		await flush();
		let rendered = false;
		const frame = sync.wait(Time.Milli(5004)).then(() => {
			rendered = true;
		});
		try {
			await flush();
			expect(rendered).toBe(false);
			clock.advance(3);
			sync.track("audio").clock.set(sample(5003, clock.at));
			await flush();
			expect(rendered).toBe(false);
			clock.advance(1);
			sync.track("audio").clock.set(sample(5004, clock.at));
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

describe("the cross-track arrival offset", () => {
	// Feed both tracks the same media timeline in real time, with the picture landing `late`
	// milliseconds after the sound for every timestamp. Returns the sync afterwards.
	function deliver(
		sync: Sync,
		tick: ReturnType<typeof fakeClock>,
		late: number | ((media: number) => number),
		seconds = 8,
	) {
		const lateness = typeof late === "number" ? () => late : late;
		for (let media = 0; media < seconds * 1000; media += 20) {
			// The sound for this instant, on time.
			tick.advance(20);
			sync.received(media as Time.Milli, "audio");

			// The picture for the same instant, `late` milliseconds behind it. Sent on the sound's
			// grid so the two are measured against the same wall clock rather than drifting apart.
			if (media % 40 === 0) {
				sync.received(Math.max(0, media - lateness(media)) as Time.Milli, "video");
			}
		}
	}

	it("holds the sound for a picture that arrives later, and only for that", async () => {
		clock = fakeClock();
		const sync = new Sync({ delay: Time.Milli(40) });
		try {
			deliver(sync, clock, 70);
			await flush();

			// Only the part a viewer would notice: 45ms of it is inside the window ITU-R BT.1359
			// says nobody sees, and the 25ms left is covered a whole bucket at a time rather than
			// by a term that flickers by a millisecond and re-parks the ring.
			expect(sync.out.offset.peek()).toBe(Time.Milli(40));

			// The estimator's answer is untouched: the jitter buffer row still reports what the
			// viewer asked for, and the corpus still describes the whole of `out.delay`.
			expect(sync.out.delay.peek()).toBe(Time.Milli(40));

			// What playback actually waits, and what the age budget has to reach back over, both
			// grow by it. Otherwise the deeper hold waits for a group the budget already convicted.
			expect(sync.out.maxAge.peek()).toBe(Time.Milli(80));
		} finally {
			sync.close();
		}
	});

	it("adds nothing when the two tracks arrive together", async () => {
		clock = fakeClock();
		const sync = new Sync({ delay: Time.Milli(40) });
		try {
			deliver(sync, clock, 0);
			await flush();

			expect(sync.out.offset.peek()).toBe(Time.Milli.zero);
			expect(sync.out.delay.peek()).toBe(Time.Milli(40));
			expect(sync.out.maxAge.peek()).toBe(Time.Milli(40));
		} finally {
			sync.close();
		}
	});

	it("adds nothing for a picture that arrives early, which the playhead already holds", async () => {
		clock = fakeClock();
		const sync = new Sync({ delay: Time.Milli(40) });
		try {
			// The publisher stamps its camera ahead of its microphone, so the picture lands before
			// the sound for the same timestamp. Video is painted when the playhead reaches it, so it
			// is held for free; deepening the sound here would push the picture further behind.
			deliver(sync, clock, -70);
			await flush();

			expect(sync.out.offset.peek()).toBe(Time.Milli.zero);
		} finally {
			sync.close();
		}
	});

	it("stops holding past what lip sync is worth", async () => {
		clock = fakeClock();
		const sync = new Sync({ delay: Time.Milli(40) });
		try {
			// Tune-in on an impaired path: the video track is still replaying the span between the
			// last keyframe and the live edge, so every arrival honestly looks seconds late. A
			// picture that far behind is out of sync whatever the sound does, and holding the sound
			// with it just makes everything late.
			deliver(sync, clock, 2_000, 14);
			await flush();

			expect(sync.out.offset.peek()).toBe(Time.Milli(100));
		} finally {
			sync.close();
		}
	});

	it("stops at the cap for a camera pipeline the hold cannot cover", async () => {
		clock = fakeClock();
		const sync = new Sync({ delay: Time.Milli(40) });
		try {
			// A self-publish whose camera pipeline runs 300ms behind its microphone. The hold buys
			// back what a call is willing to wait for and no more: past the cap the sound would be
			// held for a picture the viewer has already given up on.
			deliver(sync, clock, 300, 14);
			await flush();

			expect(sync.out.offset.peek()).toBe(Time.Milli(100));
		} finally {
			sync.close();
		}
	});

	it("does not hold the sound for the camera's warm-up frames", async () => {
		clock = fakeClock();
		const sync = new Sync({ delay: Time.Milli(40) });
		const held: number[] = [];
		try {
			// Tune-in on a self-publish: the first frames out of a camera are its slowest, and the
			// steady cadence behind them is inside the tolerance. A hold derived from the warm-up
			// would sit at the cap until both windows had rotated past it, which is the few seconds
			// of held sound a publisher hears at the start of their own broadcast.
			const late = (media: number) => (media < 500 ? 400 : 60);
			for (let media = 0; media < 10_000; media += 20) {
				clock.advance(20);
				sync.received(media as Time.Milli, "audio");
				if (media % 40 === 0) sync.received(Math.max(0, media - late(media)) as Time.Milli, "video");
				held.push(sync.out.offset.peek());
			}
			await flush();

			// Never more than a step or two, where the uncapped term used to stand at the ceiling
			// for as long as both windows remembered the warm-up.
			expect(Math.max(...held)).toBeLessThanOrEqual(Time.Milli(40));
			// The steady cadence is inside the tolerance, so nothing is held at all.
			expect(sync.out.offset.peek()).toBe(Time.Milli.zero);
		} finally {
			sync.close();
		}
	});

	it("keeps the hold across a mute, so the ring is not re-derived on the unmute", async () => {
		clock = fakeClock();
		const sync = new Sync({ delay: Time.Milli(40) });
		try {
			deliver(sync, clock, 70);
			await flush();
			const before = sync.out.offset.peek();
			expect(before).toBe(Time.Milli(40));

			// The listener mutes for three seconds. The download stops; the path does not change.
			for (let media = 8000; media < 11000; media += 20) {
				clock.advance(20);
				if (media % 40 === 0) sync.received((media - 70) as Time.Milli, "video");
			}
			await flush();
			expect(sync.out.offset.peek()).toBe(before);

			// Unmuted: the sound is back on the same path, so the hold it lands in is the one it
			// left rather than one derived from a cold window.
			for (let media = 11000; media < 13000; media += 20) {
				clock.advance(20);
				sync.received(media as Time.Milli, "audio");
				if (media % 40 === 0) sync.received((media - 70) as Time.Milli, "video");
			}
			await flush();

			expect(Math.abs(sync.out.offset.peek() - before)).toBeLessThanOrEqual(Container.Jitter.BUCKET);
		} finally {
			sync.close();
		}
	});

	it("lets go once the picture stops arriving", async () => {
		clock = fakeClock();
		const sync = new Sync({ delay: Time.Milli(40) });
		try {
			deliver(sync, clock, 70);
			await flush();
			expect(sync.out.offset.peek()).toBe(Time.Milli(40));

			// The tile is muted, the canvas scrolls away, the picture stops. A term measured
			// against a track nobody is downloading would hold the sound deep for the session.
			for (let media = 8000; media < 16000; media += 20) {
				clock.advance(20);
				sync.received(media as Time.Milli, "audio");
			}
			await flush();

			expect(sync.out.offset.peek()).toBe(Time.Milli.zero);
		} finally {
			sync.close();
		}
	});
});

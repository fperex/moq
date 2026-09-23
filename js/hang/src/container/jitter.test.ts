import { describe, expect, it } from "bun:test";
import { Time } from "@moq/net";
import { HOLD, Jitter, type JitterObservation, STALL_WINDOW } from "./jitter";
import { load, replay } from "./jitter.vectors.ts";
import { Stall, type StallTimer } from "./stall";

const FRAME = 20;
const START = 80;

/** Feed one arrival, in milliseconds on both axes. */
function observe(jitter: Jitter, media: number, arrival: number, observation?: JitterObservation): void {
	jitter.observe(Time.Micro.fromMilli(media as Time.Milli), arrival as Time.Milli, observation);
}

/**
 * A sender emitting one frame every `frame` ms, holding `burst - 1` of them back and flushing the
 * whole run at once. `burst` of 1 is an evenly paced sender.
 *
 * Returns the media timestamp one past the last frame, so a caller can keep the timeline going.
 */
function flush(
	jitter: Jitter,
	options: { frames: number; burst?: number; base?: number; start?: number; frame?: number },
): number {
	const { frames, burst = 1, base = 50, start = 0, frame = FRAME } = options;
	let held: number[] = [];

	for (let i = 0; i < frames; i++) {
		const media = start + i * frame;
		held.push(media);
		if (held.length < burst) continue;
		for (const m of held) observe(jitter, m, media + base);
		held = [];
	}

	return start + frames * frame;
}

/**
 * The event loop monitor's own timer and probe, on a clock the test moves by hand.
 *
 * `advance` runs whatever was queued up to `to`, which is a loop that keeps running. `throttle`
 * holds every schedule to a minimum interval, which is what a hidden tab does to `setTimeout` while
 * its loop and its socket carry on as before. `busy` runs nothing at all while the test keeps
 * reading, which is a loop running flat out: the reads are served and everything queued behind them
 * waits.
 */
function fakeTimer(): StallTimer & { advance(to: number): void; throttle(ms: number): void; busy(on: boolean): void } {
	let now = 0;
	let due: { at: number; fn: () => void } | undefined;
	let floor = 0;
	let stopped = false;
	let handler: (() => void) | undefined;
	let queued = 0;

	return {
		now: () => now,
		schedule: (fn, ms) => {
			due = { at: now + Math.max(ms, floor), fn };
			return due;
		},
		clear: () => {
			due = undefined;
		},
		probe: (fn) => {
			handler = fn;
			return {
				post: () => {
					queued++;
				},
				close: () => {},
			};
		},
		advance(to: number) {
			// One millisecond at a time, so a timer that reschedules itself fires as often as it would
			// on a loop that was running.
			while (now < to) {
				now++;
				if (stopped) continue;

				for (;;) {
					// A task the loop was handed goes before a timer: it is served as soon as whatever
					// is in front of it is done.
					if (queued > 0) {
						queued--;
						handler?.();
						continue;
					}
					if (due !== undefined && due.at <= now) {
						const fn = due.fn;
						due = undefined;
						fn();
						continue;
					}
					break;
				}
			}
		},
		throttle(ms: number) {
			floor = ms;
		},
		busy(on: boolean) {
			stopped = on;
		},
	};
}

describe("tune-in", () => {
	// The regression that closed PR #3517. Its estimator learned a "frame duration" from the gap
	// between consecutive timestamps, so the very first gap set it with nothing to validate against
	// and a viewer read a 14.56s buffer. Written first, and it reads 14560 on that estimator.
	it("does not inflate from a stale frame followed by the live edge", () => {
		const jitter = new Jitter();

		observe(jitter, 0, 0);
		observe(jitter, 14_560, 5);
		expect(jitter.value.peek()).toBeLessThanOrEqual(2000 as Time.Milli);

		// Ten seconds of perfectly paced audio with no real jitter at all.
		let max = Time.Milli.zero;
		for (let i = 1; i <= 500; i++) {
			observe(jitter, 14_560 + i * FRAME, 5 + i * FRAME);
			max = Time.Milli.max(max, jitter.value.peek());
		}

		expect(max).toBeLessThanOrEqual(2000 as Time.Milli);
		expect(jitter.value.peek()).toBeLessThanOrEqual(100 as Time.Milli);
	});

	it("starts at the cold-start guess", () => {
		expect(new Jitter().value.peek()).toBe(START as Time.Milli);
	});

	it("starts at what the publisher declares it flushes", () => {
		// The TS importer advertises 302ms on the bbb sources. A declaration is a measurement of the
		// same quantity by the party that already knows it, so it is where the estimate starts.
		expect(new Jitter({ start: 302 as Time.Milli }).value.peek()).toBe(320 as Time.Milli);
	});

	it("never starts below the cold-start guess", () => {
		// A browser publisher declares its 20ms frame duration. The network still adds to that, and
		// nothing has been measured yet, so the guess stands.
		expect(new Jitter({ start: 20 as Time.Milli }).value.peek()).toBe(START as Time.Milli);
		expect(new Jitter({ start: Time.Milli.zero }).value.peek()).toBe(START as Time.Milli);
	});

	it("never starts above the histogram's range", () => {
		// A publisher declaring more than the estimator can ever measure would otherwise name a
		// target no observation could bring down.
		expect(new Jitter({ start: 9000 as Time.Milli }).value.peek()).toBe(Jitter.CEILING as Time.Milli);
	});

	it("replaces a declared start with the first measurement", () => {
		// A prior, not an observation. The first resampled observation lands half a second in and
		// takes the target straight to what it measured, because the fall bound exists to protect
		// an earlier measurement and a declaration is not one. Walking a 320ms guess down instead
		// leaves a viewer holding a buffer nothing measured asked for, for tens of seconds.
		const jitter = new Jitter({ start: 310 as Time.Milli });
		expect(jitter.value.peek()).toBe(320 as Time.Milli);

		// One second of evenly paced frames on a clean path.
		flush(jitter, { frames: 50 });

		const measured = jitter.value.peek();
		expect(measured).toBeGreaterThanOrEqual(Jitter.BUCKET as Time.Milli);
		expect(measured).toBeLessThanOrEqual(60 as Time.Milli);
	});

	it("falls from a declared start to what it measures", () => {
		// The declaration is a prior, not a floor: a path that turns out to be clean settles on the
		// same bucket the unseeded estimator does.
		const jitter = new Jitter({ start: 302 as Time.Milli });
		expect(jitter.value.peek()).toBe(320 as Time.Milli);

		flush(jitter, { frames: 1000 });
		expect(jitter.value.peek()).toBe(Jitter.BUCKET as Time.Milli);
	});
});

describe("steady state", () => {
	it("converges from the cold start to one bucket", () => {
		const jitter = new Jitter();
		expect(jitter.value.peek()).toBe(START as Time.Milli);

		flush(jitter, { frames: 500 });
		expect(jitter.value.peek()).toBe(Jitter.BUCKET as Time.Milli);
	});

	it("does not follow the absolute path delay", () => {
		// A sender on the other side of the planet is not a jittery sender. This is exactly what an
		// RTT-derived buffer gets wrong, and why the two terms are not interchangeable.
		const near = new Jitter();
		const far = new Jitter();
		flush(near, { frames: 500, base: 10 });
		flush(far, { frames: 500, base: 2010 });
		expect(far.value.peek()).toBe(near.value.peek());
	});

	it("reads a publisher's flush span", () => {
		// Seven AAC frames per PES, which is what the public relay serves. 120ms of spread reads as
		// the bucket above it.
		const jitter = new Jitter();
		flush(jitter, { frames: 700, burst: 7 });
		expect(jitter.value.peek()).toBe(140 as Time.Milli);
	});

	it("sees a slow build-up an inter-arrival estimator cannot", () => {
		// Each frame is 2ms later than the last, so consecutive deltas are 2ms while the delay the
		// buffer has to absorb climbs to 200ms.
		const jitter = new Jitter();
		for (let i = 0; i < 300; i++) {
			observe(jitter, i * FRAME, i * FRAME + 50 + Math.min(i, 100) * 2);
		}
		expect(jitter.value.peek()).toBeGreaterThan(100 as Time.Milli);
	});
});

describe("reordering", () => {
	it("excludes an arrival that is not strictly newer", () => {
		const paced = new Jitter();
		const swapped = new Jitter();

		flush(paced, { frames: 300 });

		// The same path, except every tenth frame loses a race with its successor. The successor
		// keeps its own arrival time, so nothing about the path changed.
		for (let i = 0; i < 300; i++) {
			const media = i * FRAME;
			if (i % 10 === 9) continue;
			if (i % 10 === 8) {
				observe(swapped, media + FRAME, media + FRAME + 50);
				observe(swapped, media, media + FRAME + 51);
				observe(swapped, media, media + 50);
				continue;
			}
			observe(swapped, media, media + 50);
		}

		expect(swapped.value.peek()).toBe(paced.value.peek());
	});

	it("takes an explicit reordered flag even when the timestamp is newer", () => {
		const jitter = new Jitter();
		flush(jitter, { frames: 500 });
		const settled = jitter.value.peek();

		// A frame the caller already knows arrived out of order. Half a second late, so it would
		// otherwise raise the target by a lot.
		observe(jitter, 500 * FRAME, 500 * FRAME + 550, { reordered: true });
		expect(jitter.value.peek()).toBe(settled);
	});
});

describe("the receiver's own reading gap", () => {
	it("does not read a blocked read loop as path delay", () => {
		// A tune-in blocks the main thread on a decoder polyfill, a worklet start and the first
		// keyframe. Nothing about the path changes: the frames land on time and queue, and the read
		// loop stamps every one of them when it runs again. Measured against a reference from before
		// the block the first one out of the queue reads as the whole block.
		const jitter = new Jitter();
		flush(jitter, { frames: 200, burst: 7 });

		const settled = jitter.value.peek();
		expect(settled).toBe(140 as Time.Milli);

		const BLOCK = 1500;
		const DRAIN = 3;
		const blocked = 200 * FRAME;

		let cursor = blocked + BLOCK;
		let max = settled;
		let recovered: number | undefined;

		for (let i = 200; i < 1200; i++) {
			const media = i * FRAME;

			// Read at the later of when the frame landed and when the loop got to it.
			const read = Math.max(media + 50, cursor);
			cursor = read + DRAIN;
			observe(jitter, media, read);

			const value = jitter.value.peek();
			max = Time.Milli.max(max, value);
			if (recovered === undefined && value <= settled) recovered = read;
		}

		expect(max).toBeLessThanOrEqual((settled + 2 * Jitter.BUCKET) as Time.Milli);
		expect(recovered).toBeLessThanOrEqual(blocked + BLOCK + 5000);
	});

	it("still measures a publisher slower than the resample interval", () => {
		// One frame a second is idle for longer than the resample interval on every single arrival,
		// so a rule that only looked at how long the loop was idle would throw the whole track away.
		// What says the receiver was reading is that the timeline advanced as far as the wall clock
		// did, which is true here and false for a backlog.
		const jitter = new Jitter();

		for (let i = 0; i < 10; i++) observe(jitter, i * 1000, i * 1000 + 50);
		expect(jitter.value.peek()).toBeLessThanOrEqual(Jitter.BUCKET as Time.Milli);

		// From here every other frame is 400ms late. The receiver was reading throughout: each
		// arrival covers as much media as the wall clock moved, give or take the path's own jitter,
		// which is the 400ms the buffer has to hold.
		for (let i = 10; i < 60; i++) {
			observe(jitter, i * 1000, i * 1000 + 50 + (i % 2 === 1 ? 400 : 0));
		}

		expect(jitter.value.peek()).toBeGreaterThanOrEqual(400 as Time.Milli);
	});

	it("takes an explicit stalled flag for a block the spacing cannot see", () => {
		// 400ms is under the resample interval, so the spacing rule leaves it alone however plainly
		// it was the receiver: a publisher flushing every 400ms produces the same arrivals. The
		// receiver watched its own event loop, so it knows, and says so.
		const BLOCK = 400;
		const DRAIN = 2;

		const flagged = new Jitter();
		const unflagged = new Jitter();
		for (const jitter of [flagged, unflagged]) flush(jitter, { frames: 400 });

		const settled = flagged.value.peek();
		expect(settled).toBe(Jitter.BUCKET as Time.Milli);

		let cursor = 400 * FRAME + BLOCK;
		let max = settled;
		let control = settled;

		for (let i = 400; i < 900; i++) {
			const media = i * FRAME;
			const read = Math.max(media + 50, cursor);
			// Every frame the loop was late to is one the loop was late to, not one the path held.
			const stalled = read > media + 50;
			cursor = read + DRAIN;

			observe(flagged, media, read, { stalled });
			observe(unflagged, media, read);

			max = Time.Milli.max(max, flagged.value.peek());
			control = Time.Milli.max(control, unflagged.value.peek());
		}

		// The flagged run drops the reference on every frame of the burst, so none of them measures
		// the block and none of them reaches the histogram as anything but zero.
		expect(max).toBe(settled);
		// And the same arrivals with nothing watching the loop, which is what the flag is worth: most
		// of the block lands in the target, where the histogram then remembers it for half a minute.
		expect(control).toBeGreaterThanOrEqual(300 as Time.Milli);
	});

	it("the target does not decay while the tab's timers are throttled", () => {
		// The flag comes from watching the event loop, so what the monitor calls a block is what the
		// estimator throws arrivals away for. A hidden tab is rationed to one timer a second while its
		// loop keeps running and its socket keeps being read, so the arrivals here are the ones a
		// visible tab sees and the path's jitter is the same 60ms throughout.
		const LATE = 60;

		const timer = fakeTimer();
		const stall = new Stall(timer);
		const jitter = new Jitter();

		let frame = 0;
		let cursor = 0;

		// Every tenth frame is held 60ms and the frames queued behind it are read right after it.
		const feed = (seconds: number) => {
			for (let i = 0; i < (seconds * 1000) / FRAME; i++) {
				const media = frame * FRAME;
				cursor = Math.max(cursor, media + 50 + (frame % 10 === 9 ? LATE : 0));
				frame++;

				timer.advance(cursor);
				observe(jitter, media, cursor, { stalled: stall.blocked(cursor as Time.Milli) });
			}
		};

		feed(30);
		const settled = jitter.value.peek();
		expect(settled).toBe(80 as Time.Milli);

		// The tab goes to the background. Two minutes of it, because the histogram's own memory holds
		// the measured tail above the quantile for the first minute of discarded arrivals.
		timer.throttle(1000);
		feed(120);

		expect(jitter.value.peek()).toBeGreaterThanOrEqual((settled - Jitter.BUCKET) as Time.Milli);

		stall.close();
	});

	it("the target does not rise while the loop is busy but still answering", () => {
		// The same monitor with two tracks on it. A page running flat out on a keyframe keeps reading
		// the socket, so the audio track's arrivals keep the loop visibly alive at 20ms spacing while
		// the video group queued behind the work is handed over all at once at the end of the burst.
		// Those frames waited in this receiver; measured against the path they read as 300ms of it.
		const VIDEO = 33;
		const AUDIO = 20;
		const PATH = 50;
		const BURST = 300;
		const PERIOD = 2000;
		const SECONDS = 30;

		const run = (bursts: boolean): number => {
			const timer = fakeTimer();
			const stall = new Stall(timer);
			const jitter = new Jitter();

			let held: number[] = [];

			for (let ms = 1; ms <= SECONDS * 1000; ms++) {
				const busy = bursts && ms % PERIOD < BURST;
				timer.busy(busy);
				timer.advance(ms);

				// The audio track is read throughout, whatever the loop is doing.
				if (ms % AUDIO === 0) stall.blocked(ms as Time.Milli);

				if (ms >= PATH && (ms - PATH) % VIDEO === 0) held.push(ms - PATH);
				if (busy || held.length === 0) continue;

				for (const media of held) {
					observe(jitter, media, ms, { stalled: stall.blocked(ms as Time.Milli) });
				}
				held = [];
			}

			stall.close();
			return jitter.value.peek();
		};

		// The path is the same 50ms throughout both, so the only thing between them is the loop, and
		// a target that can tell the difference is one sizing a viewer's buffer for this receiver.
		const steady = run(false);
		expect(Math.abs(run(true) - steady)).toBeLessThanOrEqual(Jitter.BUCKET);
	});
});

describe("the histogram", () => {
	it("drops an observation past its range instead of clamping it", () => {
		const jitter = new Jitter();
		flush(jitter, { frames: 500 });
		const settled = jitter.value.peek();

		// The path stalls 2500ms and keeps the loss, so the next arrivals read past the 2000ms
		// range. Clamping them into the last bucket would pin the target at 2000ms.
		let max: Time.Milli = settled;
		for (let i = 500; i < 700; i++) {
			observe(jitter, i * FRAME, i * FRAME + 50 + 2500);
			max = Time.Milli.max(max, jitter.value.peek());
		}
		expect(max).toBeLessThanOrEqual(settled);
	});

	it("forgets once per resampled observation, not once per arrival", () => {
		// Two senders with the same 120ms flush span but three times apart in frame rate: 20ms
		// frames flushed seven at a time, and 60ms frames flushed three at a time. A factor applied
		// per arrival would forget the burst three times faster for the denser one; applied per
		// resampled observation it is a wall-clock time constant, so both land in the same place
		// after the same four seconds of clean audio.
		const dense = new Jitter();
		const sparse = new Jitter();

		flush(dense, { frames: 100, burst: 7 });
		flush(sparse, { frames: 36, burst: 3, frame: 60 });
		expect(sparse.value.peek()).toBe(dense.value.peek());

		flush(dense, { frames: 200, start: 100 * FRAME });
		flush(sparse, { frames: 67, frame: 60, start: 36 * 60 });
		expect(sparse.value.peek()).toBe(dense.value.peek());
	});

	it("ramps the forget factor so a cold start converges in seconds", () => {
		// Four seconds of clean audio is 8 observations. Without the ramp the seeded 0.5^(i+1) prior
		// still retains prior mass after 8 decays of 0.9, so the startup ramp must replace it
		// before the steady-state history has faded.
		const jitter = new Jitter();
		flush(jitter, { frames: 200 });
		expect(jitter.value.peek()).toBe(Jitter.BUCKET as Time.Milli);
	});
});

describe("pauses", () => {
	it("decays across a gap with no arrivals", () => {
		// The same stream twice: once interrupted for ten seconds, once not. A histogram that only
		// decays on an arrival would come out of the gap holding exactly what it went in with, so
		// the two would agree.
		const paused = new Jitter();
		const uninterrupted = new Jitter();

		for (const [jitter, gap] of [
			[paused, 10_000],
			[uninterrupted, 0],
		] as const) {
			flush(jitter, { frames: 200, burst: 7 });
			flush(jitter, { frames: 300, start: 200 * FRAME + gap });
		}

		expect(paused.value.peek()).toBeLessThan(uninterrupted.value.peek());
	});

	it("caps the catch-up so a very long gap costs no more than a long one", () => {
		const long = new Jitter();
		const longer = new Jitter();

		for (const [jitter, gap] of [
			[long, 30_000],
			[longer, 600_000],
		] as const) {
			flush(jitter, { frames: 200, burst: 7 });
			const resume = 200 * FRAME + gap;
			observe(jitter, resume, resume + 50);
			observe(jitter, resume + FRAME, resume + FRAME + 50);
		}

		expect(longer.value.peek()).toBe(long.value.peek());
	});
});

describe("rise and fall", () => {
	it("releases a temporary queue within twenty seconds of paced arrivals", () => {
		const jitter = new Jitter();
		const congested = flush(jitter, { frames: 6000 });
		const recovered = flush(jitter, { frames: 300, burst: 25, start: congested });
		expect(jitter.value.peek()).toBeGreaterThanOrEqual(Time.Milli(480));

		flush(jitter, { frames: 1000, start: recovered });
		expect(jitter.value.peek()).toBeLessThanOrEqual(Time.Milli(200));
	});

	it("rises as soon as an arrival proves the buffer is too shallow", () => {
		const jitter = new Jitter();
		flush(jitter, { frames: 500 });
		expect(jitter.value.peek()).toBe(Jitter.BUCKET as Time.Milli);

		// One second of 7-frame bursts, two resample intervals, takes it straight to the span.
		flush(jitter, { frames: 56, burst: 7, start: 500 * FRAME });
		expect(jitter.value.peek()).toBe(140 as Time.Milli);
	});

	it("still bounds the fall once the target is a measurement", () => {
		// Replacing the seed is a one-off. From the first measurement onwards the target is
		// something an arrival proved, so it walks down at the ordinary bound rather than jumping
		// to whatever the histogram last asked for.
		const jitter = new Jitter({ start: 310 as Time.Milli });

		// Two seconds of 7-frame bursts: the seed is long gone and the flush span is measured.
		flush(jitter, { frames: 100, burst: 7 });
		expect(jitter.value.peek()).toBe(140 as Time.Milli);

		// Then a clean path, whose quantile drops to one bucket long before the target may.
		const start = 100 * FRAME;
		let previous = jitter.value.peek();
		let bottom: number | undefined;

		for (let i = 0; i < 1000; i++) {
			const media = start + i * FRAME;
			observe(jitter, media, media + 50);

			const value = jitter.value.peek();
			// A sixth of the distance left from 140ms is under a bucket, so the bucket is the step.
			expect(previous - value).toBeLessThanOrEqual(Jitter.BUCKET);
			previous = value;
			if (bottom === undefined && value === Jitter.BUCKET) bottom = media;
		}

		// Six buckets at a bucket a second: the fall cannot be quicker than that.
		expect(bottom).toBeGreaterThanOrEqual(start + 6000);
	});

	it("falls no faster than one bucket per second while it is close", () => {
		const jitter = new Jitter();
		flush(jitter, { frames: 100, burst: 7 });

		const from = jitter.value.peek();
		expect(from).toBe(140 as Time.Milli);

		const start = 100 * FRAME;
		const anchor = start + 50;
		let previous = from;

		for (let i = 0; i < 1000; i++) {
			const media = start + i * FRAME;
			observe(jitter, media, media + 50);

			const value = jitter.value.peek();
			expect(value).toBeLessThanOrEqual(previous);
			expect(from - value).toBeLessThanOrEqual(Math.floor((media + 50 - anchor) / 1000) * Jitter.BUCKET);
			previous = value;
		}

		expect(jitter.value.peek()).toBe(Jitter.BUCKET as Time.Milli);
	});

	it("closes a large overshoot without taking a second per bucket", () => {
		// The path degrades 30ms a frame for a second, which the estimator reads as the delay it is,
		// and then flushes what it queued. The quantile comes down in whole handfuls of buckets as
		// the histogram forgets, and a fixed step cannot follow it: 1480ms at a bucket a second is
		// 74 seconds, long after the old observations have faded.
		const jitter = new Jitter();
		flush(jitter, { frames: 500 });

		const degraded = 500 * FRAME;
		for (let i = 0; i < 50; i++) {
			const media = degraded + i * FRAME;
			observe(jitter, media, media + 50 + i * 30);
		}
		expect(jitter.value.peek()).toBeGreaterThan(1000 as Time.Milli);

		// The queue drains at 3ms a frame and the path is clean again from there.
		const recovering = degraded + 50 * FRAME;
		let cursor = recovering + 50 + 49 * 30;
		let settled: number | undefined;

		for (let i = 0; i < 4000; i++) {
			const media = recovering + i * FRAME;
			const read = Math.max(media + 50, cursor);
			cursor = read + 3;
			observe(jitter, media, read);

			if (settled === undefined && jitter.value.peek() === Jitter.BUCKET) settled = read;
		}

		expect(settled).toBeDefined();
		expect((settled as number) - recovering).toBeLessThan(45_000);
	});
});

describe("a run-dry the arrivals cannot show", () => {
	// Where `flush` leaves the arrival clock: the last frame it fed landed `base` after its timestamp.
	const clock = (media: number) => (media - FRAME + 50) as Time.Milli;

	// The page itself was blocked: the frame it held is read out of the block flagged `stalled`, the
	// way `Stall` marks it. Returns the media past it, so `clock` of that is when it landed.
	const blocked = (jitter: Jitter, media: number): number => {
		observe(jitter, media, media + 50, { stalled: true });
		return media + FRAME;
	};

	it("rises at once to cover what the player ran out of", () => {
		// A clean path, so the arrivals ask for one bucket. The receiver froze for 120ms with 40ms
		// held, and the frames it was not reading are discounted as its own, so nothing about them
		// raises the target: the 82ms the player ran dry is the only thing that says it was too low.
		const jitter = new Jitter();
		const media = blocked(jitter, flush(jitter, { frames: 500 }));
		expect(jitter.value.peek()).toBe(Jitter.BUCKET as Time.Milli);

		jitter.starved(82 as Time.Milli, clock(media));
		expect(jitter.value.peek()).toBe(120 as Time.Milli);
	});

	it("changes nothing when the page was not blocked", () => {
		// The same report with no stalled arrival anywhere near it: lost media, a path that stopped,
		// or a tune-in, all of which the arrivals measure or no buffer can fix.
		const reported = new Jitter();
		const control = new Jitter();
		let media = 0;
		for (const jitter of [reported, control]) media = flush(jitter, { frames: 500 });
		reported.starved(82 as Time.Milli, clock(media));
		expect(reported.value.peek()).toBe(Jitter.BUCKET as Time.Milli);

		// Nor later: the report did not start a hold either.
		for (const jitter of [reported, control]) flush(jitter, { frames: 500, start: media });
		expect(reported.value.peek()).toBe(control.value.peek());
	});

	it("changes nothing when the last block is further away than STALL_WINDOW", () => {
		const jitter = new Jitter();
		const media = blocked(jitter, flush(jitter, { frames: 500 }));
		const stalled = clock(media);

		// The run-dry is reported once the page has been running normally for a while.
		const later = flush(jitter, { frames: 2 + Math.ceil(STALL_WINDOW / FRAME), start: media });
		expect(clock(later) - stalled).toBeGreaterThan(STALL_WINDOW);
		jitter.starved(82 as Time.Milli, clock(later));
		expect(jitter.value.peek()).toBe(Jitter.BUCKET as Time.Milli);
	});

	it("still counts a report STALL_WINDOW after the block", () => {
		const jitter = new Jitter();
		const media = blocked(jitter, flush(jitter, { frames: 500 }));
		jitter.starved(82 as Time.Milli, Time.Milli(clock(media) + STALL_WINDOW));
		expect(jitter.value.peek()).toBe(120 as Time.Milli);
	});

	it("counts a block on a frame that came out of order", () => {
		// The flag says the page was blocked before this frame was read, whatever order it came in.
		const jitter = new Jitter();
		const media = flush(jitter, { frames: 500 });
		observe(jitter, media - 2 * FRAME, media + 50, { stalled: true });
		jitter.starved(82 as Time.Milli, Time.Milli(media + 50));
		expect(jitter.value.peek()).toBe(120 as Time.Milli);
	});

	it("holds the raised target until HOLD after the report, then falls as a fall does", () => {
		const jitter = new Jitter();
		const start = blocked(jitter, flush(jitter, { frames: 500 }));
		const at = clock(start);
		jitter.starved(82 as Time.Milli, at);

		let previous = jitter.value.peek();
		let bottom: number | undefined;
		for (let media = start; media < start + HOLD + 10_000; media += FRAME) {
			observe(jitter, media, media + 50);
			const value = jitter.value.peek();

			// Nothing measured asks for more than a bucket, and nothing moves it before the hold ends.
			if (media + 50 < at + HOLD) expect(value).toBe(120 as Time.Milli);
			// Past it, the ordinary fall: never more than a bucket at a time from this close.
			expect(previous - value).toBeLessThanOrEqual(Jitter.BUCKET);
			previous = value;
			if (bottom === undefined && value === Jitter.BUCKET) bottom = media + 50;
		}

		// Five buckets at a bucket a second, the first a second after the hold ends.
		expect(bottom).toBeGreaterThanOrEqual(at + HOLD + 5000 - FRAME);
		expect(bottom).toBeLessThanOrEqual(at + HOLD + 5000 + FRAME);
	});

	it("restarts the hold on every report, and only ever raises the level", () => {
		const jitter = new Jitter();
		let media = blocked(jitter, flush(jitter, { frames: 500 }));
		jitter.starved(82 as Time.Milli, clock(media));
		expect(jitter.value.peek()).toBe(120 as Time.Milli);

		// Ten seconds on, the page blocks again and the run-dry is reported with nothing more to add.
		// The level stays where the first report put it, and the hold is measured from here now.
		media = blocked(jitter, flush(jitter, { frames: 500, start: media }));
		const last = clock(media);
		jitter.starved(Time.Milli.zero, last);
		expect(jitter.value.peek()).toBe(120 as Time.Milli);

		media = flush(jitter, { frames: (HOLD - 1000) / FRAME, start: media });
		expect(jitter.value.peek()).toBe(120 as Time.Milli);

		// Only once the second report's hold is over does the target come down.
		flush(jitter, { frames: 5000 / FRAME, start: media });
		expect(jitter.value.peek()).toBeLessThan(120 as Time.Milli);
	});

	it("adds a later run-dry to the target it raised", () => {
		// The first report covered the freeze but for 5ms: the player still ran dry at the raised
		// target, so the next report is measured from there, and the level climbs a bucket.
		const jitter = new Jitter();
		let media = blocked(jitter, flush(jitter, { frames: 500 }));
		jitter.starved(82 as Time.Milli, clock(media));
		media = blocked(jitter, flush(jitter, { frames: 75, start: media }));
		jitter.starved(5 as Time.Milli, clock(media));
		expect(jitter.value.peek()).toBe(140 as Time.Milli);
	});

	it("leaves a target the histogram already asks for to the histogram", () => {
		// A run-dry raises the level to 60ms, and then the path turns bursty and the arrivals ask
		// for more than that on their own. From the moment they do, the held level decides nothing:
		// the series is the one the same arrivals produce with no run-dry at all, through the end of
		// the hold and past it.
		const reported = new Jitter();
		const control = new Jitter();
		let media = 0;
		for (const jitter of [reported, control]) media = blocked(jitter, flush(jitter, { frames: 100 }));
		reported.starved(40 as Time.Milli, clock(media));
		expect(reported.value.peek()).toBe(60 as Time.Milli);

		let joined = false;
		for (let i = 0; i < (HOLD + 10_000) / FRAME; i++) {
			const frame = media / FRAME + i;
			// Seven frames flushed at once, the packing the public relay serves.
			const flushed = (Math.floor(frame / 7) * 7 + 6) * FRAME + 50;
			for (const jitter of [reported, control]) observe(jitter, frame * FRAME, flushed);

			if (control.value.peek() > 60) joined = true;
			if (joined) expect(reported.value.peek()).toBe(control.value.peek());
		}
		expect(joined).toBe(true);
		expect(control.value.peek()).toBe(140 as Time.Milli);
	});

	it("keeps the first measurement from landing below a running hold", () => {
		// The player ran dry before the first resample interval closed, so the target is still the
		// cold-start prior. The report raises it all the same, and the first measurement, which
		// replaces a prior outright, does not replace a run-dry the player actually had.
		const jitter = new Jitter();
		observe(jitter, 0, 50);
		observe(jitter, FRAME, FRAME + 50);
		observe(jitter, 2 * FRAME, 2 * FRAME + 50, { stalled: true });
		expect(jitter.value.peek()).toBe(START as Time.Milli);

		jitter.starved(60 as Time.Milli, (2 * FRAME + 50) as Time.Milli);
		expect(jitter.value.peek()).toBe(140 as Time.Milli);

		// One second of a clean path: without the report its first measurement lands on one bucket.
		flush(jitter, { frames: 50, start: 3 * FRAME });
		expect(jitter.value.peek()).toBe(140 as Time.Milli);

		const control = new Jitter();
		flush(control, { frames: 53 });
		expect(control.value.peek()).toBe(Jitter.BUCKET as Time.Milli);
	});

	it("starts over from the target once a hold has run out", () => {
		// The level an expired hold asked for is gone: a new report is measured from where the
		// target has fallen to, not from what the old one held.
		const jitter = new Jitter();
		let media = blocked(jitter, flush(jitter, { frames: 500 }));
		jitter.starved(82 as Time.Milli, clock(media));
		media = flush(jitter, { frames: (HOLD + 2500) / FRAME, start: media });
		expect(jitter.value.peek()).toBe(80 as Time.Milli);

		media = blocked(jitter, media);
		jitter.starved(10 as Time.Milli, clock(media));
		expect(jitter.value.peek()).toBe(100 as Time.Milli);
	});

	it("never raises the target past the histogram's range", () => {
		const jitter = new Jitter();
		const media = blocked(jitter, flush(jitter, { frames: 500 }));
		jitter.starved(5000 as Time.Milli, clock(media));
		expect(jitter.value.peek()).toBe(Jitter.CEILING as Time.Milli);
	});

	it("keeps a running hold across a re-anchor", () => {
		// A discontinuity moves the timeline, not the player: what it ran dry at still stands.
		const jitter = new Jitter();
		const media = blocked(jitter, flush(jitter, { frames: 500 }));
		jitter.starved(82 as Time.Milli, clock(media));

		// The media timeline jumps a hundred seconds ahead; the wall clock the arrivals land on does not.
		jitter.reanchor();
		flush(jitter, { frames: 500, start: media + 100_000, base: 50 - 100_000 });
		expect(jitter.value.peek()).toBe(120 as Time.Milli);
	});

	it("refuses a gap that is not a duration", () => {
		const jitter = new Jitter();
		expect(() => jitter.starved(-1 as Time.Milli, Time.Milli.zero)).toThrow(RangeError);
		expect(() => jitter.starved(Number.NaN as Time.Milli, Time.Milli.zero)).toThrow(RangeError);
		expect(jitter.value.peek()).toBe(START as Time.Milli);
	});
});

describe("re-anchoring", () => {
	it("keeps the distribution and drops the reference", () => {
		const jitter = new Jitter();
		flush(jitter, { frames: 700, burst: 7 });
		const settled = jitter.value.peek();
		expect(settled).toBe(140 as Time.Milli);

		// The timeline rewinds to zero. Without dropping the reference every arrival after the
		// rewind would read as hours of delay; without keeping the histogram the target would fall
		// back to the cold-start guess.
		jitter.reanchor();
		flush(jitter, { frames: 56, burst: 7 });
		expect(jitter.value.peek()).toBe(settled);
	});

	it("does not treat a rewound timestamp as reordered forever", () => {
		const jitter = new Jitter();
		flush(jitter, { frames: 500, start: 100_000 });

		jitter.reanchor();
		flush(jitter, { frames: 500 });
		expect(jitter.value.peek()).toBe(Jitter.BUCKET as Time.Milli);
	});
});

describe("conformance", () => {
	const corpus = load();

	for (const entry of corpus.cases) {
		it(`${entry.name}: ${entry.description}`, () => {
			expect(replay(entry.arrivals, entry.start_ms)).toEqual(entry.target_ms);
		});
	}
});

import { describe, expect, it } from "bun:test";
import type { Time } from "@moq/net";
import { Stall, type StallTimer } from "./stall";

/**
 * A clock the test moves by hand, with the monitor's timer and probe on it.
 *
 * `advance` moves time and runs whatever was queued, which is a loop that never blocks. `block`
 * moves time without running anything and then lets the queue catch up, which is a loop that did.
 * `busy` runs nothing while the test keeps querying, which is a loop running flat out: it answers
 * the reads and everything queued behind them waits. `throttle` holds every schedule to a minimum
 * interval, which is a hidden tab: the loop runs, only its timers are rationed.
 */
function fake(): StallTimer & {
	advance(ms: number): void;
	block(ms: number): void;
	busy(on: boolean): void;
	throttle(ms: number): void;
	posts(): number;
	released(): boolean;
	at(): Time.Milli;
} {
	let now = 0;
	let due: { at: number; fn: () => void } | undefined;
	let floor = 0;
	let stopped = false;
	let handler: (() => void) | undefined;
	let queued = 0;
	let posts = 0;
	let released = false;

	const run = () => {
		if (stopped) return;

		for (;;) {
			// A task the loop was handed goes before a timer, which is what makes it the cheaper
			// witness: it is served as soon as whatever is in front of it is done.
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
	};

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
					posts++;
					queued++;
				},
				close: () => {
					released = true;
				},
			};
		},
		advance(ms: number) {
			// One millisecond at a time, so a timer that reschedules itself fires as often as it
			// would on a loop that was running.
			for (let i = 0; i < ms; i++) {
				now++;
				run();
			}
		},
		block(ms: number) {
			// Nothing runs while the loop is blocked; the overdue timer fires the moment it is over.
			now += ms;
			run();
		},
		busy(on: boolean) {
			stopped = on;
		},
		throttle(ms: number) {
			floor = ms;
		},
		posts: () => posts,
		released: () => released,
		at: () => now as Time.Milli,
	};
}

describe("the event loop monitor", () => {
	it("reports nothing on a loop that keeps running", () => {
		const timer = fake();
		const stall = new Stall(timer);

		timer.advance(1000);
		expect(stall.blocked(timer.at())).toBe(false);

		stall.close();
	});

	it("reports a block, and stops reporting it a tick later", () => {
		const timer = fake();
		const stall = new Stall(timer);

		timer.advance(500);
		timer.block(400);

		// The backlog the block left is read the moment the loop is back.
		expect(stall.blocked(timer.at())).toBe(true);

		// A tick after it ended the loop is running normally again, and what an arrival waits from
		// here is the path's.
		timer.advance(50);
		expect(stall.blocked(timer.at())).toBe(true);
		timer.advance(1);
		expect(stall.blocked(timer.at())).toBe(false);
	});

	it("reports each of two blocks back to back", () => {
		const timer = fake();
		const stall = new Stall(timer);

		timer.advance(200);
		timer.block(300);
		expect(stall.blocked(timer.at())).toBe(true);

		// Barely any loop in between, which is what a content process under pressure does.
		timer.advance(10);
		timer.block(300);
		expect(stall.blocked(timer.at())).toBe(true);

		timer.advance(200);
		expect(stall.blocked(timer.at())).toBe(false);
	});

	it("ignores ordinary timer slack", () => {
		const timer = fake();
		const stall = new Stall(timer);

		// A busy page delivers its timers tens of milliseconds late without anything being wrong,
		// and discounting an arrival for that would throw away the path's own jitter.
		timer.advance(100);
		timer.block(80);
		expect(stall.blocked(timer.at())).toBe(false);

		stall.close();
	});

	it("a throttled timer on a running loop is not a block", () => {
		const timer = fake();
		const stall = new Stall(timer);

		// A hidden tab is rationed to one timer a second, and later to one a minute. Its loop keeps
		// running: the socket is read, the frames land on time, and every query below is answered.
		// Only the tick is late, and no path condition and no block put it there.
		timer.throttle(1000);

		let queried = 0;
		let blocked = 0;

		// Five seconds of arrivals at the frame rate, which is the spacing the estimator asks at.
		for (let i = 0; i < 250; i++) {
			timer.advance(20);
			queried++;
			if (stall.blocked(timer.at())) blocked++;
		}

		expect(queried).toBe(250);
		expect(blocked).toBe(0);

		// A real block on the same throttled timer, so a fix cannot pass by reporting nothing at all:
		// here the tick is late and nothing was queried while the loop was gone, which is the pair
		// "reports a block, and stops reporting it a tick later" covers on an unthrottled one.
		timer.block(400);
		expect(stall.blocked(timer.at())).toBe(true);

		stall.close();
	});

	it("a block during a throttled interval is still reported", () => {
		const timer = fake();
		const stall = new Stall(timer);

		// A tab hidden for long enough is rationed to one timer a minute, so a block inside that
		// minute ends with no tick anywhere near it and the next arrival read is the only witness.
		timer.throttle(60000);

		for (let i = 0; i < 50; i++) {
			timer.advance(20);
			expect(stall.blocked(timer.at())).toBe(false);
		}

		// Nothing at all for 400ms: no arrival read, no timer, which is what a block looks like from
		// the inside however late the tab's timers were already running.
		timer.block(400);
		expect(stall.blocked(timer.at())).toBe(true);

		stall.close();
	});

	it("a busy loop that keeps serving reads is still lagging", () => {
		const timer = fake();
		const stall = new Stall(timer);

		// Half a second of a loop with nothing wrong with it, read every 20ms.
		for (let i = 0; i < 25; i++) {
			timer.advance(20);
			expect(stall.blocked(timer.at())).toBe(false);
		}

		// The loop goes flat out: a keyframe to decode, a long paint, whatever a content process
		// does in bursts. It is still reading the socket, so every query below is answered on time
		// and a second track on the same monitor is being read throughout. What it is not doing is
		// getting to anything it queued, the monitor's tick and probe included, and the frames it
		// hands over at the end of this waited here rather than on the path.
		timer.busy(true);

		const flags: boolean[] = [];
		for (let i = 0; i < 15; i++) {
			timer.advance(20);
			flags.push(stall.blocked(timer.at()));
		}

		// Nothing can be known until a task has waited long enough to prove it, which is the
		// threshold plus however long the arrival before it left the loop unmeasured, i.e. a tick.
		const first = flags.indexOf(true);
		expect(first).toBeGreaterThanOrEqual(0);
		expect(first * 20).toBeLessThanOrEqual(100 + 50);

		// From there the answer holds for as long as the loop does: each query re-dates the block it
		// is still inside, so every arrival in the rest of the burst is discounted.
		expect(flags.slice(first).every((f) => f)).toBe(true);
		expect(flags.filter((f) => f).length).toBeGreaterThanOrEqual(8);

		timer.busy(false);
		stall.close();
	});

	it("posts nothing over a loop nobody is reading, and about one probe a tick over one they are", () => {
		const timer = fake();
		const stall = new Stall(timer);

		// Ten seconds of a loop no track is arriving on. There is nothing to protect, and a probe
		// that posted the next one from its own handler would be a loop spinning on itself for as
		// long as a consumer is alive.
		timer.advance(10_000);
		expect(timer.posts()).toBe(0);

		// Ten seconds of arrivals at the frame rate: 500 queries, and one probe a tick is the whole
		// cost of answering them.
		for (let i = 0; i < 500; i++) {
			timer.advance(20);
			stall.blocked(timer.at());
		}
		expect(timer.posts()).toBeGreaterThan(0);
		expect(timer.posts()).toBeLessThanOrEqual(10_000 / 50);

		// The ports go with the last holder; the smoke lane counts what a client leaves open.
		stall.close();
		expect(timer.released()).toBe(true);
	});

	it("answers for the arrival it is asked about, not for now", () => {
		const timer = fake();
		const stall = new Stall(timer);

		timer.advance(500);
		timer.block(400);
		const ended = timer.at();

		// One tick after the block is the burst it left behind; two ticks after it, the loop has
		// been running normally for a tick and the wait is the path's.
		expect(stall.blocked((ended + 50) as Time.Milli)).toBe(true);
		expect(stall.blocked((ended + 100) as Time.Milli)).toBe(false);

		stall.close();
	});

	it("sees a block that is still being served, whatever ran first", () => {
		const timer = fake();
		const stall = new Stall(timer);

		timer.advance(500);

		// The read loop beat the overdue timer out of the block, which nothing orders. The arrival
		// it stamps is still one the block held.
		expect(stall.blocked((timer.at() + 400) as Time.Milli)).toBe(true);

		stall.close();
	});

	it("runs one timer for every holder, and stops when the last one lets go", () => {
		const first = Stall.acquire();
		const second = Stall.acquire();
		expect(second).toBe(first);

		// Every consumer on a page watches the same event loop, so one of these is the whole cost.
		first.close();
		expect(Stall.acquire()).toBe(first);

		second.close();
		first.close();

		const restarted = Stall.acquire();
		expect(restarted).not.toBe(first);
		restarted.close();
	});
});

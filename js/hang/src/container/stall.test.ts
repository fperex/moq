import { describe, expect, it } from "bun:test";
import type { Time } from "@moq/net";
import { fakeTimer } from "./fake";
import { Stall } from "./stall";

describe("the event loop monitor", () => {
	it("reports nothing on a loop that keeps running", () => {
		const timer = fakeTimer();
		const stall = new Stall(timer);

		timer.advance(1000);
		expect(stall.blocked(timer.at())).toBe(false);

		stall.close();
	});

	it("reports a block, and stops reporting it a tick later", () => {
		const timer = fakeTimer();
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
		const timer = fakeTimer();
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
		const timer = fakeTimer();
		const stall = new Stall(timer);

		// A busy page delivers its timers tens of milliseconds late without anything being wrong,
		// and discounting an arrival for that would throw away the path's own jitter.
		timer.advance(100);
		timer.block(80);
		expect(stall.blocked(timer.at())).toBe(false);

		stall.close();
	});

	it("a throttled timer on a running loop is not a block", () => {
		const timer = fakeTimer();
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
		const timer = fakeTimer();
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
		const timer = fakeTimer();
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
		const timer = fakeTimer();
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

		// The ports go with the last holder; the media lane counts what a client leaves open.
		stall.close();
		expect(timer.released()).toBe(true);
	});

	it("answers for the arrival it is asked about, not for now", () => {
		const timer = fakeTimer();
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
		const timer = fakeTimer();
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

// Hidden tabs can throttle the timer below the cadence of healthy audio arrivals.
it("a rationed tick does not flag arrivals spaced under the idle threshold", () => {
	const timer = fakeTimer();
	const stall = new Stall(timer);

	timer.throttle(1000);
	// Long enough for the rationed tick to have run a few times.
	timer.advance(3000);

	const flags: boolean[] = [];
	for (let i = 0; i < 25; i++) {
		timer.advance(200);
		flags.push(stall.blocked(timer.at()));
	}

	// The track's own cadence has to be seen before a gap can be told apart from a block, so the
	// first two arrivals are allowed either answer. None after that is a block.
	expect({ flagged: flags.slice(2).filter((f) => f).length, of: flags.length - 2 }).toEqual({ flagged: 0, of: 23 });

	stall.close();
});

it("two blocks during a rationed tick do not become the arrival cadence", () => {
	const timer = fakeTimer();
	const stall = new Stall(timer);
	try {
		timer.throttle(1000);
		timer.advance(3000);
		for (let i = 0; i < 5; i++) {
			timer.advance(20);
			stall.blocked(timer.at());
		}
		for (let i = 0; i < 2; i++) {
			timer.block(400);
			expect(stall.blocked(timer.at())).toBe(true);
		}
	} finally {
		stall.close();
	}
});

for (const withProbe of [true, false]) {
	it(`a rationed tick does not flag healthy source bursts ${withProbe ? "with" : "without"} a probe`, () => {
		const timer = fakeTimer();
		const stall = new Stall(withProbe ? timer : { ...timer, probe: () => undefined });
		try {
			timer.throttle(1000);
			timer.advance(3000);
			const heads: boolean[] = [];
			for (let burst = 0; burst < 25; burst++) {
				timer.advance(162);
				heads.push(stall.blocked(timer.at()));
				// Each PES batch delivers seven frames. A running loop serves every probe between them.
				for (let frame = 1; frame < 7; frame++) {
					timer.advance(1);
					stall.blocked(timer.at());
				}
			}
			expect(heads.slice(2).filter(Boolean)).toEqual([]);
		} finally {
			stall.close();
		}
	});

	it(`a rationed tick still reports an unexpected gap ${withProbe ? "with" : "without"} a probe`, () => {
		const timer = fakeTimer();
		const stall = new Stall(withProbe ? timer : { ...timer, probe: () => undefined });
		try {
			timer.throttle(1000);
			for (let frame = 0; frame < 100; frame++) {
				timer.advance(33);
				expect(stall.blocked(timer.at())).toBe(false);
			}
			timer.block(150);
			expect(stall.blocked(timer.at())).toBe(true);
			timer.block(400);
			expect(stall.blocked(timer.at())).toBe(true);
		} finally {
			stall.close();
		}
	});
}

it("a rationed tick still reports a queued probe behind a busy receiver", () => {
	const timer = fakeTimer();
	const stall = new Stall(timer);
	try {
		timer.throttle(1000);
		// An ordinary frame cadence must not excuse a task that the receiver keeps waiting.
		for (let frame = 0; frame < 100; frame++) {
			timer.advance(33);
			expect(stall.blocked(timer.at())).toBe(false);
		}
		timer.busy(true);
		const flags: boolean[] = [];
		for (let frame = 0; frame < 20; frame++) {
			timer.advance(33);
			flags.push(stall.blocked(timer.at()));
		}
		expect(flags.slice(-10)).toEqual(Array(10).fill(true));
	} finally {
		timer.busy(false);
		stall.close();
	}
});

import { describe, expect, it } from "bun:test";
import type { Time } from "@moq/net";
import { Stall, type StallTimer } from "./stall";

/**
 * A clock the test moves by hand, with the monitor's timer on it.
 *
 * `advance` moves time and runs whatever was due, which is a loop that never blocks. `block` moves
 * time without running anything and then lets the timer catch up, which is a loop that did.
 */
function fake(): StallTimer & { advance(ms: number): void; block(ms: number): void; at(): Time.Milli } {
	let now = 0;
	let due: { at: number; fn: () => void } | undefined;

	const run = () => {
		while (due !== undefined && due.at <= now) {
			const fn = due.fn;
			due = undefined;
			fn();
		}
	};

	return {
		now: () => now,
		schedule: (fn, ms) => {
			due = { at: now + ms, fn };
			return due;
		},
		clear: () => {
			due = undefined;
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

import { afterEach, beforeEach, expect, jest, spyOn, test } from "bun:test";
import { stallFrom } from "./stall";

// The page's `window` is this realm's global here.
(globalThis as unknown as { window: typeof globalThis }).window = globalThis;

// A clock the busy loop spins on, one half millisecond per read, so a freeze takes no time at all and
// every wait below is a timer the test moves by hand.
let now = 0;

beforeEach(() => {
	jest.useFakeTimers();
	now = 0;
	spyOn(performance, "now").mockImplementation(() => {
		now += 0.5;
		return now;
	});
});

afterEach(() => {
	const chain = window.__benchStall;
	if (chain) {
		chain.live = false;
		if (chain.timer) clearTimeout(chain.timer);
	}
	window.__benchStall = undefined;
	jest.restoreAllMocks();
	jest.useRealTimers();
});

test("without ?stall the page is left alone", () => {
	stallFrom(new URLSearchParams("delay=auto"));
	jest.advanceTimersByTime(1_000);
	expect(window.__benchStall).toBeUndefined();
});

test("a malformed schedule throws rather than running a row without its load", () => {
	for (const query of [
		"stall=120",
		"stall=0/1500",
		"stall=1500/1500",
		"stall=a/b",
		"stall=120/1500&stallAt=-1",
		"stall=120/1500&stallAt=",
		"stall=120/1500&stallFor=soon",
		"stallAt=2",
		"stallFor=2",
	]) {
		expect(() => stallFrom(new URLSearchParams(query)), query).toThrow();
	}
	jest.advanceTimersByTime(1_000);
	expect(window.__benchStall).toBeUndefined();
});

test("freezes MS every EVERY, keeping the length of each freeze", () => {
	stallFrom(new URLSearchParams("stall=8/40"));
	// Scheduled, not run inside the call.
	expect(window.__benchStall).toBeUndefined();

	// The schedule starts the chain, which schedules its first freeze at once.
	jest.advanceTimersByTime(1);
	jest.advanceTimersByTime(1);
	const chain = window.__benchStall;
	expect(chain?.live).toBe(true);
	expect(chain?.stalls.length).toBe(1);
	const first = chain?.stalls[0];
	expect(first?.ms).toBeGreaterThanOrEqual(8);
	// Tenths of a millisecond.
	expect(Math.round((first?.ms ?? 0) * 10)).toBe((first?.ms ?? 0) * 10);

	// The next one starts EVERY after the last did, however long it held: the gap is what is left.
	const left = 40 - (first?.ms ?? 0);
	jest.advanceTimersByTime(left - 1);
	expect(chain?.stalls.length).toBe(1);
	jest.advanceTimersByTime(2);
	expect(chain?.stalls.length).toBe(2);
});

test("stallAt waits before the first freeze, and stallFor stops them and keeps the record", () => {
	stallFrom(new URLSearchParams("stall=5/20&stallAt=0.1&stallFor=0.1"));

	jest.advanceTimersByTime(99);
	expect(window.__benchStall).toBeUndefined();
	jest.advanceTimersByTime(2);
	expect(window.__benchStall?.live).toBe(true);

	jest.advanceTimersByTime(100);
	const chain = window.__benchStall;
	expect(chain?.live).toBe(false);
	const made = chain?.stalls.length ?? 0;
	expect(made).toBeGreaterThan(0);

	// Stopped for good, with the record left in place.
	jest.advanceTimersByTime(200);
	expect(window.__benchStall).toBe(chain);
	expect(chain?.stalls.length).toBe(made);
});

test("a chain a harness already started is left alone", () => {
	const started = { stalls: [], timer: null, live: true };
	window.__benchStall = started;
	stallFrom(new URLSearchParams("stall=5/20"));
	jest.advanceTimersByTime(60);
	expect(window.__benchStall).toBe(started);
	expect(started.stalls).toEqual([]);
});

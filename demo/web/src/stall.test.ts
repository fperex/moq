import { afterEach, expect, test } from "bun:test";
import { stallFrom } from "./stall";

// The page's `window` is this realm's global here.
(globalThis as unknown as { window: typeof globalThis }).window = globalThis;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Real timers throughout: the freeze is a busy loop on the clock, which fake timers would stop. Every
// wait therefore polls to a deadline instead of trusting a fixed sleep on a loaded machine.
async function until(ready: () => boolean): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!ready()) {
		if (Date.now() > deadline) throw new Error("timed out");
		await sleep(5);
	}
}

afterEach(() => {
	const chain = window.__benchStall;
	if (chain) {
		chain.live = false;
		if (chain.timer) clearTimeout(chain.timer);
	}
	window.__benchStall = undefined;
});

test("without ?stall the page is left alone", async () => {
	stallFrom(new URLSearchParams("delay=auto"));
	await sleep(20);
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
	expect(window.__benchStall).toBeUndefined();
});

test("freezes MS every EVERY, keeping each freeze as the bench's stallScript does", async () => {
	stallFrom(new URLSearchParams("stall=8/40"));
	// Scheduled, not run inside the call.
	expect(window.__benchStall).toBeUndefined();

	await until(() => (window.__benchStall?.stalls.length ?? 0) >= 3);
	const chain = window.__benchStall;
	expect(chain?.live).toBe(true);
	const stalls = chain?.stalls ?? [];
	for (const stall of stalls) {
		expect(stall.ms).toBeGreaterThanOrEqual(8);
		// Tenths of a millisecond, as the bench rounds them.
		expect(Math.round(stall.ms * 10)).toBe(stall.ms * 10);
	}
	// One starts every EVERY, however long the last one held: the gap after it is what is left.
	for (let i = 1; i < stalls.length; i++) {
		expect((stalls[i]?.t ?? 0) - (stalls[i - 1]?.t ?? 0)).toBeGreaterThanOrEqual(38);
	}
});

test("stallAt waits before the first freeze, and stallFor stops them and keeps the record", async () => {
	const started = Date.now();
	stallFrom(new URLSearchParams("stall=5/20&stallAt=0.1&stallFor=0.1"));

	await until(() => window.__benchStall !== undefined);
	expect(Date.now() - started).toBeGreaterThanOrEqual(95);

	await until(() => window.__benchStall?.live === false);
	const chain = window.__benchStall;
	const made = chain?.stalls.length ?? 0;
	expect(made).toBeGreaterThan(0);

	// Stopped for good, with the record left where the bench's stop script reads it.
	await sleep(60);
	expect(window.__benchStall).toBe(chain);
	expect(chain?.stalls.length).toBe(made);
});

test("a chain the bench already started is left alone", async () => {
	const bench = { stalls: [], timer: null, live: true };
	window.__benchStall = bench;
	stallFrom(new URLSearchParams("stall=5/20"));
	await sleep(60);
	expect(window.__benchStall).toBe(bench);
	expect(bench.stalls).toEqual([]);
});

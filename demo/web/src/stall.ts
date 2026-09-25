/**
 * Bench tool: freeze the page's main thread on a schedule, the way heavy video or layout does, so the
 * audio worker can be compared with the page's own audio under that load.
 *
 * The same loop as the bench's `stallScript`, kept where it keeps it: a synchronous busy loop `ms` long,
 * one starting every `every` ms from a `setTimeout` chain, each freeze's wall clock start and actual
 * length recorded on `window.__benchStall`. So the bench's stop script reads and stops this chain too,
 * and its start script leaves this one alone.
 *
 * @module
 */

/** One freeze: when it started (`Date.now()`) and how long it actually held the thread, in ms. */
interface Stall {
	t: number;
	ms: number;
}

/** A running chain, in the shape the bench keeps it. */
interface Chain {
	stalls: Stall[];
	timer: ReturnType<typeof setTimeout> | null;
	live: boolean;
}

declare global {
	interface Window {
		/** The running freeze chain, shared with the bench's scripts. */
		__benchStall?: Chain | null;
	}
}

/**
 * Freeze the main thread as the query asks: `stall=MS/EVERY` (like `120/1500`), from `stallAt` seconds
 * after load (default 0) for `stallFor` seconds (default: until the page goes). Nothing without `stall`.
 *
 * Throws on anything malformed, so a bench row cannot quietly run without the load it asked for.
 */
export function stallFrom(params: URLSearchParams): void {
	const value = params.get("stall");
	const at = seconds(params, "stallAt");
	const lasts = seconds(params, "stallFor");
	if (value === null) {
		if (at !== undefined || lasts !== undefined) throw new Error("?stallAt and ?stallFor need ?stall=MS/EVERY");
		return;
	}

	const match = /^(\d+)\/(\d+)$/.exec(value);
	if (!match) throw new Error(`?stall takes MS/EVERY, like 120/1500, not ${JSON.stringify(value)}`);
	const ms = Number(match[1]);
	const every = Number(match[2]);
	if (!(ms > 0) || !(every > ms)) throw new Error(`?stall=${value}: MS must be positive and below EVERY`);

	setTimeout(() => start(ms, every), (at ?? 0) * 1000);
	if (lasts !== undefined) setTimeout(stop, ((at ?? 0) + lasts) * 1000);
}

// A non-negative number of seconds, or undefined when absent.
function seconds(params: URLSearchParams, name: string): number | undefined {
	const value = params.get(name);
	if (value === null) return undefined;
	const parsed = Number(value);
	if (value.trim() === "" || !Number.isFinite(parsed) || parsed < 0) {
		throw new Error(`?${name} takes seconds, not ${JSON.stringify(value)}`);
	}
	return parsed;
}

// Start the chain, unless one is running already.
function start(ms: number, every: number): void {
	if (window.__benchStall) return;
	const chain: Chain = { stalls: [], timer: null, live: true };
	window.__benchStall = chain;

	const tick = () => {
		if (!chain.live) return;
		const t = Date.now();
		const begun = performance.now();
		while (performance.now() - begun < ms) {}
		const took = performance.now() - begun;
		if (chain.stalls.length < 10_000) chain.stalls.push({ t, ms: Math.round(took * 10) / 10 });
		chain.timer = setTimeout(tick, Math.max(0, every - took));
	};
	chain.timer = setTimeout(tick, 0);
}

// Stop the running chain, and leave its record where the bench's stop script reads it.
function stop(): void {
	const chain = window.__benchStall;
	if (!chain) return;
	chain.live = false;
	if (chain.timer) clearTimeout(chain.timer);
	chain.timer = null;
}

/**
 * What the page's main thread pays for the reports of the players its worker feeds: the pool routing a
 * report to its player, the Remote applying it to `Sync` and to its outputs, and every effect that runs
 * on it through the Decoder, `Sync` and the Player's wiring. Swept over the players on the page and the
 * rate each reports at, so a cost that grows with the page's players instead of with the one report
 * shows up as a slope in the per-report column.
 *
 * `just js remote-bench` prints the table. It asserts nothing about time; `src/audio/worker/remote.test.ts`
 * holds the slope to zero by counting the work instead.
 */
import { mock } from "bun:test";
import { globals, immediate, page, report } from "../src/audio/fake";

mock.module("../src/audio/render-worklet.ts?worklet", () => ({ default: async () => "blob:render-worklet" }));
mock.module("../src/audio/worker/worker.ts?worklet", () => ({ default: async () => "blob:audio-worker" }));

interface Row {
	players: number;
	interval: number;
	/** Page time per report, in microseconds. */
	perReport: number;
	/** Page time per second of reports, in milliseconds: what it costs the main thread. */
	perSecond: number;
}

/** Feed `seconds` of reports from every player at `interval`, after one second of warm-up. */
async function measure(players: number, interval: number, seconds = 2): Promise<Row> {
	const { worker, ids, close } = await page(players);
	try {
		const warm = 1_000 / interval;
		const steps = (seconds * 1_000) / interval;
		let index = 1;
		for (; index <= warm; index++) {
			for (const id of ids) worker.say(report(id, index, interval));
			await immediate();
		}

		let spent = 0;
		for (let step = 0; step < steps; step++, index++) {
			const started = performance.now();
			for (const id of ids) worker.say(report(id, index, interval));
			// The effects each report sets off run in the microtasks that follow it, which this drains.
			await immediate();
			spent += performance.now() - started;
		}

		const reports = players * steps;
		return { players, interval, perReport: (spent / reports) * 1_000, perSecond: spent / seconds };
	} finally {
		close();
	}
}

const restore = globals();

// One run thrown away, so the first row is not the just-in-time compiler's first pass.
await measure(4, 20);

console.log("players  interval  per report  per second of reports");
for (const interval of [50, 20, 10]) {
	for (const players of [1, 2, 4, 8, 16, 32, 64, 100]) {
		const row = await measure(players, interval);
		console.log(
			`${String(row.players).padStart(7)}  ${`${row.interval} ms`.padStart(8)}  ${`${row.perReport.toFixed(1)} us`.padStart(10)}  ${`${row.perSecond.toFixed(2)} ms`.padStart(21)}`,
		);
	}
}

restore();

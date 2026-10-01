import { afterAll, beforeAll, expect, it, mock, spyOn } from "bun:test";
import type { Time } from "@moq/net";
import { Sync } from "../../sync";
import { FakeWorker, globals, immediate, page, report } from "../fake";

mock.module("../render-worklet.ts?worklet", () => ({ default: "blob:render-worklet" }));
mock.module("./worker.ts?worker&inline", () => ({ default: FakeWorker }));

let restore: (() => void) | undefined;
beforeAll(() => {
	restore = globals();
});
afterAll(() => restore?.());

const INTERVAL = 50;

/**
 * The work one report to one player sets off on a page of `count`: the notifications of every output
 * each player's Decoder and `Sync` publish, and the frames each `Sync` was told about.
 *
 * Counted rather than timed, so the answer is the same on any machine. The frames are stamped as read
 * one interval apart, in step with their media, so how long the page takes cannot move the playhead.
 */
async function work(count: number) {
	const { worker, ids, players, close } = await page(count);
	try {
		const at = (index: number) => performance.timeOrigin + index * INTERVAL;
		for (let index = 1; index <= 20; index++) {
			for (const id of ids) worker.say(report(id, index, INTERVAL, at(index)));
			await immediate();
		}

		const notified = players.map(() => 0);
		const disposes = players.flatMap(({ decoder, sync }, player) =>
			[...Object.values(decoder.out), ...Object.values(sync.out)].map((signal) =>
				signal.subscribe(() => notified[player]++),
			),
		);
		const told = new Map<Sync, number>();
		const received = Sync.prototype.received;
		const spy = spyOn(Sync.prototype, "received").mockImplementation(function (
			this: Sync,
			timestamp: Time.Milli,
			label?: string,
			at?: Time.Milli,
		) {
			told.set(this, (told.get(this) ?? 0) + 1);
			received.call(this, timestamp, label, at);
		});

		const one = report(ids[0], 21, INTERVAL, at(21));
		worker.say(one);
		await immediate();

		spy.mockRestore();
		for (const dispose of disposes) dispose();
		return { notified: notified.filter((n) => n > 0), told: [...told.values()], arrivals: one.arrivals.length };
	} finally {
		close();
	}
}

it("costs a report the same work however many players share the worker", async () => {
	const alone = await work(1);
	expect(alone.notified).toHaveLength(1);
	expect(alone.told).toEqual([alone.arrivals]);

	// Only the player the report is for hears of it, and it does exactly what it does alone.
	for (const count of [16, 100]) expect(await work(count)).toEqual(alone);
});

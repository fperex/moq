import { afterAll, beforeAll, expect, it, mock } from "bun:test";
import type * as Catalog from "@moq/hang/catalog";
import { Origin, Path, Time } from "@moq/net";
import { Effect } from "@moq/signals";
import type { Snapshot } from "../playout";
import type { FromWorker, Report, ToWorker } from "./protocol";

// What the page's main thread pays for the reports of the players its worker feeds: the pool routing a
// report to its player, the Remote applying it to `Sync` and to its outputs, and every effect that runs on
// it through the Decoder, `Sync` and the Player's wiring. Swept over the players on the page and the rate
// each reports at, so a cost that grows with the page's players instead of with the one report shows up
// as a slope in the per-report column.
//
// The worker is a stand-in that says ready and nothing else: the reports are made here, one per player
// per interval, each carrying the frames that interval holds and a moving clock, as the host sends them.

mock.module("../render-worklet.ts?worklet", () => ({ default: "blob:render-worklet" }));

/** A dedicated worker that is ready at once and says only what the bench makes it say. */
class FakeWorker {
	static created: FakeWorker[] = [];
	onmessage: ((event: MessageEvent<FromWorker>) => void) | null = null;
	onerror: ((event: ErrorEvent) => void) | null = null;
	onmessageerror: (() => void) | null = null;
	readonly players = new Set<number>();

	constructor() {
		FakeWorker.created.push(this);
		setImmediate(() =>
			this.say({ type: "ready", support: { audioDecoder: true, webTransport: false, webSocket: true } }),
		);
	}

	postMessage(msg: ToWorker): void {
		if (msg.type === "player") this.players.add(msg.id);
	}

	terminate(): void {}

	say(msg: FromWorker): void {
		this.onmessage?.({ data: msg } as MessageEvent<FromWorker>);
	}
}

mock.module("./worker.ts?worker&inline", () => ({ default: FakeWorker }));

const { Decoder } = await import("../decoder");
const { Source } = await import("../source");
const { Sync } = await import("../../sync");
const { Broadcast } = await import("../../broadcast");
const { resetShared } = await import("./remote");

const RATE = 48_000;
const FRAME = 20;

class Context extends EventTarget {
	state = "running";
	readonly sampleRate = RATE;
	readonly audioWorklet = { addModule: () => Promise.resolve() };
	resume(): Promise<void> {
		return Promise.resolve();
	}
	close(): Promise<void> {
		return Promise.resolve();
	}
	getOutputTimestamp(): AudioTimestamp {
		return { contextTime: performance.now() / 1_000, performanceTime: performance.now() };
	}
}

class Node {
	readonly port = new MessageChannel().port1;
	connect(): void {}
	disconnect(): void {}
}

const scope = globalThis as unknown as Record<string, unknown>;
const NAMES = ["AudioContext", "AudioWorkletNode", "document"];
const saved = new Map<string, PropertyDescriptor | undefined>();

beforeAll(() => {
	for (const name of NAMES) saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
	scope.AudioContext = Context;
	scope.AudioWorkletNode = Node;
	scope.document = new EventTarget();
});

afterAll(() => {
	resetShared();
	for (const [name, descriptor] of saved) {
		if (descriptor) Object.defineProperty(globalThis, name, descriptor);
		else Reflect.deleteProperty(globalThis, name);
	}
});

const immediate = () => new Promise<void>((resolve) => setImmediate(resolve));

const CATALOG = {
	audio: {
		renditions: { audio: { codec: "opus", container: { kind: "legacy" }, sampleRate: RATE, numberOfChannels: 2 } },
	},
} as unknown as Catalog.Root;

/** `count` players on one page, each an offloaded Decoder wired into its own `Sync` as the Player wires it. */
async function page(count: number) {
	resetShared();
	FakeWorker.created = [];
	const origin = new Origin.Producer();
	const published = origin.createBroadcast(Path.from("room/alice"));
	published.createTrack("audio");
	published.announce();

	const players = Array.from({ length: count }, () => {
		const broadcast = new Broadcast({
			origin,
			name: Path.from("room/alice"),
			catalogFormat: "manual",
			catalog: CATALOG,
		});
		const source = new Source({ broadcast, supported: async () => true });
		const sync = new Sync();
		const decoder = new Decoder({ source, sync, url: new URL("https://relay.example/anon"), offload: true });
		const wiring = new Effect();
		wiring.proxy(sync.track("audio").spread, decoder.out.spread);
		return {
			decoder,
			close: () => {
				wiring.close();
				decoder.close();
				sync.close();
				source.close();
				broadcast.close();
			},
		};
	});

	for (let i = 0; i < 1_000 && (FakeWorker.created[0]?.players.size ?? 0) < count; i++) await immediate();
	const [worker] = FakeWorker.created;
	if (worker?.players.size !== count) throw new Error(`${worker?.players.size ?? 0} of ${count} players started`);

	return {
		worker,
		ids: [...worker.players],
		close: () => {
			for (const player of players) player.close();
			published.close();
			origin.close();
		},
	};
}

/** One report, as the host sends it `interval` ms after the previous one, `index` intervals in. */
function report(id: number, index: number, interval: number): Report {
	const at = performance.timeOrigin + performance.now();
	const media = index * interval;
	const arrivals = [];
	for (let t = media - interval + FRAME; t <= media; t += FRAME) arrivals.push({ timestamp: Time.Milli(t), at });
	const output = (media * RATE) / 1_000;
	return {
		type: "report",
		id,
		epoch: 0,
		timeline: 0,
		clock: { timestamp: Time.Micro.fromMilli(Time.Milli(media - 80)), at, rate: 1 },
		arrivals,
		spread: Time.Milli(40),
		rate: undefined,
		ring: {
			timestamp: Time.Micro.fromMilli(Time.Milli(media - 80)),
			stalled: false,
			underruns: 0,
			debug: { buffered: 3_840, target: 3_840, output, fresh: false, stalled: false } as unknown as Snapshot,
		},
		stats: { bytesReceived: index * 120 },
		skipped: 0,
		buffered: [{ start: Time.Milli(media - 80), end: Time.Milli(media) }],
		connection: "connected",
		transport: "webtransport",
		resolved: true,
	};
}

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

it("costs the page the same per report however many players share the worker", async () => {
	// One run thrown away, so the first row is not the just-in-time compiler's first pass.
	await measure(4, 20);

	const rows: Row[] = [];
	for (const interval of [50, 20, 10]) {
		for (const players of [1, 2, 4, 8, 16]) rows.push(await measure(players, interval));
	}

	console.log("players  interval  per report  per second of reports");
	for (const row of rows) {
		console.log(
			`${String(row.players).padStart(7)}  ${`${row.interval} ms`.padStart(8)}  ${`${row.perReport.toFixed(1)} us`.padStart(10)}  ${`${row.perSecond.toFixed(2)} ms`.padStart(21)}`,
		);
	}

	for (const interval of [50, 20, 10]) {
		const at = (players: number) => rows.find((row) => row.players === players && row.interval === interval);
		const one = at(1);
		const sixteen = at(16);
		if (!one || !sixteen) throw new Error("missing a row");
		// No slope with the page's players: a report costs what it costs whoever else is on the worker. The
		// ratio is loose because one player's timings are a handful of samples against a bun process's pauses.
		expect(sixteen.perReport).toBeLessThan(3 * one.perReport + 20);
	}

	// Sixteen players at the host's own cadence cost the page's main thread well under a twentieth of it.
	const busiest = rows.find((row) => row.players === 16 && row.interval === 50);
	expect(busiest?.perSecond).toBeLessThan(50);
}, 120_000);

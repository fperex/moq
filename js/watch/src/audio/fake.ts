/**
 * Fakes the audio tests share.
 *
 * @internal Test support, not part of the player.
 */
import type * as Catalog from "@moq/hang/catalog";
import { Origin, Path, Time } from "@moq/net";
import { Effect } from "@moq/signals";
import type { Snapshot } from "./playout";
import type { FromWorker, Report, ToWorker } from "./worker/protocol";

const RATE = 48_000;
const FRAME = 20;

/** A dedicated worker that is ready at once and says only what the caller makes it say. */
export class FakeWorker {
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

/**
 * A render node whose processor does what the render worklet does with its ports: it stops in the
 * quantum after the page says close, which a running context renders at once, says so on the node's
 * port, and closes every port it holds.
 */
class Node {
	readonly #channel = new MessageChannel();
	readonly port = this.#channel.port1;

	constructor() {
		const processor = this.#channel.port2;
		const ports: MessagePort[] = [processor];
		processor.onmessage = (event: MessageEvent<{ type?: string; port?: MessagePort }>) => {
			if (event.data?.type === "port" && event.data.port) ports.push(event.data.port);
			if (event.data?.type !== "close") return;
			processor.postMessage({ type: "stopped" });
			for (const port of ports) port.close();
		};
	}

	connect(): void {}
	disconnect(): void {}
}

/** Give the page a running audio device and a document, returning what puts the real ones back. */
export function globals(): () => void {
	const scope = globalThis as unknown as Record<string, unknown>;
	const names = ["AudioContext", "AudioWorkletNode", "document"];
	const saved = names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
	scope.AudioContext = Context;
	scope.AudioWorkletNode = Node;
	scope.document = new EventTarget();
	return () => {
		for (const [name, descriptor] of saved) {
			if (descriptor) Object.defineProperty(globalThis, name, descriptor);
			else Reflect.deleteProperty(globalThis, name);
		}
	};
}

/** Let every microtask a message set off run, and a task besides. */
export const immediate = () => new Promise<void>((resolve) => setImmediate(resolve));

const CATALOG = {
	audio: {
		renditions: { audio: { codec: "opus", container: { kind: "legacy" }, sampleRate: RATE, numberOfChannels: 2 } },
	},
} as unknown as Catalog.Root;

/**
 * `count` players on one page, each an offloaded Decoder wired into its own `Sync` as the Player wires
 * it, fed by a {@link FakeWorker}.
 *
 * Mock `worker/worker.ts?worker&inline` with {@link FakeWorker}, and the render worklet, before calling
 * this: it imports the player's modules only when called.
 */
export async function page(count: number) {
	const { Decoder } = await import("./decoder");
	const { Source } = await import("./source");
	const { Sync } = await import("../sync");
	const { Broadcast } = await import("../broadcast");
	const { resetShared } = await import("./worker/remote");

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
			sync,
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
		players,
		close: () => {
			for (const player of players) player.close();
			published.close();
			origin.close();
			resetShared();
		},
	};
}

/**
 * One report, as the host sends it `interval` ms after the previous one, `index` intervals in, for
 * frames the worker read at `at` (`performance.timeOrigin` based).
 */
export function report(
	id: number,
	index: number,
	interval: number,
	at = performance.timeOrigin + performance.now(),
): Report {
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

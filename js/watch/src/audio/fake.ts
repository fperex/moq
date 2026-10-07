/**
 * Fakes the audio tests share: WebCodecs, the relay session the worker dials, the worker itself, and a
 * clock the test moves by hand.
 *
 * @internal Test support, not part of the player.
 */
import type * as Catalog from "@moq/hang/catalog";
import type * as Moq from "@moq/net";
import { Origin, Path, Time } from "@moq/net";
import { Signal } from "@moq/signals";
import type { Snapshot } from "./playout";
import type { Session } from "./worker/host";
import type { FromWorker, Report, Support, ToWorker, Transports } from "./worker/protocol";

const RATE = 48_000;
const FRAME = 20;

// ── WebCodecs, enough of it ─────────────────────────────────────────────────

export class FakeChunk {
	readonly timestamp: number;
	constructor(init: { timestamp: number }) {
		this.timestamp = init.timestamp;
	}
}

/** One 20 ms stereo packet of a constant, stamped from the chunk that produced it. */
export class FakeAudioData {
	readonly format = "f32-planar";
	readonly sampleRate = RATE;
	readonly numberOfFrames = 960;
	readonly numberOfChannels = 2;
	readonly timestamp: number;
	constructor(timestamp: number) {
		this.timestamp = timestamp;
	}
	copyTo(dst: Float32Array): void {
		dst.fill(0.5);
	}
	close(): void {}
}

export class FakeDecoder {
	/** The codecs this realm's decoder turns down. */
	static refuse = new Set<string>();

	state = "configured";
	readonly #output: (data: FakeAudioData) => void;
	constructor(init: { output: (data: FakeAudioData) => void }) {
		this.#output = init.output;
	}
	static async isConfigSupported(config: { codec: string }): Promise<{ supported: boolean }> {
		return { supported: !FakeDecoder.refuse.has(config.codec) };
	}
	configure(): void {}
	decode(chunk: FakeChunk): void {
		this.#output(new FakeAudioData(chunk.timestamp));
	}
	reset(): void {}
	close(): void {
		this.state = "closed";
	}
	async flush(): Promise<void> {}
}

// ── the relay ───────────────────────────────────────────────────────────────

/** A session as the worker's host sees one, reading from an origin in this process. */
export class FakeSession implements Session {
	readonly origin: Signal<Moq.Origin.Table | undefined>;
	readonly status: Signal<Moq.Connection.Status> = new Signal<Moq.Connection.Status>("connected");
	readonly transport: Signal<Moq.Connection.Transport | undefined> = new Signal<Moq.Connection.Transport | undefined>(
		"webtransport",
	);
	readonly enabled = new Signal(true);
	readonly url: URL;
	readonly transports: Transports;
	closed = false;

	constructor(url: URL, transports: Transports, origin: Moq.Origin.Table) {
		this.url = url;
		this.transports = transports;
		this.origin = new Signal<Moq.Origin.Table | undefined>(origin);
	}

	close(): void {
		this.closed = true;
	}
}

// ── the worker ──────────────────────────────────────────────────────────────

const SUPPORT: Support = { audioDecoder: true, webTransport: true, webSocket: true };

/**
 * A dedicated worker as the page drives one: it records what it is told, and says what the test makes
 * it say.
 */
export class FakeWorker {
	static created: FakeWorker[] = [];
	/** What a worker created now says it supports once it is ready, or undefined to say nothing. */
	static support: Support | undefined = SUPPORT;

	onmessage: ((event: MessageEvent<FromWorker>) => void) | null = null;
	onerror: ((event: ErrorEvent) => void) | null = null;
	onmessageerror: (() => void) | null = null;
	posted: Array<{ msg: ToWorker; transfer: Transferable[] }> = [];
	terminated = false;

	constructor() {
		FakeWorker.created.push(this);
		// A task, as a real worker's first message is: never inside the tick that created it.
		const support = FakeWorker.support;
		if (support) setTimeout(() => this.say({ type: "ready", support }), 0);
	}

	postMessage(msg: ToWorker, transfer: Transferable[] = []): void {
		this.posted.push({ msg, transfer });
	}

	terminate(): void {
		this.terminated = true;
	}

	say(msg: FromWorker): void {
		this.onmessage?.({ data: msg } as MessageEvent<FromWorker>);
	}

	fail(message: string): void {
		this.onerror?.({ message, preventDefault() {} } as ErrorEvent);
	}

	get asWorker(): Worker {
		return this as unknown as Worker;
	}

	/** What it was told, less the handshake. */
	get told(): ToWorker[] {
		return this.posted.flatMap(({ msg }) => (msg.type === "hello" ? [] : [msg]));
	}

	/** The players it was told about, in order. */
	get players(): number[] {
		return this.told.flatMap((msg) => (msg.type === "player" ? [msg.id] : []));
	}
}

/** Let every microtask a message set off run, and a task besides. */
export const immediate = () => new Promise<void>((resolve) => setImmediate(resolve));

// ── a page of players ───────────────────────────────────────────────────────

class Context extends EventTarget {
	state = "running";
	readonly sampleRate = RATE;
	readonly audioWorklet = { addModule: () => Promise.resolve() };
	resume(): Promise<void> {
		return Promise.resolve();
	}
	suspend(): Promise<void> {
		return Promise.resolve();
	}
	close(): Promise<void> {
		return Promise.resolve();
	}
	getOutputTimestamp(): AudioTimestamp {
		return { contextTime: performance.now() / 1_000, performanceTime: performance.now() };
	}
}

/** A render node whose port takes what the page posts to it and closes every port it is handed. */
class Node {
	readonly #channel = new MessageChannel();
	readonly port = this.#channel.port1;

	constructor() {
		const processor = this.#channel.port2;
		const ports: MessagePort[] = [processor];
		processor.onmessage = (event: MessageEvent<{ type?: string; port?: MessagePort }>) => {
			if (event.data?.type === "port" && event.data.port) ports.push(event.data.port);
			if (event.data?.type !== "close") return;
			for (const port of ports) port.close();
		};
	}

	connect(): void {}
	disconnect(): void {}
}

/** Give the page a running audio device, a document and the fake worker, returning what puts the real ones back. */
export function globals(): () => void {
	const scope = globalThis as unknown as Record<string, unknown>;
	const names = ["AudioContext", "AudioWorkletNode", "Worker", "document"];
	const saved = names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
	scope.AudioContext = Context;
	scope.AudioWorkletNode = Node;
	scope.Worker = FakeWorker;
	scope.document = new EventTarget();
	return () => {
		for (const [name, descriptor] of saved) {
			if (descriptor) Object.defineProperty(globalThis, name, descriptor);
			else Reflect.deleteProperty(globalThis, name);
		}
	};
}

const CATALOG = {
	audio: {
		renditions: { audio: { codec: "opus", container: { kind: "legacy" }, sampleRate: RATE, numberOfChannels: 2 } },
	},
} as unknown as Catalog.Root;

/**
 * `count` players on one page, each an offloaded Decoder wired into its own `Sync`, fed by a
 * {@link FakeWorker}.
 *
 * Mock `worker/worker.ts?worklet` and the render worklet, and install {@link globals}, before calling
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
	FakeWorker.support = SUPPORT;
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
		return {
			decoder,
			sync,
			close: () => {
				decoder.close();
				sync.close();
				source.close();
				broadcast.close();
			},
		};
	});

	const started = () => FakeWorker.created[0]?.players.length ?? 0;
	for (let i = 0; i < 1_000 && started() < count; i++) await new Promise((resolve) => setTimeout(resolve, 0));
	const [worker] = FakeWorker.created;
	if (started() !== count) throw new Error(`${started()} of ${count} players started`);

	return {
		worker,
		ids: worker.players,
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
		measured: Time.Milli(40),
		frame: Time.Milli(FRAME),
		rate: undefined,
		ring: {
			timestamp: Time.Micro.fromMilli(Time.Milli(media - 80)),
			stalled: false,
			underruns: 0,
			debug: { buffered: 3_840, target: 3_840, output, stalled: false } as unknown as Snapshot,
		},
		stats: { bytesReceived: index * 120 },
		buffered: [{ start: Time.Milli(media - 80), end: Time.Milli(media) }],
		connection: "connected",
		transport: "webtransport",
		resolved: true,
	};
}

// ── the clock ───────────────────────────────────────────────────────────────

/**
 * Stub `performance.now()`, which `Time.Milli.now()` reads on every call, with a clock the test moves
 * by hand. Timers and microtasks stay real; `restore` puts the real clock back.
 */
export function fakeClock(start = 1000) {
	const real = performance.now.bind(performance);
	let at = start;
	performance.now = () => at;
	return {
		get at(): Time.Milli {
			return Time.Milli(at);
		},
		advance(ms: number) {
			at += ms;
		},
		set(ms: number) {
			at = ms;
		},
		restore() {
			performance.now = real;
		},
	};
}

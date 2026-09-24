import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest, mock, spyOn } from "bun:test";
import type * as Catalog from "@moq/hang/catalog";
import type * as Moq from "@moq/net";
import { Group, Origin, Path, Time, Varint } from "@moq/net";
import { Effect, Signal } from "@moq/signals";
import type { Broadcast as BroadcastType } from "../broadcast";
import type { Clock, Delay, Sync as SyncType } from "../sync";
import type { Decoder as DecoderType } from "./decoder";
import type { Source as SourceType } from "./source";
import type { Dial, Port as HostPort, Session } from "./worker/host";
import type { FromWorker, ToWorker, Transports } from "./worker/protocol";

// The Decoder with its supply in the page's worker, end to end in one process: the real host behind
// the mocked `?worker&inline` import, a real `MessageChannel` for the worker boundary, two in-memory
// origins (the page's own session, and the relay the worker dials), and the real render worklet behind
// the node the Decoder builds. Only WebCodecs and the AudioContext are faked. What a thread boundary
// does to timing is the browser rows' question; this is whether the page plays through the worker and
// hears everything it needs, and never downloads the audio twice.

mock.module("./render-worklet.ts?worklet", () => ({ default: "blob:render-worklet" }));

const RATE = 48_000;
const QUANTUM = 128;
const NAME = "room/alice";
const URL_ = "https://relay.example/anon";

// ── WebCodecs, enough of it ─────────────────────────────────────────────────

class FakeChunk {
	readonly timestamp: number;
	constructor(init: { timestamp: number }) {
		this.timestamp = init.timestamp;
	}
}

/** One 20 ms stereo packet of a constant, stamped from the chunk that produced it. */
class FakeAudioData {
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

class FakeDecoder {
	state = "configured";
	readonly #output: (data: FakeAudioData) => void;
	constructor(init: { output: (data: FakeAudioData) => void }) {
		this.#output = init.output;
	}
	static async isConfigSupported(): Promise<{ supported: boolean }> {
		return { supported: true };
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

// ── the page's graph ────────────────────────────────────────────────────────

interface Processor {
	process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean;
}

const scope = globalThis as unknown as Record<string, unknown>;
const NAMES = [
	"AudioWorkletProcessor",
	"registerProcessor",
	"currentFrame",
	"sampleRate",
	"AudioContext",
	"AudioWorkletNode",
	"AudioDecoder",
	"AudioEncoder",
	"EncodedAudioChunk",
	"crossOriginIsolated",
	"document",
	"window",
];
const saved = new Map<string, PropertyDescriptor | undefined>();
let Render: (new () => Processor) | undefined;
let nextPort: MessagePort | undefined;

/** An AudioContext the autoplay policy starts, whose output clock is the render clock. */
class MockContext extends EventTarget {
	state = "suspended";
	readonly sampleRate: number;
	readonly audioWorklet = { addModule: () => Promise.resolve() };

	constructor(options?: { sampleRate?: number }) {
		super();
		this.sampleRate = options?.sampleRate ?? RATE;
	}

	resume(): Promise<void> {
		this.state = "running";
		this.dispatchEvent(new Event("statechange"));
		return Promise.resolve();
	}

	close(): Promise<void> {
		this.state = "closed";
		return Promise.resolve();
	}

	getOutputTimestamp(): AudioTimestamp {
		if (this.state !== "running") return { contextTime: 0, performanceTime: 0 };
		return { contextTime: (scope.currentFrame as number) / RATE, performanceTime: performance.now() };
	}
}

/** The worklet node: a real render worklet behind a real port, as the page's AudioWorkletNode has. */
class Node {
	static built: Node[] = [];
	readonly port: MessagePort;
	readonly render: Processor;

	constructor() {
		if (!Render) throw new Error("render-worklet.ts registered no 'render' processor");
		const { port1, port2 } = new MessageChannel();
		nextPort = port2;
		this.render = new Render();
		this.port = port1;
		Node.built.push(this);
	}

	connect(): void {}
	disconnect(): void {}
}

/** Pull `quanta` render quanta of stereo out of `node` and return the left channel. */
function pull(node: Node, quanta: number): Float32Array {
	const out = new Float32Array(quanta * QUANTUM);
	for (let i = 0; i < quanta; i++) {
		const left = new Float32Array(QUANTUM);
		node.render.process([], [[left, new Float32Array(QUANTUM)]], {});
		out.set(left, i * QUANTUM);
		scope.currentFrame = (scope.currentFrame as number) + QUANTUM;
	}
	return out;
}

const loudest = (samples: Float32Array) => samples.reduce((max, v) => Math.max(max, Math.abs(v)), 0);

// ── the relay, in memory ────────────────────────────────────────────────────

/** A session as the host sees one, reading from an origin in this process. */
class FakeSession implements Session {
	readonly origin: Signal<Moq.Origin.Table | undefined>;
	readonly status = new Signal<Moq.Connection.Status>("connected");
	readonly transport = new Signal<Moq.Connection.Transport | undefined>("webtransport");
	readonly enabled = new Signal(true);
	readonly url: URL;
	closed = false;

	constructor(url: URL, origin: Moq.Origin.Table) {
		this.url = url;
		this.origin = new Signal<Moq.Origin.Table | undefined>(origin);
	}

	close(): void {
		this.closed = true;
	}
}

/** One broadcast with audio tracks, counting the subscriptions each track has and has had. */
class Publisher {
	readonly broadcast: Moq.Broadcast.Producer;
	readonly #tracks = new Map<string, { producer: Moq.Track.Producer; live: number; total: number }>();

	constructor(origin: Origin.Producer, tracks: string[]) {
		this.broadcast = origin.createBroadcast(Path.from(NAME));
		for (const name of tracks) {
			const producer = this.broadcast.createTrack(name);
			const counts = { producer, live: 0, total: 0 };
			const subscribe = producer.subscribe.bind(producer);
			producer.subscribe = (options?: Parameters<typeof subscribe>[0]) => {
				const subscriber = subscribe(options);
				counts.live++;
				counts.total++;
				const close = subscriber.close.bind(subscriber);
				let closed = false;
				subscriber.close = () => {
					if (!closed) counts.live--;
					closed = true;
					close();
				};
				return subscriber;
			};
			this.#tracks.set(name, counts);
		}
		this.broadcast.announce();
	}

	/** Subscriptions open on `track` now. */
	live(track = "audio"): number {
		return this.#tracks.get(track)?.live ?? 0;
	}

	/** Subscriptions ever opened on `track`. */
	total(track = "audio"): number {
		return this.#tracks.get(track)?.total ?? 0;
	}

	write(sequence: number, timestamp: number, track = "audio"): void {
		const producer = this.#tracks.get(track)?.producer;
		if (!producer) throw new Error(`no track ${track}`);
		const group = new Group.Producer(sequence);
		const ts = Varint.encode(timestamp);
		const payload = new Uint8Array(ts.byteLength + 2);
		payload.set(ts, 0);
		payload.set([0xde, 0xad], ts.byteLength);
		group.writeFrame({ payload, timestamp: Time.Timestamp.now() });
		group.close();
		producer.writeGroup(group);
	}

	close(): void {
		this.broadcast.close();
	}
}

/** The relay the worker dials: an origin, and every session dialled to it. */
class Relay {
	readonly origin = new Origin.Producer();
	readonly sessions: FakeSession[] = [];
	readonly dial: Dial = (url: URL, _transports: Transports) => {
		const session = new FakeSession(url, this.origin);
		this.sessions.push(session);
		return session;
	};
}

// The relay the in-process worker dials in the current case.
let relay = new Relay();

// ── the worker, in this process ─────────────────────────────────────────────

/** A dedicated worker as the pool drives one: the real host behind a `MessageChannel`. */
class InProcessWorker {
	static created: InProcessWorker[] = [];

	onmessage: ((event: MessageEvent<FromWorker>) => void) | null = null;
	onerror: ((event: ErrorEvent) => void) | null = null;
	onmessageerror: (() => void) | null = null;
	/** What the page told it, in order. */
	readonly posted: ToWorker[] = [];
	terminated = false;
	readonly #port: MessagePort;
	readonly #stop: () => void;

	constructor() {
		const { port1, port2 } = new MessageChannel();
		this.#stop = serve(port2 as unknown as HostPort, { dial: relay.dial });
		this.#port = port1;
		port1.onmessage = (event: MessageEvent<FromWorker>) => this.onmessage?.(event);
		InProcessWorker.created.push(this);
	}

	postMessage(msg: ToWorker, transfer: Transferable[] = []): void {
		this.posted.push(msg);
		this.#port.postMessage(msg, transfer);
	}

	terminate(): void {
		if (this.terminated) return;
		this.terminated = true;
		this.#stop();
		this.#port.close();
	}

	/** Say `msg` to the page as the worker would, out of turn. */
	say(msg: FromWorker): void {
		this.onmessage?.({ data: msg } as MessageEvent<FromWorker>);
	}

	/** The messages of one type it was told. */
	told<T extends ToWorker["type"]>(type: T): Extract<ToWorker, { type: T }>[] {
		return this.posted.filter((msg): msg is Extract<ToWorker, { type: T }> => msg.type === type);
	}
}

mock.module("./worker/worker.ts?worker&inline", () => ({ default: InProcessWorker }));

const { Decoder } = await import("./decoder");
const { Source } = await import("./source");
const { Sync } = await import("../sync");
const { Broadcast } = await import("../broadcast");
const { serve } = await import("./worker/host");
const { resetShared } = await import("./worker/remote");
const { LINGER } = await import("./worker/pool");

beforeAll(async () => {
	for (const name of NAMES) saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
	scope.AudioWorkletProcessor = class {
		readonly port = nextPort;
	};
	scope.registerProcessor = (name: string, processor: new () => Processor) => {
		if (name === "render") Render = processor;
	};
	scope.sampleRate = RATE;
	// A module instance of our own; see render-worklet.port.test.ts.
	const worklet = "./render-worklet.ts?offload";
	await import(worklet);
});

afterAll(() => {
	for (const [name, descriptor] of saved) {
		if (descriptor) Object.defineProperty(globalThis, name, descriptor);
		else Reflect.deleteProperty(globalThis, name);
	}
});

beforeEach(() => {
	scope.currentFrame = 0;
	scope.document = new EventTarget();
	Reflect.deleteProperty(globalThis, "window");
	scope.AudioContext = MockContext;
	scope.AudioWorkletNode = Node;
	scope.AudioDecoder = FakeDecoder;
	// Present, so the page's libav polyfill resolves without loading anything.
	scope.AudioEncoder = class {};
	scope.EncodedAudioChunk = FakeChunk;
	Node.built = [];
	InProcessWorker.created = [];
	relay = new Relay();
});

afterEach(() => {
	jest.useRealTimers();
	for (const stop of cleanup.splice(0).reverse()) stop();
	resetShared();
	relay.origin.close();
	Reflect.deleteProperty(globalThis, "crossOriginIsolated");
});

// Everything a case opened, closed after it whether it passed or not.
const cleanup: Array<() => void> = [];

// ── the page ────────────────────────────────────────────────────────────────

function rendition(track = "audio"): Catalog.Root {
	return {
		audio: {
			renditions: {
				[track]: { codec: "opus", container: { kind: "legacy" }, sampleRate: RATE, numberOfChannels: 2 },
			},
		},
	} as unknown as Catalog.Root;
}

/** A player's audio half on the page, with its broadcast on the page's session and on the relay. */
interface Tile {
	decoder: DecoderType;
	sync: SyncType;
	source: SourceType;
	broadcast: BroadcastType;
	enabled: Signal<boolean>;
	attached: Signal<boolean>;
	delay: Signal<Delay>;
	catalog: Signal<Catalog.Root | undefined>;
	/** The broadcast on the page's own session. */
	page: Publisher;
	/** The same broadcast on the relay the worker dials. */
	remote: Publisher;
	/** One group of media to both, as the relay would serve both sessions. */
	write(sequence: number, timestamp: number, track?: string): void;
}

function tile(props?: { offload?: boolean | Signal<boolean>; tracks?: string[] }): Tile {
	const tracks = props?.tracks ?? ["audio"];
	const pageOrigin = new Origin.Producer();
	const page = new Publisher(pageOrigin, tracks);
	const remote = new Publisher(relay.origin, tracks);

	const catalog = new Signal<Catalog.Root | undefined>(rendition(tracks[0]));
	const broadcast = new Broadcast({ origin: pageOrigin, name: Path.from(NAME), catalogFormat: "manual", catalog });
	const source = new Source({ broadcast, supported: async () => true });
	const delay = new Signal<Delay>("auto");
	const sync = new Sync({ delay, buffer: Time.Milli.zero });
	const enabled = new Signal(true);
	const attached = new Signal(true);
	const decoder = new Decoder({
		source,
		sync,
		enabled,
		attached,
		url: new URL(URL_),
		offload: props?.offload ?? true,
	});

	// What `Player` wires: the estimate into `Sync`, which sizes the ring's target from it.
	const wiring = new Effect();
	wiring.proxy(sync.track("audio").spread, decoder.out.spread);

	cleanup.push(() => {
		wiring.close();
		decoder.close();
		sync.close();
		source.close();
		broadcast.close();
		page.close();
		remote.close();
		pageOrigin.close();
	});

	return {
		decoder,
		sync,
		source,
		broadcast,
		enabled,
		attached,
		delay,
		catalog,
		page,
		remote,
		write: (sequence, timestamp, track) => {
			page.write(sequence, timestamp, track);
			remote.write(sequence, timestamp, track);
		},
	};
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const immediate = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Wait, on real timers, until `ready` holds. */
async function until(ready: () => boolean, what: string): Promise<void> {
	for (let waited = 0; waited < 2_000; waited += 5) {
		if (ready()) return;
		await sleep(5);
	}
	throw new Error(`timed out waiting for ${what}`);
}

/** Move fake timers on by `ms`, letting messages and effects run between steps. */
async function advance(ms: number): Promise<void> {
	for (let left = ms; left > 0; left -= 10) {
		jest.advanceTimersByTime(Math.min(10, left));
		for (let i = 0; i < 4; i++) await immediate();
	}
}

/** The one worker the page started. */
function worker(): InProcessWorker {
	const [only, ...rest] = InProcessWorker.created;
	if (!only || rest.length > 0) throw new Error(`${InProcessWorker.created.length} workers`);
	return only;
}

/** A tile the worker plays for: its player, timing and graph sent, and 400 ms of media played. */
async function playing(props?: { isolated?: boolean; tracks?: string[]; offload?: Signal<boolean> }) {
	scope.crossOriginIsolated = props?.isolated ?? true;
	const t = tile({ tracks: props?.tracks, offload: props?.offload });
	await until(() => InProcessWorker.created.length === 1 && worker().told("graph").length > 0, "the graph");
	for (let i = 0; i < 20; i++) t.write(i, i * 20_000);
	await sleep(100);
	const [node] = Node.built;
	const played = pull(node, 60);
	await sleep(150);
	return { ...t, node, played };
}

// ── the cases ───────────────────────────────────────────────────────────────

const RINGS: Array<["shared" | "post", boolean]> = [
	["shared", true],
	["post", false],
];

describe.each(RINGS)("a player offloaded on a %s ring", (_kind, isolated) => {
	it("plays through the worker, and the counters, clock, spread and arrivals reach the page", async () => {
		const clocks: Array<Clock | undefined> = [];
		const arrivals: Array<{ timestamp: Time.Milli; at: Time.Milli | undefined; heard: Time.Milli }> = [];
		const received = Sync.prototype.received;
		const spy = spyOn(Sync.prototype, "received").mockImplementation(function (
			this: SyncType,
			timestamp,
			label,
			at,
		) {
			if (label === "audio") arrivals.push({ timestamp, at, heard: Time.Milli.now() });
			received.call(this, timestamp, label, at);
		});
		cleanup.push(() => spy.mockRestore());
		const t = await playing({ isolated });
		const track = t.sync.track("audio");
		clocks.push(track.clock.peek());
		track.clock.subscribe((clock) => clocks.push(clock));

		expect(loudest(t.played)).toBeGreaterThan(0.4);
		await sleep(120);

		const out = t.decoder.out;
		expect(out.stats.peek()?.bytesReceived).toBeGreaterThan(0);
		expect(out.skipped.peek()).toBe(0);
		expect(out.buffered.peek().length).toBeGreaterThan(0);
		// The publisher declares nothing, so the estimate is the estimator's 80 ms prior.
		expect(out.spread.peek()).toBe(Time.Milli(80));
		expect(out.debug.peek()?.output).toBeGreaterThan(0);
		expect(out.debug.peek()?.target).toBe((RATE * 80) / 1000);
		expect(out.timestamp.peek()).toBeGreaterThan(0);
		expect(out.sampleRate.peek()).toBe(RATE);

		// The ring's playhead is the clock video paces against, on the page's own monotonic clock.
		const clocked = clocks.filter((clock) => clock !== undefined);
		expect(clocked.length).toBeGreaterThan(0);
		for (const clock of clocked) {
			expect(clock?.timestamp).toBeGreaterThan(0);
			expect(clock?.reference).toBeLessThanOrEqual(Time.Milli.now());
			expect(clock?.reference).toBeGreaterThan(Time.Milli.now() - 2_000);
		}

		// Every frame reached `Sync` once, in order, stamped when the worker read it: on the page's clock,
		// and before the page heard of it.
		expect(arrivals.map((arrival) => arrival.timestamp)).toEqual(
			Array.from({ length: 20 }, (_, i) => Time.Milli(i * 20)),
		);
		for (const { at, heard } of arrivals) {
			expect(at).toBeDefined();
			expect(at).toBeLessThanOrEqual(heard);
			expect(at).toBeGreaterThan(heard - 1_000);
		}
		expect(t.sync.out.timestamp.peek()).toBe(Time.Milli(380));
		expect(t.sync.now()).toBeDefined();
	});
});

describe("the audio's download", () => {
	it("happens on the worker's session alone", async () => {
		const t = await playing();
		expect(t.remote.live()).toBe(1);
		expect(t.page.total()).toBe(0);
		expect(worker().told("player").at(-1)).toMatchObject({ url: URL_, name: NAME, track: "audio", enabled: true });
	});

	it("stays on the page when the player does not offload, which never loads the worker", async () => {
		scope.crossOriginIsolated = true;
		const t = tile({ offload: false });
		await until(() => Node.built.length > 0 && t.page.live() === 1, "the page's subscription");
		for (let i = 0; i < 20; i++) t.write(i, i * 20_000);
		await sleep(100);
		expect(loudest(pull(Node.built[0], 60))).toBeGreaterThan(0.4);

		expect(t.remote.total()).toBe(0);
		expect(InProcessWorker.created).toEqual([]);
	});
});

describe("what the page tells the worker", () => {
	it("sends the timing again whenever it changes", async () => {
		const t = await playing();
		expect(worker().told("timing").at(-1)).toMatchObject({
			target: Time.Milli(80),
			delay: "auto",
			buffer: Time.Milli.zero,
			buffered: false,
		});

		t.delay.set(Time.Milli(200));
		await until(() => t.decoder.out.debug.peek()?.target === (RATE * 200) / 1000, "the deeper ring");
		expect(worker().told("timing").at(-1)).toMatchObject({ target: Time.Milli(200), delay: Time.Milli(200) });
	});

	it("samples its output clock when it hands over the graph, when the context changes state, and every second", async () => {
		jest.useFakeTimers();
		scope.crossOriginIsolated = false;
		const t = tile();
		for (let i = 0; i < 200 && !InProcessWorker.created[0]?.told("graph").length; i++) await immediate();
		const outputs = () => worker().told("output");
		expect(outputs().length).toBe(1);

		// The device stops and starts again: sampled at once.
		const context = t.decoder.out.context.peek() as unknown as MockContext;
		context.state = "suspended";
		context.dispatchEvent(new Event("statechange"));
		expect(outputs().length).toBe(2);
		expect(outputs()[1].output).toBeUndefined();
		scope.currentFrame = QUANTUM;
		await context.resume();
		expect(outputs().length).toBe(3);
		expect(outputs()[2].output?.contextTime).toBe(QUANTUM / RATE);

		// And every second on its own.
		await advance(990);
		expect(outputs().length).toBe(3);
		await advance(20);
		expect(outputs().length).toBe(4);
	});

	it("starts the node's own port, so the worklet's reports to it are not queued for the node's life", async () => {
		const started = new Set<MessagePort>();
		const start = MessagePort.prototype.start;
		MessagePort.prototype.start = function (this: MessagePort) {
			started.add(this);
			start.call(this);
		};
		cleanup.push(() => {
			MessagePort.prototype.start = start;
		});

		await playing({ isolated: false });
		expect(started.has(Node.built[0].port)).toBe(true);
	});
});

describe("flushes", () => {
	it("a reset, a mute and an instant delay each flush with a new epoch, and a report from before one is dropped", async () => {
		const t = await playing();
		const id = worker().told("player")[0].id;
		const track = t.sync.track("audio");
		const epochs = () =>
			worker()
				.told("flush")
				.map((flush) => flush.epoch);
		expect(epochs()).toEqual([]);

		t.decoder.reset();
		expect(epochs()).toEqual([1]);
		// The page mirrors the flush at once rather than waiting for the worker's next report.
		await immediate();
		expect(t.decoder.out.timestamp.peek()).toBeUndefined();

		// A report the worker composed before it applied the flush says the ring still plays, and carries
		// a frame nothing else here does. Dropped.
		const at = performance.timeOrigin + performance.now();
		const stale = {
			type: "report",
			id,
			epoch: 0,
			timeline: 0,
			clock: { timestamp: Time.Micro(5_000_000), at, rate: 1 },
			arrivals: [{ timestamp: Time.Milli(77_777), at }],
			spread: Time.Milli(80),
			rate: undefined,
			ring: { timestamp: Time.Micro(5_000_000), stalled: false, underruns: 0, debug: undefined },
			stats: undefined,
			skipped: 0,
			buffered: [],
			connection: "connected",
			transport: "webtransport",
			resolved: true,
		} satisfies FromWorker;
		worker().say(stale);
		await immediate();
		expect(t.sync.out.timestamp.peek()).toBe(Time.Milli(380));
		expect(track.clock.peek()?.timestamp).not.toBe(Time.Micro(5_000_000));
		// One composed after it is not.
		worker().say({ ...stale, epoch: 1 });
		expect(t.sync.out.timestamp.peek()).toBe(Time.Milli(77_777));

		t.enabled.set(false);
		await until(() => epochs().length === 2, "the mute's flush");
		expect(epochs()).toEqual([1, 2]);
		expect(worker().told("player").at(-1)?.enabled).toBe(false);

		t.enabled.set(true);
		await immediate();
		t.delay.set("instant");
		await until(() => epochs().length === 3, "the instant delay's flush");
		expect(epochs()).toEqual([1, 2, 3]);
	});

	it("a move of the worker's own timeline resets Sync before the frames on the new one", async () => {
		const t = await playing();
		const calls: string[] = [];
		const reset = t.sync.reset.bind(t.sync);
		const received = t.sync.received.bind(t.sync);
		spyOn(t.sync, "reset").mockImplementation(() => {
			calls.push("reset");
			reset();
		});
		spyOn(t.sync, "received").mockImplementation((timestamp, label, at) => {
			calls.push(timestamp >= 5_000 ? "new" : "old");
			received(timestamp, label, at);
		});

		// The publisher restarts on the relay: the same name, a new broadcast, and a timeline of its own.
		t.remote.close();
		const again = new Publisher(relay.origin, ["audio"]);
		cleanup.push(() => again.close());
		await until(() => calls.includes("reset"), "the reset");
		for (let i = 0; i < 5; i++) again.write(i, 5_000_000 + i * 20_000);
		await until(() => calls.includes("new"), "the new timeline's frames");

		expect(calls.filter((call) => call === "reset").length).toBe(1);
		expect(calls.indexOf("new")).toBeGreaterThan(calls.indexOf("reset"));
		expect(calls.slice(calls.indexOf("reset"))).not.toContain("old");
	});
});

describe("the player's lifecycle", () => {
	it("taken off the page, it tells the worker it is gone, and the page lets the worker go after the linger", async () => {
		jest.useFakeTimers();
		const t = tile();
		for (let i = 0; i < 200 && !InProcessWorker.created[0]?.told("graph").length; i++) await immediate();
		const id = worker().told("player")[0].id;
		const [session] = relay.sessions;
		expect(session.closed).toBe(false);

		t.attached.set(false);
		await advance(10);
		expect(worker().told("close")).toEqual([{ type: "close", id }]);
		expect(session.closed).toBe(true);

		await advance(LINGER - 50);
		expect(worker().terminated).toBe(false);
		await advance(100);
		expect(worker().terminated).toBe(true);
	});

	it("a mute stops the worker's download and hands the clock back, and the unmute keeps the estimate", async () => {
		const t = await playing();
		const track = t.sync.track("audio");
		await until(() => track.clock.peek() !== undefined, "the clock");
		const spread = t.decoder.out.spread.peek();

		t.enabled.set(false);
		await until(() => t.remote.live() === 0, "the worker to unsubscribe");
		expect(track.clock.peek()).toBeUndefined();
		expect(t.decoder.out.spread.peek()).toBe(spread);

		t.enabled.set(true);
		await until(() => t.remote.live() === 1, "the worker to subscribe again");
		expect(t.remote.total()).toBe(2);
		expect(t.decoder.out.spread.peek()).toBe(spread);
		expect(t.page.total()).toBe(0);
	});

	it("a rendition switch moves the worker's subscription, and the timeline with it", async () => {
		const t = await playing({ tracks: ["audio", "audio2"] });
		const reset = spyOn(t.sync, "reset");

		t.catalog.set(rendition("audio2"));
		await until(() => t.remote.live("audio2") === 1, "the new rendition's subscription");
		expect(t.remote.live("audio")).toBe(0);
		expect(worker().told("player").at(-1)?.track).toBe("audio2");
		expect(t.page.total("audio2")).toBe(0);

		// The same broadcast, so the same timeline: nothing to reset.
		await sleep(80);
		expect(reset).not.toHaveBeenCalled();
	});

	it("the worker's session reconnecting plays on", async () => {
		const t = await playing();
		const [session] = relay.sessions;

		session.status.set("connecting");
		session.origin.set(undefined);
		await until(() => t.remote.live() === 0, "the dropped subscription");

		session.origin.set(relay.origin);
		session.status.set("connected");
		await until(() => t.remote.live() === 1, "the subscription again");
		t.write(20, 400_000);
		await until(() => t.sync.out.timestamp.peek() === Time.Milli(400), "the frame after the reconnect");
		expect(t.page.total()).toBe(0);
	});

	it("turned off, the audio moves to the page on a fresh node of the same context, and the counters carry on", async () => {
		const offload = new Signal(true);
		const t = await playing({ offload });
		const bytes = t.decoder.out.stats.peek()?.bytesReceived ?? 0;
		expect(bytes).toBeGreaterThan(0);
		let lowest = bytes;
		t.decoder.out.stats.subscribe((stats) => {
			lowest = Math.min(lowest, stats?.bytesReceived ?? 0);
		});
		const context = t.decoder.out.context.peek();

		offload.set(false);
		await until(() => t.page.live() === 1 && Node.built.length === 2, "the page's own subscription");
		expect(worker().told("close").length).toBe(1);
		await until(() => t.remote.live() === 0, "the worker to let go");
		expect(t.decoder.out.context.peek()).toBe(context);

		// The page's first frame is a tune-in on its own session, played through the new node alone.
		for (let i = 20; i < 40; i++) t.write(i, i * 20_000);
		await until(() => (t.decoder.out.stats.peek()?.bytesReceived ?? 0) > bytes, "the page's bytes");
		await sleep(100);
		expect(loudest(pull(Node.built[1], 60))).toBeGreaterThan(0.4);
		expect(lowest).toBe(bytes);
	});

	it("the page put away puts away the worker's session, and brings it back with the page", async () => {
		// A page: a window for pagehide and pageshow, and a document.
		scope.window = new EventTarget();
		const t = await playing();
		const [session] = relay.sessions;
		expect(session.enabled.peek()).toBe(true);

		(scope.window as EventTarget).dispatchEvent(new Event("pagehide"));
		await until(() => session.enabled.peek() === false, "the session put away");
		(scope.window as EventTarget).dispatchEvent(new Event("pageshow"));
		await until(() => session.enabled.peek() === true, "the session back");
		expect(t.remote.live()).toBe(1);
	});
});

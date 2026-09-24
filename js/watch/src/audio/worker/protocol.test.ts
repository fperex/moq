import { afterEach, describe, expect, it } from "bun:test";
import type * as Catalog from "@moq/hang/catalog";
import { Time } from "@moq/net";
import {
	AUDIO_DEADLINE,
	Deadline,
	decide,
	type FromWorker,
	type Report,
	type Stage,
	type Support,
	spawn,
	support,
	TICK,
	type ToWorker,
} from "./protocol";

const FULL: Support = { audioDecoder: true, webTransport: true, webSocket: true };

// ── the page's globals ──────────────────────────────────────────────────────

const GLOBALS = ["WebTransport", "WebSocket", "WebSocketStream", "navigator"] as const;
const saved = new Map<string, PropertyDescriptor | undefined>(
	GLOBALS.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
);

/** Give the page exactly these of the transport globals, and this user agent. */
function page(props: { globals: Array<(typeof GLOBALS)[number]>; userAgent?: string }): void {
	for (const name of ["WebTransport", "WebSocket", "WebSocketStream"]) {
		if (props.globals.includes(name as (typeof GLOBALS)[number])) {
			Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: class {} });
		} else {
			Reflect.deleteProperty(globalThis, name);
		}
	}
	Object.defineProperty(globalThis, "navigator", {
		configurable: true,
		value: { userAgent: props.userAgent ?? "bun" },
	});
}

afterEach(() => {
	for (const [name, descriptor] of saved) {
		if (descriptor) Object.defineProperty(globalThis, name, descriptor);
		else Reflect.deleteProperty(globalThis, name);
	}
});

const SAFARI =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";

describe("decide", () => {
	it("uses a worker that races what the page races", () => {
		page({ globals: ["WebTransport", "WebSocket"] });
		expect(support()).toMatchObject({ webTransport: true, webSocket: true });
		expect(decide(FULL)).toBeUndefined();
	});

	it("falls back without a native decoder in the worker", () => {
		page({ globals: ["WebTransport", "WebSocket"] });
		expect(decide({ ...FULL, audioDecoder: false })).toBe("AudioDecoder is not available in a dedicated worker");
	});

	it("falls back when the worker cannot race a transport the page races", () => {
		page({ globals: ["WebTransport", "WebSocket"] });
		expect(decide({ ...FULL, webTransport: false })).toBe("WebTransport is not available in a dedicated worker");
		expect(decide({ ...FULL, webSocket: false })).toBe("WebSocket is not available in a dedicated worker");
	});

	it("does not ask for a transport the page took away", () => {
		// The audio-quality lane deletes the WebSocket fallback from the page.
		page({ globals: ["WebTransport"] });
		expect(decide({ ...FULL, webSocket: false })).toBeUndefined();

		page({ globals: ["WebSocket"] });
		expect(decide({ ...FULL, webTransport: false })).toBeUndefined();
	});

	it("does not ask for WebTransport on a browser the connection keeps off it", () => {
		page({ globals: ["WebTransport", "WebSocket"], userAgent: SAFARI });
		expect(support().webTransport).toBe(false);
		expect(decide({ ...FULL, webTransport: false })).toBeUndefined();
	});

	it("counts WebSocketStream alone as the WebSocket fallback", () => {
		page({ globals: ["WebSocketStream"] });
		expect(support().webSocket).toBe(true);
		expect(decide({ ...FULL, webSocket: false })).toBe("WebSocket is not available in a dedicated worker");
	});
});

// ── the messages ────────────────────────────────────────────────────────────

/** Carry `msg` across a real channel, the way `postMessage` carries it between realms. */
async function carry<T>(msg: T, transfer: Transferable[] = []): Promise<T> {
	const { port1, port2 } = new MessageChannel();
	const received = new Promise<T>((resolve) => {
		port2.onmessage = (event: MessageEvent<T>) => resolve(event.data);
	});
	port1.postMessage(msg, transfer);
	try {
		return await received;
	} finally {
		port1.close();
		port2.close();
	}
}

const CONFIG = {
	codec: "opus",
	container: { kind: "legacy" },
	sampleRate: 48_000,
	numberOfChannels: 2,
	jitter: 40,
	broadcast: "../mic",
} as unknown as Catalog.AudioConfig;

const REPORT: Report = {
	type: "report",
	id: 7,
	epoch: 2,
	timeline: 1,
	clock: { timestamp: Time.Micro(1_020_000), at: 1_758_000_000_123.5, rate: 1 },
	arrivals: [
		{ timestamp: Time.Milli(1_000), at: 1_758_000_000_100.25 },
		{ timestamp: Time.Milli(1_020), at: 1_758_000_000_120.75 },
	],
	spread: Time.Milli(40),
	rate: 44_100,
	ring: {
		timestamp: Time.Micro(1_000_000),
		stalled: false,
		underruns: 1,
		debug: {
			buffered: 960,
			target: 1920,
			chunk: 960,
			skip: 480,
			stalled: false,
			underruns: 1,
			skips: 0,
			skipped: 0,
			discarded: 0,
			trimmed: 0,
			fresh: false,
			anchor: 48_000,
		} as unknown as NonNullable<Report["ring"]>["debug"],
	},
	stats: { bytesReceived: 4_096 },
	skipped: 3,
	buffered: [{ start: Time.Milli(1_000), end: Time.Milli(1_060) }],
	connection: "connected",
	transport: "webtransport",
	resolved: true,
};

describe("messages", () => {
	it("cross a channel intact, every one the page sends", async () => {
		const plain: ToWorker[] = [
			{ type: "hello", transports: { webTransport: false, webSocket: true } },
			{
				type: "player",
				id: 7,
				url: "https://relay.example/anon?jwt=token",
				name: "room/alice",
				announced: true,
				enabled: true,
				track: "audio",
				config: CONFIG,
			},
			{
				type: "timing",
				id: 7,
				target: Time.Milli(60),
				maxAge: Time.Milli(420),
				delay: "auto",
				buffer: Time.Milli(0),
				buffered: false,
			},
			{
				type: "timing",
				id: 7,
				target: Time.Milli(250),
				maxAge: Time.Milli(2_250),
				delay: Time.Milli(250),
				buffer: Time.Milli(2_000),
				buffered: true,
			},
			{ type: "graph", id: 7 },
			{ type: "output", id: 7, output: { contextTime: 1.5, at: 1_758_000_000_000.5 } },
			{ type: "output", id: 7 },
			{ type: "flush", id: 7, epoch: 3 },
			{ type: "suspend", suspended: true },
			{ type: "close", id: 7 },
		];
		for (const msg of plain) expect(await carry(msg)).toEqual(msg);

		// The one that moves a port: the worklet's other end goes with it.
		const { port1, port2 } = new MessageChannel();
		const graph: ToWorker = {
			type: "graph",
			id: 7,
			ring: { port: port1, rate: 48_000, channels: 2, conceal: true },
		};
		const out = await carry(graph, [port1]);
		if (out.type !== "graph" || !out.ring) throw new Error(`carried ${JSON.stringify(out)}`);
		expect(out.ring.port).toBeInstanceOf(MessagePort);
		expect({ ...out.ring, port: undefined }).toEqual({ port: undefined, rate: 48_000, channels: 2, conceal: true });
		out.ring.port.close();
		port2.close();
	});

	it("cross a channel intact, every one the worker sends", async () => {
		const sent: FromWorker[] = [
			{ type: "ready", support: FULL },
			REPORT,
			{ ...REPORT, clock: undefined, ring: undefined, stats: undefined, spread: undefined, rate: undefined },
			{ type: "refused", id: 7, reason: "the worker cannot decode opus" },
			{ type: "error", id: 7, message: "TypeError: boom" },
			{ type: "error", message: "the worker failed" },
		];
		for (const msg of sent) expect(await carry(msg)).toEqual(msg);
	});
});

// ── spawn ───────────────────────────────────────────────────────────────────

/** A Worker as `spawn` drives it: the three handlers, `postMessage` and `terminate`. */
class FakeWorker {
	onmessage: ((event: MessageEvent<FromWorker>) => void) | null = null;
	onerror: ((event: ErrorEvent) => void) | null = null;
	onmessageerror: (() => void) | null = null;
	posted: Array<{ msg: ToWorker; transfer: Transferable[] }> = [];
	terminated = false;

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
}

/** What the page races in these cases: both transports. */
const PAGE = { webTransport: true, webSocket: true };

/** Let `spawn` take the worker in hand, which it does a microtask after asking for it. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("spawn", () => {
	it("falls back when the worker cannot be created, as a CSP refusing blob: workers makes Chromium throw", async () => {
		const thrown = await spawn(() => {
			throw new DOMException("Access to the script at 'blob:...' is denied", "SecurityError");
		}, PAGE);
		expect("reason" in thrown && thrown.reason).toBe(
			"the worker could not be created: SecurityError: Access to the script at 'blob:...' is denied",
		);

		// The bundled worker is a lazy chunk, so the import can fail too.
		const rejected = await spawn(async () => {
			throw new TypeError("Failed to fetch dynamically imported module");
		}, PAGE);
		expect("reason" in rejected && rejected.reason).toBe(
			"the worker could not be created: TypeError: Failed to fetch dynamically imported module",
		);
	});

	it("falls back when the worker fails to load, as a CSP refusal reaches Firefox", async () => {
		const fake = new FakeWorker();
		const pending = spawn(async () => fake.asWorker, PAGE);
		await settle();
		fake.fail("worker-src refused");
		const spawned = await pending;
		expect("reason" in spawned && spawned.reason).toBe("the worker failed to load: worker-src refused");
		expect(fake.terminated).toBe(true);
	});

	it("falls back when the worker's first message cannot be read", async () => {
		const fake = new FakeWorker();
		const pending = spawn(() => fake.asWorker, PAGE);
		await settle();
		fake.onmessageerror?.();
		const spawned = await pending;
		expect("reason" in spawned && spawned.reason).toBe("the worker's first message could not be deserialized");
		expect(fake.terminated).toBe(true);
	});

	it("falls back when the worker has no decoder", async () => {
		const fake = new FakeWorker();
		const pending = spawn(() => fake.asWorker, PAGE);
		await settle();
		fake.say({ type: "ready", support: { ...FULL, audioDecoder: false } });
		const spawned = await pending;
		expect("reason" in spawned && spawned.reason).toBe("AudioDecoder is not available in a dedicated worker");
		expect(fake.terminated).toBe(true);
		expect(fake.posted).toEqual([]);
	});

	it("refuses a worker whose first word is not ready", async () => {
		const fake = new FakeWorker();
		const pending = spawn(() => fake.asWorker, PAGE);
		await settle();
		fake.say({ type: "error", message: "early" });
		const spawned = await pending;
		expect("reason" in spawned && spawned.reason).toBe('the worker said "error" before it said ready');
		expect(fake.terminated).toBe(true);
	});

	it("hands back a worker that can, says hello, and relays what it says after in order", async () => {
		const fake = new FakeWorker();
		const pending = spawn(() => fake.asWorker, { webTransport: false, webSocket: true });
		await settle();
		fake.say({ type: "ready", support: FULL });
		const spawned = await pending;
		if (!("handle" in spawned)) throw new Error(`fell back: ${spawned.reason}`);
		const { handle } = spawned;
		expect(handle.support).toEqual(FULL);
		expect(fake.terminated).toBe(false);

		// Before anything else, the transports the worker may race: exactly the page's.
		expect(fake.posted).toEqual([
			{ msg: { type: "hello", transports: { webTransport: false, webSocket: true } }, transfer: [] },
		]);

		const heard: FromWorker[] = [];
		handle.onmessage = (msg) => heard.push(msg);
		fake.say(REPORT);
		fake.say({ type: "refused", id: 7, reason: "no" });
		fake.fail("late error");
		fake.onmessageerror?.();
		expect(heard).toEqual([
			REPORT,
			{ type: "refused", id: 7, reason: "no" },
			{ type: "error", message: "the worker failed: late error" },
			{ type: "error", message: "a message from the worker could not be deserialized" },
		]);

		const { port1, port2 } = new MessageChannel();
		const graph: ToWorker = {
			type: "graph",
			id: 7,
			ring: { port: port2, rate: 44_100, channels: 1, conceal: false },
		};
		handle.post(graph, [port2]);
		expect(fake.posted.at(-1)).toEqual({ msg: graph, transfer: [port2] });
		port1.close();
		port2.close();

		handle.close();
		expect(fake.terminated).toBe(true);
		// Nothing it says after that reaches the page.
		fake.say(REPORT);
		expect(heard.length).toBe(4);
	});
});

// ── the deadline ────────────────────────────────────────────────────────────

/** Tick `deadline` on time, every {@link TICK}, from `from` for `ms`: the first reason it gives, and when. */
function tick(
	deadline: Deadline,
	props: { from: number; ms: number; stage: Stage; held?: boolean; target?: Time.Milli },
): { reason: string; at: number } | undefined {
	for (let at = props.from; at <= props.from + props.ms; at += TICK) {
		const reason = deadline.tick(at, {
			stage: props.stage,
			held: props.held ?? false,
			target: props.target ?? Time.Milli(80),
		});
		if (reason !== undefined) return { reason, at };
	}
	return undefined;
}

describe("Deadline", () => {
	it("gives a worker stuck at any stage five seconds, and says where it stopped", () => {
		const cases: Array<[Exclude<Stage, "audio">, string]> = [
			["ready", "it never became ready"],
			["connected", "its session to the relay never connected"],
			["resolved", "its session never found the broadcast"],
			["played", "the audio it read never played"],
		];
		for (const [stage, why] of cases) {
			const deadline = new Deadline();
			// The ring fills its target before it plays, so the last stage waits that much longer.
			const target = stage === "played" ? Time.Milli(80) : Time.Milli.zero;
			const expired = tick(deadline, { from: 1_000, ms: 10_000, stage, target });
			expect(expired).toEqual({
				reason: `the audio worker played nothing in 5 s: ${why}`,
				at: 1_000 + AUDIO_DEADLINE + target + (stage === "played" ? TICK - (target % TICK) : 0),
			});
		}
	});

	it("adds the time up across the stages", () => {
		const deadline = new Deadline();
		expect(tick(deadline, { from: 0, ms: 3_000, stage: "connected" })).toBeUndefined();
		expect(tick(deadline, { from: 3_000 + TICK, ms: 10_000, stage: "resolved" })?.at).toBe(AUDIO_DEADLINE);
	});

	it("never counts the time the page holds the audio up, or the publisher sends none", () => {
		const deadline = new Deadline();
		expect(tick(deadline, { from: 0, ms: 60_000, stage: "connected", held: true })).toBeUndefined();
		expect(tick(deadline, { from: 60_000 + TICK, ms: 60_000, stage: "audio" })).toBeUndefined();
		// What was held counts for nothing afterwards either.
		expect(tick(deadline, { from: 120_000 + TICK, ms: 10_000, stage: "connected" })?.at).toBe(
			120_000 + TICK + AUDIO_DEADLINE,
		);
	});

	it("gives a deep ring the time it takes to fill", () => {
		const deadline = new Deadline();
		expect(tick(deadline, { from: 0, ms: 20_000, stage: "played", target: Time.Milli(10_000) })?.at).toBe(15_000);
	});

	it("does not count a check the page's own timer made late", () => {
		const deadline = new Deadline();
		const at = { stage: "connected" as const, held: false, target: Time.Milli.zero };
		expect(deadline.tick(0, at)).toBeUndefined();
		// Frozen, hidden or stalled: nothing the page saw in that time was the worker's to answer for.
		for (let now = 10_000; now <= 60_000; now += 10_000) expect(deadline.tick(now, at)).toBeUndefined();
		expect(tick(deadline, { from: 60_000 + TICK, ms: 10_000, stage: "connected" })?.at).toBe(
			60_000 + AUDIO_DEADLINE,
		);
	});
});

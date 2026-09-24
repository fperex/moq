import { afterEach, beforeEach, describe, expect, it, jest, spyOn } from "bun:test";
import type * as Catalog from "@moq/hang/catalog";
import { Time } from "@moq/net";
import { LINGER, LIVENESS, Liveness, Pool } from "./pool";
import { type FromWorker, type Report, type Support, support, TICK, type ToWorker } from "./protocol";

const FULL: Support = { audioDecoder: true, webTransport: true, webSocket: true };

/** A Worker as the pool drives it, which says ready as soon as it is created unless told not to. */
class FakeWorker {
	static created: FakeWorker[] = [];
	static support: Support | undefined = FULL;

	onmessage: ((event: MessageEvent<FromWorker>) => void) | null = null;
	onerror: ((event: ErrorEvent) => void) | null = null;
	onmessageerror: (() => void) | null = null;
	posted: ToWorker[] = [];
	terminated = false;

	constructor() {
		FakeWorker.created.push(this);
		// A task, as a real worker's first message is: never inside the tick that created it.
		const support = FakeWorker.support;
		if (support) setTimeout(() => this.say({ type: "ready", support }), 0);
	}

	postMessage(msg: ToWorker): void {
		this.posted.push(msg);
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

	/** What it was told, less the handshake. */
	get told(): ToWorker[] {
		return this.posted.filter((msg) => msg.type !== "hello");
	}
}

function create(): Worker {
	return new FakeWorker() as unknown as Worker;
}

function report(id: number): Report {
	return {
		type: "report",
		id,
		epoch: 0,
		timeline: 0,
		clock: undefined,
		arrivals: [],
		spread: undefined,
		rate: undefined,
		ring: undefined,
		stats: undefined,
		skipped: 0,
		buffered: [],
		connection: "connected",
		transport: "webtransport",
		resolved: true,
	};
}

// The window and document a page has, for the lifecycle events the pool forwards.
const saved = {
	window: Object.getOwnPropertyDescriptor(globalThis, "window"),
	document: Object.getOwnPropertyDescriptor(globalThis, "document"),
};

let pools: Pool[] = [];

// Let the microtasks queued so far run: `spawn` hears the worker only once it has it in hand.
async function ticks(): Promise<void> {
	for (let i = 0; i < 5; i++) await Promise.resolve();
}

/** A pool on this page, closed after the case. */
function pool(): Pool {
	const made = new Pool(create);
	pools.push(made);
	return made;
}

beforeEach(() => {
	FakeWorker.created = [];
	FakeWorker.support = FULL;
});

afterEach(() => {
	for (const made of pools) made.close();
	pools = [];
	jest.useRealTimers();
	for (const [name, descriptor] of Object.entries(saved)) {
		if (descriptor) Object.defineProperty(globalThis, name, descriptor);
		else Reflect.deleteProperty(globalThis, name);
	}
});

describe("Pool", () => {
	it("starts one worker for every player on the page, and says hello to it once", async () => {
		const shared = pool();
		const a = shared.acquire();
		const b = shared.acquire();
		expect(await a.ready).toBeUndefined();
		expect(await b.ready).toBeUndefined();

		expect(FakeWorker.created.length).toBe(1);
		expect(a.id).not.toBe(b.id);
		const [worker] = FakeWorker.created;
		expect(worker.posted).toEqual([{ type: "hello", transports: support() }]);

		// A player's messages reach the one worker.
		a.post({ type: "flush", id: a.id, epoch: 1 });
		b.post({ type: "flush", id: b.id, epoch: 1 });
		expect(worker.told).toEqual([
			{ type: "flush", id: a.id, epoch: 1 },
			{ type: "flush", id: b.id, epoch: 1 },
		]);
	});

	it("tells the worker a player is gone, and terminates it once the last one has lingered", async () => {
		const shared = pool();
		const a = shared.acquire();
		const b = shared.acquire();
		await a.ready;
		await b.ready;
		const [worker] = FakeWorker.created;
		jest.useFakeTimers();

		a.release();
		expect(worker.told).toEqual([{ type: "close", id: a.id }]);
		// Letting go twice is letting go once.
		a.release();
		expect(worker.told).toEqual([{ type: "close", id: a.id }]);
		jest.advanceTimersByTime(10 * LINGER);
		expect(worker.terminated).toBe(false);

		b.release();
		expect(worker.told).toEqual([
			{ type: "close", id: a.id },
			{ type: "close", id: b.id },
		]);
		jest.advanceTimersByTime(LINGER - 1);
		expect(worker.terminated).toBe(false);
		jest.advanceTimersByTime(1);
		expect(worker.terminated).toBe(true);

		// The next player starts another.
		jest.useRealTimers();
		const c = shared.acquire();
		expect(await c.ready).toBeUndefined();
		expect(FakeWorker.created.length).toBe(2);
	});

	it("keeps a lingering worker for the next player", async () => {
		const shared = pool();
		const a = shared.acquire();
		await a.ready;
		jest.useFakeTimers();
		a.release();
		jest.advanceTimersByTime(LINGER - 1);

		// A tile rebuilt somewhere else on the page is back before the linger is up. Checked before
		// anything is awaited: a second worker would never say ready under these timers.
		const b = shared.acquire();
		expect(FakeWorker.created.length).toBe(1);
		expect(await b.ready).toBeUndefined();
		jest.advanceTimersByTime(10 * LINGER);
		expect(FakeWorker.created[0].terminated).toBe(false);
	});

	it("terminates a worker nobody wanted by the time it said ready", async () => {
		jest.useFakeTimers();
		FakeWorker.support = undefined;
		const shared = pool();
		const a = shared.acquire();
		a.release();
		jest.advanceTimersByTime(LINGER);

		const [worker] = FakeWorker.created;
		await ticks();
		worker.say({ type: "ready", support: FULL });
		await ticks();
		expect(await a.ready).toBe("the player let go before the worker was ready");
		expect(worker.terminated).toBe(true);
	});

	it("hands each player its own reports, and the worker's own trouble to every player", async () => {
		const shared = pool();
		const a = shared.acquire();
		const b = shared.acquire();
		await a.ready;
		await b.ready;
		const heard = { a: [] as FromWorker[], b: [] as FromWorker[] };
		a.onmessage = (msg) => heard.a.push(msg);
		b.onmessage = (msg) => heard.b.push(msg);

		const [worker] = FakeWorker.created;
		worker.say(report(a.id));
		worker.say(report(b.id));
		worker.say({ type: "refused", id: b.id, reason: "no" });
		worker.say({ type: "error", id: a.id, message: "a's" });
		expect(heard.a).toEqual([report(a.id), { type: "error", id: a.id, message: "a's" }]);
		expect(heard.b).toEqual([report(b.id), { type: "refused", id: b.id, reason: "no" }]);

		// A player that let go hears nothing more, not even the worker's own trouble.
		a.release();
		worker.say(report(a.id));
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		worker.fail("boom");
		warn.mockRestore();
		expect(heard.a.length).toBe(2);
		expect(heard.b).toEqual([
			report(b.id),
			{ type: "refused", id: b.id, reason: "no" },
			{ type: "error", message: "the worker failed: boom" },
		]);
	});

	it("remembers a worker the page could not start, for every player after", async () => {
		FakeWorker.support = { ...FULL, audioDecoder: false };
		const shared = pool();
		const a = shared.acquire();
		expect(await a.ready).toBe("AudioDecoder is not available in a dedicated worker");
		expect(FakeWorker.created[0].terminated).toBe(true);

		// Whatever refused it refuses the next one too, so there is no second try.
		const b = shared.acquire();
		expect(await b.ready).toBe("AudioDecoder is not available in a dedicated worker");
		expect(FakeWorker.created.length).toBe(1);
	});

	it("refuses a message from a player before its worker is ready", async () => {
		FakeWorker.support = undefined;
		const shared = pool();
		const a = shared.acquire();
		expect(() => a.post({ type: "flush", id: a.id, epoch: 1 })).toThrow("before the worker was ready");
		await ticks();
		FakeWorker.created[0].say({ type: "ready", support: FULL });
		await a.ready;
		a.post({ type: "flush", id: a.id, epoch: 1 });
		a.release();
		// A player that let go posts nothing.
		a.post({ type: "flush", id: a.id, epoch: 2 });
		expect(FakeWorker.created[0].told).toEqual([
			{ type: "flush", id: a.id, epoch: 1 },
			{ type: "close", id: a.id },
		]);
	});
});

describe("suspend", () => {
	/** A page: a window for pagehide/pageshow/unload, and a document whose visibility can change. */
	function page(): { window: EventTarget; document: EventTarget & { hidden: boolean } } {
		const win = new EventTarget();
		const doc = Object.assign(new EventTarget(), { hidden: false });
		Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: win });
		Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: doc });
		return { window: win, document: doc };
	}

	const suspends = (worker: FakeWorker) => worker.told.filter((msg) => msg.type === "suspend");

	it("tells the worker when the page is put away and when it comes back, as a connection hears it", async () => {
		const { window, document } = page();
		const shared = pool();
		const a = shared.acquire();
		await a.ready;
		const [worker] = FakeWorker.created;

		window.dispatchEvent(new Event("pagehide"));
		window.dispatchEvent(new Event("pageshow"));
		window.dispatchEvent(new Event("unload"));
		// A hidden document is not a suspended one; one shown again after a freeze is back.
		document.hidden = true;
		document.dispatchEvent(new Event("visibilitychange"));
		document.hidden = false;
		document.dispatchEvent(new Event("visibilitychange"));
		// Only a change is news.
		window.dispatchEvent(new Event("pageshow"));

		expect(suspends(worker)).toEqual([
			{ type: "suspend", suspended: true },
			{ type: "suspend", suspended: false },
			{ type: "suspend", suspended: true },
			{ type: "suspend", suspended: false },
		]);
	});

	it("tells a worker started while the page is put away", async () => {
		const { window } = page();
		const shared = pool();
		window.dispatchEvent(new Event("pagehide"));

		const a = shared.acquire();
		await a.ready;
		expect(FakeWorker.created[0].posted).toEqual([
			{ type: "hello", transports: support() },
			{ type: "suspend", suspended: true },
		]);
	});

	it("stops listening once closed", async () => {
		const { window } = page();
		const shared = pool();
		const a = shared.acquire();
		await a.ready;
		const [worker] = FakeWorker.created;

		shared.close();
		expect(worker.terminated).toBe(true);
		window.dispatchEvent(new Event("pagehide"));
		expect(suspends(worker)).toEqual([]);
	});
});

it("lingers as long as a connection does", () => {
	// Two seconds, as `@moq/net`'s pool: a tile moved around the page is back well within it.
	expect(LINGER).toBe(Time.Milli(2_000));
});

// ── a worker that fails ─────────────────────────────────────────────────────

describe("Liveness", () => {
	/** Check on time, every {@link TICK}, from `from` for `ms`: when it first gave up, if it did. */
	function check(liveness: Liveness, from: number, ms: number, playing = true): number | undefined {
		for (let at = from; at <= from + ms; at += TICK) {
			if (liveness.tick(at, playing)) return at;
		}
		return undefined;
	}

	it("gives up on a worker that says nothing for two seconds of the page's own checks", () => {
		expect(check(new Liveness(), 0, 10_000)).toBe(LIVENESS);
	});

	it("hears anything the worker says as alive", () => {
		const liveness = new Liveness();
		expect(check(liveness, 0, LIVENESS - TICK)).toBeUndefined();
		liveness.heard();
		expect(check(liveness, LIVENESS, 10_000)).toBe(2 * LIVENESS - TICK);
	});

	it("waits while the worker plays for nobody, and starts over when it does again", () => {
		const liveness = new Liveness();
		expect(check(liveness, 0, LIVENESS - TICK)).toBeUndefined();
		expect(check(liveness, LIVENESS, 60_000, false)).toBeUndefined();
		const from = LIVENESS + 60_000 + TICK;
		expect(check(liveness, from, 10_000)).toBe(from + LIVENESS - TICK);
	});

	it("does not count a check the page's own timer made late", () => {
		const liveness = new Liveness();
		expect(liveness.tick(0, true)).toBe(false);
		// Frozen, hidden or stalled: whatever the worker said in that time is still queued behind the page.
		for (let at = 10_000; at <= 60_000; at += 10_000) expect(liveness.tick(at, true)).toBe(false);
		expect(check(liveness, 60_000 + TICK, 10_000)).toBe(60_000 + LIVENESS);
	});
});

describe("a worker that fails", () => {
	const PLAYER = { url: "https://relay.example/anon", name: "room/alice", announced: true, enabled: true };
	const CONFIG = { codec: "opus", container: { kind: "legacy" } } as unknown as Catalog.AudioConfig;

	/** Players on a worker started under fake timers, which a FakeWorker says ready on. */
	async function started(count: number) {
		jest.useFakeTimers();
		const shared = pool();
		const leases = Array.from({ length: count }, () => shared.acquire());
		await ticks();
		jest.advanceTimersByTime(1);
		for (const lease of leases) expect(await lease.ready).toBeUndefined();
		return { shared, leases };
	}

	/** Two players on one worker, each with a player the worker would report for. */
	async function two() {
		const {
			shared,
			leases: [a, b],
		} = await started(2);
		const heard = { a: [] as FromWorker[], b: [] as FromWorker[] };
		a.onmessage = (msg) => heard.a.push(msg);
		b.onmessage = (msg) => heard.b.push(msg);
		a.post({ type: "player", id: a.id, ...PLAYER, track: "audio", config: CONFIG });
		b.post({ type: "player", id: b.id, ...PLAYER, track: "audio", config: CONFIG });
		const [worker] = FakeWorker.created;
		return { shared, a, b, heard, worker };
	}

	it("is given up when it says nothing for two seconds while it plays, for every player now and after, with one warning", async () => {
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		try {
			const { shared, heard, worker } = await two();
			jest.advanceTimersByTime(LIVENESS);
			expect(heard.a).toEqual([]);
			jest.advanceTimersByTime(TICK);

			const gone: FromWorker = { type: "error", message: "the audio worker said nothing for 2 s" };
			expect(heard.a).toEqual([gone]);
			expect(heard.b).toEqual([gone]);
			expect(worker.terminated).toBe(true);
			expect(warn).toHaveBeenCalledTimes(1);

			// Whatever stalled it would stall the next one too.
			const c = shared.acquire();
			expect(await c.ready).toBe("the audio worker said nothing for 2 s");
			expect(FakeWorker.created.length).toBe(1);
			expect(warn).toHaveBeenCalledTimes(1);
		} finally {
			warn.mockRestore();
		}
	});

	it("is kept while it reports, and while it plays for nobody", async () => {
		const {
			leases: [a],
		} = await started(1);
		const [worker] = FakeWorker.created;
		const heard: FromWorker[] = [];
		a.onmessage = (msg) => heard.push(msg);

		// No player yet, so nothing to report.
		jest.advanceTimersByTime(10 * LIVENESS);
		a.post({ type: "player", id: a.id, ...PLAYER, track: "audio", config: CONFIG });
		for (let at = 0; at < 10 * LIVENESS; at += 50) {
			worker.say(report(a.id));
			jest.advanceTimersByTime(50);
		}
		expect(heard.filter((msg) => msg.type === "error")).toEqual([]);
		expect(worker.terminated).toBe(false);
	});

	it("is given up on its own error, for every player now and after, with one warning", async () => {
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		try {
			const { shared, heard, worker } = await two();
			worker.fail("boom");
			const gone: FromWorker = { type: "error", message: "the worker failed: boom" };
			expect(heard.a).toEqual([gone]);
			expect(heard.b).toEqual([gone]);
			expect(worker.terminated).toBe(true);
			expect(warn).toHaveBeenCalledTimes(1);

			const c = shared.acquire();
			expect(await c.ready).toBe("the worker failed: boom");
			expect(FakeWorker.created.length).toBe(1);
		} finally {
			warn.mockRestore();
		}
	});

	it("is kept when one player's rendition is refused or fails", async () => {
		const { shared, a, heard, worker } = await two();
		worker.say({ type: "refused", id: a.id, reason: "no" });
		worker.say({ type: "error", id: a.id, message: "a's" });
		expect(heard.b).toEqual([]);
		expect(worker.terminated).toBe(false);

		const c = shared.acquire();
		expect(await c.ready).toBeUndefined();
		expect(FakeWorker.created.length).toBe(1);
	});

	it("warns once when two it started at once both fail to start", async () => {
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		try {
			jest.useFakeTimers();
			FakeWorker.support = undefined;
			const shared = pool();
			// The first is let go while it starts, and lingers out; the next player starts another.
			shared.acquire().release();
			jest.advanceTimersByTime(LINGER);
			const b = shared.acquire();
			await ticks();
			expect(FakeWorker.created.length).toBe(2);

			FakeWorker.created[0].fail("first");
			FakeWorker.created[1].fail("second");
			expect(await b.ready).toBe("the worker failed to load: second");
			expect(await shared.acquire().ready).toBe("the worker failed to load: first");
			expect(warn).toHaveBeenCalledTimes(1);
		} finally {
			warn.mockRestore();
		}
	});

	it("warns once when the page cannot start one, however many players ask", async () => {
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		try {
			FakeWorker.support = { ...FULL, audioDecoder: false };
			const shared = pool();
			const a = shared.acquire();
			const b = shared.acquire();
			expect(await a.ready).toBe("AudioDecoder is not available in a dedicated worker");
			expect(await b.ready).toBe("AudioDecoder is not available in a dedicated worker");
			expect(await shared.acquire().ready).toBe("AudioDecoder is not available in a dedicated worker");
			expect(warn).toHaveBeenCalledTimes(1);
		} finally {
			warn.mockRestore();
		}
	});
});

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type * as Catalog from "@moq/hang/catalog";
import type * as Moq from "@moq/net";
import { Group, Origin, Path, Time, Varint } from "@moq/net";
import { Signal } from "@moq/signals";
import type { Port as Handoff, State } from "../render";
import { type Dial, type Port, restrict, type Session, serve } from "./host";
import type { FromWorker, Report, ToWorker, Transports } from "./protocol";

// The worker's whole job in one process: an in-memory origin standing in for the relay, the real
// host running the real `Supply` per player, a real `MessageChannel` standing in for the worker
// boundary, and the real render worklet reading the port the page hands over. Only WebCodecs is
// faked, and the worklet's global scope. What a thread boundary does to timing is the browser rows'
// question; this is whether the page hears everything it needs, on both ring transports.

// libav is the page's polyfill for a browser without WebCodecs audio, and a worker never loads it:
// it is refused one without a native decoder. Recorded rather than loaded, so a regression shows up
// as a failure instead of a download.
const libav: string[] = [];
mock.module("@libav.js/variant-opus-af", () => ({ default: {} }));
mock.module("@kixelated/libavjs-webcodecs-polyfill", () => ({
	load: async () => {
		libav.push("load");
	},
	AudioDecoder: class {
		decode() {}
	},
	AudioEncoder: class {
		encode() {}
	},
	AudioData: class {},
	EncodedAudioChunk: class {},
}));

const RATE = 48_000;
const QUANTUM = 128;

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
	// Whether this realm's decoder says it can play a config.
	static supported = true;

	state = "configured";
	readonly #output: (data: FakeAudioData) => void;
	constructor(init: { output: (data: FakeAudioData) => void }) {
		this.#output = init.output;
	}
	static async isConfigSupported(): Promise<{ supported: boolean }> {
		return { supported: FakeDecoder.supported };
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

// ── the worklet, in a stand-in scope ────────────────────────────────────────

interface Processor {
	process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean;
}

const scope = globalThis as unknown as Record<string, unknown>;
const NAMES = [
	"AudioWorkletProcessor",
	"registerProcessor",
	"currentFrame",
	"sampleRate",
	"AudioDecoder",
	"AudioEncoder",
	"EncodedAudioChunk",
	"crossOriginIsolated",
];
const saved = new Map<string, unknown>();
let Render: (new () => Processor) | undefined;
let nextPort: MessagePort | undefined;

beforeAll(async () => {
	for (const name of NAMES) saved.set(name, scope[name]);
	scope.AudioWorkletProcessor = class {
		readonly port = nextPort;
	};
	scope.registerProcessor = (name: string, processor: new () => Processor) => {
		if (name === "render") Render = processor;
	};
	scope.currentFrame = 0;
	scope.sampleRate = RATE;
	scope.AudioDecoder = FakeDecoder;
	scope.EncodedAudioChunk = FakeChunk;
	// A decoder with no encoder beside it: the case where the page's polyfill would load libav.
	delete scope.AudioEncoder;
	// A module instance of our own; see render-worklet.port.test.ts.
	const worklet = "../render-worklet.ts?host";
	await import(worklet);
});

afterAll(() => {
	for (const [name, value] of saved) {
		if (value === undefined) delete scope[name];
		else scope[name] = value;
	}
});

beforeEach(() => {
	FakeDecoder.supported = true;
	scope.currentFrame = 0;
});

afterEach(() => {
	delete scope.crossOriginIsolated;
	for (const stop of cleanup.splice(0)) stop();
});

// Everything a case opened, closed after it whether it passed or not.
const cleanup: Array<() => void> = [];

// ── the relay, in memory ────────────────────────────────────────────────────

/** A session as the host sees one, reading from an origin in this process. */
class FakeSession implements Session {
	readonly origin: Signal<Moq.Origin.Table | undefined>;
	readonly status = new Signal<Moq.Connection.Status>("connected");
	readonly transport = new Signal<Moq.Connection.Transport | undefined>("webtransport");
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

interface Relay {
	origin: Origin.Producer;
	sessions: FakeSession[];
	dial: Dial;
}

function relay(): Relay {
	const origin = new Origin.Producer();
	cleanup.push(() => origin.close());
	const sessions: FakeSession[] = [];
	const dial: Dial = (url, transports) => {
		const session = new FakeSession(url, transports, origin);
		sessions.push(session);
		return session;
	};
	return { origin, sessions, dial };
}

const NAME = "room/alice";

/** A publisher on the relay: an announced broadcast with one audio track. */
function publish(origin: Origin.Producer) {
	const broadcast = origin.createBroadcast(Path.from(NAME));
	const track = broadcast.createTrack("audio");
	broadcast.announce();
	cleanup.push(() => broadcast.close());
	return { broadcast, track };
}

/** One legacy container frame: the media timestamp, then a payload the fake decoder ignores. */
function frame(timestamp: number): Uint8Array {
	const ts = Varint.encode(timestamp);
	const out = new Uint8Array(ts.byteLength + 2);
	out.set(ts, 0);
	out.set([0xde, 0xad], ts.byteLength);
	return out;
}

function writeGroup(track: { writeGroup: (group: Group.Producer) => void }, sequence: number, timestamp: number) {
	const group = new Group.Producer(sequence);
	group.writeFrame({ payload: frame(timestamp), timestamp: Time.Timestamp.now() });
	group.close();
	track.writeGroup(group);
}

/** The endpoint a muting publisher writes: an empty codec payload, alone in its group. */
function writeMarker(track: { writeGroup: (group: Group.Producer) => void }, sequence: number, timestamp: number) {
	const group = new Group.Producer(sequence);
	group.writeFrame({
		payload: Varint.encode(timestamp),
		timestamp: Time.Timestamp.fromMicros(timestamp as Time.Micro),
	});
	group.close();
	track.writeGroup(group);
}

// ── the page ────────────────────────────────────────────────────────────────

const CONFIG = {
	codec: "opus",
	container: { kind: "legacy" },
	sampleRate: RATE,
	numberOfChannels: 2,
} as unknown as Catalog.AudioConfig;

const TRANSPORTS: Transports = { webTransport: true, webSocket: true };

function player(id: number, enabled = true): ToWorker {
	return {
		type: "player",
		id,
		url: "https://relay.example/anon",
		name: NAME,
		announced: true,
		enabled,
		track: "audio",
		config: CONFIG,
	};
}

function timing(id: number, over: Partial<Extract<ToWorker, { type: "timing" }>> = {}): ToWorker {
	return {
		type: "timing",
		id,
		target: Time.Milli(80),
		maxAge: Time.Milli(1_000),
		delay: "auto",
		buffer: Time.Milli.zero,
		buffered: false,
		...over,
	};
}

/** The page's end of the channel to a host, and everything the host said on it. */
class Page {
	readonly heard: FromWorker[] = [];
	readonly #port: MessagePort;

	constructor(dial: Dial, interval: number) {
		const { port1, port2 } = new MessageChannel();
		const stop = serve(port2 as Port, { dial, interval });
		this.#port = port1;
		port1.onmessage = (event: MessageEvent<FromWorker>) => this.heard.push(event.data);
		cleanup.push(() => {
			stop();
			port1.close();
			port2.close();
		});
	}

	post(msg: ToWorker, transfer: Transferable[] = []): void {
		this.#port.postMessage(msg, transfer);
	}

	reports(id = 1): Report[] {
		return this.heard.filter((msg): msg is Report => msg.type === "report" && msg.id === id);
	}

	/** Wait for the first report, from `after` on, that `match` accepts. */
	async report(match: (report: Report) => boolean, after = 0, id = 1): Promise<Report> {
		for (let waited = 0; waited < 2_000; waited += 5) {
			const found = this.reports(id).slice(after).find(match);
			if (found) return found;
			await sleep(5);
		}
		throw new Error(`no such report in ${JSON.stringify(this.reports(id).slice(after), null, 1)}`);
	}
}

/** The page's half of one graph: a render worklet behind a node's port, and a channel handed to the worker. */
function graph(page: Page, id = 1): { render: Processor; states: State[] } {
	if (!Render) throw new Error("render-worklet.ts registered no 'render' processor");
	const node = new MessageChannel();
	nextPort = node.port1;
	const render = new Render();
	const states: State[] = [];
	node.port2.onmessage = (event: MessageEvent<State>) => states.push(event.data);
	cleanup.push(() => node.port2.close());

	const channel = new MessageChannel();
	const handoff: Handoff = { type: "port", port: channel.port1 };
	node.port2.postMessage(handoff, [channel.port1]);
	page.post({ type: "graph", id, ring: { port: channel.port2, rate: RATE, channels: 2, conceal: false } }, [
		channel.port2,
	]);
	return { render, states };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const now = () => performance.timeOrigin + performance.now();

/** Pull `quanta` render quanta of stereo and return the left channel. */
function pull(render: Processor, quanta: number): Float32Array {
	const out = new Float32Array(quanta * QUANTUM);
	for (let i = 0; i < quanta; i++) {
		const left = new Float32Array(QUANTUM);
		render.process([], [[left, new Float32Array(QUANTUM)]], {});
		out.set(left, i * QUANTUM);
		scope.currentFrame = (scope.currentFrame as number) + QUANTUM;
	}
	return out;
}

const loudest = (samples: Float32Array) => samples.reduce((max, v) => Math.max(max, Math.abs(v)), 0);

/** A page with one player on a publishing relay, its timing and graph sent, ready for media. */
async function started(props: { interval: number; isolated: boolean }) {
	scope.crossOriginIsolated = props.isolated;
	const { origin, sessions, dial } = relay();
	const { broadcast, track } = publish(origin);
	const page = new Page(dial, props.interval);
	page.post({ type: "hello", transports: TRANSPORTS });
	page.post(player(1));
	page.post(timing(1));
	const { render, states } = graph(page);
	await sleep(30);
	return { origin, sessions, broadcast, track, page, render, states };
}

// ── the cases ───────────────────────────────────────────────────────────────

const RINGS: Array<["shared" | "post", boolean]> = [
	["shared", true],
	["post", false],
];

describe.each(RINGS)("a player on a %s ring", (kind, isolated) => {
	it("plays through the real worklet, and its counters, clock and arrivals reach the page", async () => {
		const { track, page, render, states } = await started({ interval: 50, isolated });
		// The device started a moment ago: context time zero left it now.
		const output = { contextTime: 0, at: now() };
		page.post({ type: "output", id: 1, output });

		// 400 ms of media, past the three callbacks the legacy warmup drops.
		const before = now();
		for (let i = 0; i < 20; i++) writeGroup(track, i, i * 20_000);
		await sleep(100);
		const read = now();

		const played = pull(render, 60);
		expect(loudest(played)).toBeGreaterThan(0.4);

		// Past a few reports, and past one of the shared ring's 50 ms polls.
		await sleep(150);
		const reports = page.reports();
		const last = reports.at(-1);
		if (!last) throw new Error("no report");

		expect(page.heard[0]).toEqual({ type: "ready", support: expect.any(Object) });
		expect(last.connection).toBe("connected");
		expect(last.transport).toBe("webtransport");
		expect(last.resolved).toBe(true);
		expect(last.stats?.bytesReceived).toBeGreaterThan(0);
		expect(last.skipped).toBe(0);
		expect(last.buffered.length).toBeGreaterThan(0);
		// The publisher declares nothing, so the estimate is the estimator's 80 ms prior.
		expect(last.spread).toBe(Time.Milli(80));
		expect(last.rate).toBeUndefined();

		// The ring's counters, as the worker read them.
		expect(last.ring?.debug?.output).toBeGreaterThan(0);
		expect(last.ring?.debug?.target).toBe((RATE * 80) / 1000);
		expect(last.ring?.timestamp).toBeGreaterThan(0);
		expect(last.ring?.stalled).toBe(last.ring?.debug?.stalled);
		expect(last.ring?.underruns).toBe(last.ring?.debug?.underruns);

		// The clock. The shared ring's is stamped when the worker polled it, on the absolute timeline;
		// the postMessage ring's maps the worklet's context time through the page's sample, which the
		// output clock case checks exactly.
		const clocked = reports.filter((report) => report.clock !== undefined);
		expect(clocked.length).toBeGreaterThan(0);
		for (const { clock } of clocked) {
			expect(clock?.timestamp).toBeGreaterThan(0);
			expect(clock?.at).toBeGreaterThanOrEqual(output.at);
			if (kind === "shared") expect(clock?.at).toBeLessThanOrEqual(now());
		}

		// Every frame the worker read, once, in order, stamped when the worker read it.
		const arrivals = reports.flatMap((report) => report.arrivals);
		expect(arrivals.map((arrival) => arrival.timestamp)).toEqual(
			Array.from({ length: 20 }, (_, i) => Time.Milli(i * 20)),
		);
		for (const { at } of arrivals) {
			expect(at).toBeGreaterThanOrEqual(before);
			expect(at).toBeLessThanOrEqual(read);
		}

		// The node's own port still hears the worklet on the postMessage ring, which is where the page
		// can tell the ring has played; the shared ring posts nothing.
		if (kind === "post") expect(states.length).toBeGreaterThan(0);
		else expect(states.length).toBe(0);
	});
});

describe("the output clock", () => {
	it("reads as a device that has not started until the page says otherwise, then maps through its sample", async () => {
		const errors: unknown[] = [];
		const onError = (error: unknown) => errors.push(error);
		process.on("uncaughtException", onError);
		cleanup.push(() => process.off("uncaughtException", onError));

		const { track, page, render, states } = await started({ interval: 10_000, isolated: false });
		for (let i = 0; i < 20; i++) writeGroup(track, i, i * 20_000);
		await sleep(100);

		// The worklet plays and reports, and nothing has told the worker when the device plays it.
		pull(render, 60);
		await sleep(50);
		expect(states.length).toBeGreaterThan(0);
		expect(errors).toEqual([]);
		expect(page.reports().every((report) => report.clock === undefined)).toBe(true);

		// The page samples its device: context time 0.25 s leaves it at `at`.
		const output = { contextTime: 0.25, at: now() };
		page.post({ type: "output", id: 1, output });
		await sleep(20);
		const seen = states.length;
		const reported = page.reports().length;
		pull(render, 10);

		const report = await page.report((report) => report.clock !== undefined, reported);
		// The first state the worklet sent after the sample, mapped through it.
		const state = states[seen];
		if (!state?.playhead) throw new Error("the worklet reported no playhead");
		expect(report.clock?.timestamp).toBe(state.playhead.timestamp);
		expect(report.clock?.rate).toBe(state.playhead.rate);
		expect(report.clock?.at).toBeCloseTo(output.at + (state.contextTime - output.contextTime) * 1_000, 3);
		expect(errors).toEqual([]);
	});
});

describe("reports", () => {
	it("go out at once when the clock appears and when it changes rate", async () => {
		// An interval nothing here waits out, so every report is one sent at once.
		const { track, page, render } = await started({ interval: 10_000, isolated: true });
		expect(page.reports().length).toBe(0);

		// The first frame anchors the ring: a playhead parked while it fills is a clock already.
		for (let i = 0; i < 20; i++) writeGroup(track, i, i * 20_000);
		const filling = await page.report((report) => report.clock !== undefined);
		expect(filling.clock?.rate).toBe(0);
		const reported = page.reports().length;

		// The next poll finds it moving.
		pull(render, 60);
		const playing = await page.report((report) => (report.clock?.rate ?? 0) > 0, reported);

		// Nothing pulls any more, so the poll after finds it parked again.
		const parked = await page.report((report) => report.clock?.rate === 0, page.reports().indexOf(playing));
		expect(parked.ring?.debug?.output).toBe(playing.ring?.debug?.output);
		expect(parked.ring?.debug?.output).toBeGreaterThan(0);
	});

	it("carry each frame's arrival as the worker read it, not as the report went", async () => {
		// No graph, so no clock to report: a flush is the only thing that sends one.
		const { origin, dial } = relay();
		const { track } = publish(origin);
		const page = new Page(dial, 10_000);
		page.post({ type: "hello", transports: TRANSPORTS });
		page.post(player(1));
		page.post(timing(1));
		await sleep(30);

		const first = now();
		writeGroup(track, 0, 0);
		await sleep(60);
		const second = now();
		writeGroup(track, 1, 20_000);
		await sleep(40);

		// Nothing has been reported yet; a flush sends what is pending.
		expect(page.reports().length).toBe(0);
		const sent = now();
		page.post({ type: "flush", id: 1, epoch: 1 });
		const report = await page.report((report) => report.epoch === 1);

		expect(report.arrivals.map((arrival) => arrival.timestamp)).toEqual([Time.Milli(0), Time.Milli(20)]);
		const [a, b] = report.arrivals;
		expect(a.at).toBeGreaterThanOrEqual(first);
		expect(a.at).toBeLessThan(second);
		expect(b.at).toBeGreaterThanOrEqual(second);
		expect(b.at).toBeLessThan(sent);
	});
});

describe("timing", () => {
	it("carries the lookahead, so buffered playback starts from the oldest group the track holds", async () => {
		scope.crossOriginIsolated = true;
		const { origin, dial } = relay();
		const { track } = publish(origin);
		// The track already holds three groups when the players subscribe.
		for (let i = 0; i < 3; i++) writeGroup(track, i, i * 20_000);

		const page = new Page(dial, 50);
		page.post({ type: "hello", transports: TRANSPORTS });
		page.post(player(1));
		page.post(timing(1, { buffer: Time.Milli(2_000), buffered: true, maxAge: Time.Milli(30_000) }));
		page.post(player(2));
		page.post(timing(2, { maxAge: Time.Milli(30_000) }));
		await sleep(150);

		const read = (id: number) =>
			page
				.reports(id)
				.flatMap((report) => report.arrivals)
				.map((arrival) => arrival.timestamp);
		// Buffered: what the track holds is the point. Live: only the live edge.
		expect(read(1)).toEqual([Time.Milli(0), Time.Milli(20), Time.Milli(40)]);
		expect(read(2)).toEqual([Time.Milli(40)]);
	});
});

describe("the worker's own flushes", () => {
	/** A player that has played, with its clock reported. */
	async function playing() {
		const setup = await started({ interval: 10_000, isolated: true });
		for (let i = 0; i < 20; i++) writeGroup(setup.track, i, i * 20_000);
		await sleep(100);
		pull(setup.render, 60);
		await setup.page.report((report) => report.clock !== undefined);
		return setup;
	}

	it("a mute flushes the ring and says so at once", async () => {
		const { page } = await playing();
		const reported = page.reports().length;

		page.post(player(1, false));
		const muted = await page.report((report) => report.clock === undefined, reported);
		expect(muted.ring?.timestamp).toBeUndefined();
		// A mute is the page's own doing; nothing about the timeline moved.
		expect(muted.timeline).toBe(0);
	});

	it("an instant delay flushes the ring and says so at once", async () => {
		const { page } = await playing();
		const reported = page.reports().length;

		page.post(timing(1, { delay: "instant", target: Time.Milli.zero }));
		const instant = await page.report((report) => report.clock === undefined, reported);
		expect(instant.ring?.timestamp).toBeUndefined();
		expect(instant.timeline).toBe(0);
	});

	it("a page flush carries its epoch in every report after it", async () => {
		const { page } = await playing();
		const reported = page.reports().length;

		page.post({ type: "flush", id: 1, epoch: 4 });
		const flushed = await page.report((report) => report.epoch === 4, reported);
		expect(flushed.clock).toBeUndefined();
		expect(flushed.ring?.timestamp).toBeUndefined();
		await sleep(80);
		const after = page.reports().slice(page.reports().indexOf(flushed));
		expect(after.every((report) => report.epoch === 4)).toBe(true);
	});
});

describe("the worker's own timeline", () => {
	it("moves on a new publisher and on a discontinuity, and no report's frames span a move", async () => {
		// No graph and an interval nothing here waits out, so the frames read before each move are
		// still waiting to be reported when it comes.
		const { origin, dial } = relay();
		const first = publish(origin);
		const page = new Page(dial, 10_000);
		page.post({ type: "hello", transports: TRANSPORTS });
		page.post(player(1));
		page.post(timing(1));
		await sleep(30);
		for (let i = 0; i < 6; i++) writeGroup(first.track, i, 10_000_000 + i * 20_000);
		await sleep(50);
		expect(page.reports().length).toBe(0);

		// The publisher restarts: same name, a new broadcast, a timeline that starts over.
		first.broadcast.close();
		const { track } = publish(origin);
		await page.report((report) => report.timeline === 1);
		await sleep(30);
		for (let i = 0; i < 6; i++) writeGroup(track, i, i * 20_000);
		await sleep(50);

		// It mutes: the endpoint alone in its group, then media again, which the consumer raises as a
		// discontinuity once the group closes.
		writeMarker(track, 6, 120_000);
		await page.report((report) => report.timeline === 2);
		for (let i = 0; i < 6; i++) writeGroup(track, 7 + i, 10_000_000 + i * 20_000);
		await sleep(50);
		page.post({ type: "flush", id: 1, epoch: 1 });
		await page.report((report) => report.epoch === 1);

		const reports = page.reports();
		const timelines = reports.map((report) => report.timeline);
		expect(timelines).toEqual([...timelines].sort((a, b) => a - b));

		const under = (timeline: number) =>
			reports
				.filter((report) => report.timeline === timeline)
				.flatMap((report) => report.arrivals.map((arrival) => arrival.timestamp));
		expect(under(0)).toEqual(Array.from({ length: 6 }, (_, i) => Time.Milli(10_000 + i * 20)));
		expect(under(1)).toEqual(Array.from({ length: 6 }, (_, i) => Time.Milli(i * 20)));
		expect(under(2)).toEqual(Array.from({ length: 6 }, (_, i) => Time.Milli(10_000 + i * 20)));
	});
});

describe("the host", () => {
	it("dials each player's relay with the page's transports, and holds it only while the page is not put away", async () => {
		const { origin, sessions, dial } = relay();
		publish(origin);
		const page = new Page(dial, 50);
		const transports = { webTransport: false, webSocket: true };
		page.post({ type: "hello", transports });
		page.post(player(1));
		page.post(timing(1));
		await sleep(20);

		expect(sessions.length).toBe(1);
		const [session] = sessions;
		expect(session.url.href).toBe("https://relay.example/anon");
		expect(session.transports).toEqual(transports);
		expect(session.enabled.peek()).toBe(true);

		page.post({ type: "suspend", suspended: true });
		await sleep(20);
		expect(session.enabled.peek()).toBe(false);
		page.post({ type: "suspend", suspended: false });
		await sleep(20);
		expect(session.enabled.peek()).toBe(true);

		// Closed, it releases the session and says nothing more.
		page.post({ type: "close", id: 1 });
		await sleep(20);
		expect(session.closed).toBe(true);
		const reported = page.reports().length;
		await sleep(120);
		expect(page.reports().length).toBe(reported);
	});

	it("refuses a rendition this realm's decoder cannot play", async () => {
		FakeDecoder.supported = false;
		const { origin, dial } = relay();
		publish(origin);
		const page = new Page(dial, 10_000);
		page.post({ type: "hello", transports: TRANSPORTS });
		page.post(player(1));
		page.post(timing(1));
		await sleep(30);
		expect(page.heard.filter((msg) => msg.type === "refused")).toEqual([
			{ type: "refused", id: 1, reason: "the worker cannot decode opus" },
		]);
	});

	it("says what went wrong with a player's message, under its id", async () => {
		const { dial } = relay();
		const page = new Page(dial, 10_000);
		page.post(player(1));
		page.post({ type: "hello", transports: TRANSPORTS });
		page.post(timing(2));
		await sleep(20);
		expect(page.heard.filter((msg) => msg.type === "error")).toEqual([
			{ type: "error", id: 1, message: "Error: a player before hello" },
			{ type: "error", id: 2, message: "Error: no player 2" },
		]);
	});

	it("never loads libav, even where the page would", async () => {
		// No AudioEncoder beside the decoder: the page's polyfill would load libav for the missing half.
		expect(scope.AudioEncoder).toBeUndefined();
		const { track, render } = await started({ interval: 50, isolated: true });
		for (let i = 0; i < 20; i++) writeGroup(track, i, i * 20_000);
		await sleep(100);
		expect(loudest(pull(render, 60))).toBeGreaterThan(0.4);
		expect(libav).toEqual([]);
	});
});

describe("restrict", () => {
	it("takes away exactly the transports the page does not race", () => {
		const all = () => ({ WebTransport: class {}, WebSocket: class {}, WebSocketStream: class {} });

		const none = all();
		restrict({ webTransport: true, webSocket: true }, none);
		expect(Object.keys(none)).toEqual(["WebTransport", "WebSocket", "WebSocketStream"]);

		const noWebTransport = all();
		restrict({ webTransport: false, webSocket: true }, noWebTransport);
		expect(Object.keys(noWebTransport)).toEqual(["WebSocket", "WebSocketStream"]);

		// The audio-quality lane deletes the page's WebSocket fallback, both halves of it.
		const noFallback = all();
		restrict({ webTransport: true, webSocket: false }, noFallback);
		expect(Object.keys(noFallback)).toEqual(["WebTransport"]);
	});
});

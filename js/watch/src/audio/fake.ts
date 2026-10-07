/**
 * Fakes the audio tests share: WebCodecs, the relay session the worker dials, the worker itself, and a
 * clock the test moves by hand.
 *
 * @internal Test support, not part of the player.
 */
import type * as Moq from "@moq/net";
import { Time } from "@moq/net";
import { Signal } from "@moq/signals";
import type { Session } from "./worker/host";
import type { FromWorker, Support, ToWorker, Transports } from "./worker/protocol";

const RATE = 48_000;

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

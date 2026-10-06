/**
 * Fakes the audio tests share: the audio worker, and a clock the test moves by hand.
 *
 * @internal Test support, not part of the player.
 */
import { Time } from "@moq/net";
import type { FromWorker, Support, ToWorker } from "./worker/protocol";

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

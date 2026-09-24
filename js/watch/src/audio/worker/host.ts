/**
 * The audio worker's half: a `Supply` for each player the page hands its audio to, behind the messages
 * in `protocol.ts`.
 *
 * Each player reads its broadcast over a session of the worker's own to the relay the page named, and
 * resolves and feeds it exactly as the page would: a manual-catalog `Broadcast` holding the page's pick,
 * a `Source` probing it against this realm's decoder, and the same `Supply` the page runs, writing the
 * ring into the worklet through the port the page handed over. `Sync` stays on the page: the supply
 * reads the part of it `timing` carries, and what the supply tells it goes back in reports.
 *
 * Imports nothing that touches `window` or `document`, nothing Vite alone can resolve, and not libav:
 * the worker decodes only where WebCodecs is native (see `decide`).
 *
 * @module
 */

import type * as Catalog from "@moq/hang/catalog";
import * as Moq from "@moq/net";
import { Path, Time } from "@moq/net";
import { Derived, type Dispose, Effect, type Getter, Signal } from "@moq/signals";
import { Broadcast } from "../../broadcast";
import type { Delay } from "../../sync";
import { Source } from "../source";
import { type Graph, Supply, type SupplySync } from "../supply";
import { supported } from "../supported";
import {
	type Arrival,
	type FromWorker,
	type Output,
	type Report,
	support,
	type ToWorker,
	type Transports,
} from "./protocol";

// How often each player reports: the page's own shared-ring poll, which is the cadence `Sync` already
// extrapolates between.
const REPORT_INTERVAL = 50;

/** Where the page's messages arrive and the replies go: the worker's own scope, or one end of a channel. */
export interface Port {
	postMessage(message: FromWorker, transfer?: Transferable[]): void;
	addEventListener(type: "message", listener: (event: MessageEvent<ToWorker>) => void): void;
	removeEventListener(type: "message", listener: (event: MessageEvent<ToWorker>) => void): void;
	/** A `MessagePort` delivers nothing to a listener until started; a worker's scope has no such call. */
	start?(): void;
}

/** The session a player's broadcast is read from, as a `Moq.Connection` offers one. */
export type Session = Pick<Moq.Connection, "origin" | "status" | "transport" | "enabled" | "close">;

/** Opens the session to a relay the page named, racing only `transports`. */
export type Dial = (url: URL, transports: Transports) => Session;

/** How {@link serve} runs. */
export interface ServeProps {
	/** Opens a player's session. Defaults to this realm's own connection; a test passes an in-memory origin. */
	dial?: Dial;
	/** How often each player reports, in milliseconds. Defaults to 50. */
	interval?: number;
}

/**
 * Serve the page on `port` until the returned function is called: the entry serves its own scope.
 *
 * Says `ready` at once, with what this realm offers, so the page can fall back before handing it
 * anything.
 */
export function serve(port: Port, props?: ServeProps): Dispose {
	const host = new Host(port, props?.dial ?? connect, props?.interval ?? REPORT_INTERVAL);
	return () => host.close();
}

/**
 * Take the transports the page does not race away from this realm, whose connections race whatever it
 * has: a page that removed its WebSocket fallback removed it for the audio too.
 */
export function restrict(transports: Transports, scope: object = globalThis): void {
	if (!transports.webTransport) Reflect.deleteProperty(scope, "WebTransport");
	if (!transports.webSocket) {
		Reflect.deleteProperty(scope, "WebSocket");
		Reflect.deleteProperty(scope, "WebSocketStream");
	}
}

// This realm's own connection to the relay, shared by every player on it, racing what the page races.
function connect(url: URL, transports: Transports): Session {
	restrict(transports);
	return new Moq.Connection({ url });
}

type PlayerMessage = Extract<ToWorker, { type: "player" }>;

class Host {
	readonly #port: Port;
	readonly #dial: Dial;
	readonly #interval: number;
	#transports?: Transports;
	readonly #suspended = new Signal(false);
	readonly #players = new Map<number, Player>();
	readonly #listener = (event: MessageEvent<ToWorker>) => this.#receive(event.data);

	constructor(port: Port, dial: Dial, interval: number) {
		this.#port = port;
		this.#dial = dial;
		this.#interval = interval;

		port.addEventListener("message", this.#listener);
		port.start?.();
		port.postMessage({ type: "ready", support: support() });
	}

	#receive(msg: ToWorker): void {
		try {
			this.#handle(msg);
		} catch (err) {
			const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
			const reply: FromWorker = "id" in msg ? { type: "error", id: msg.id, message } : { type: "error", message };
			this.#port.postMessage(reply);
		}
	}

	#handle(msg: ToWorker): void {
		switch (msg.type) {
			case "hello":
				this.#transports = msg.transports;
				return;
			case "suspend":
				this.#suspended.set(msg.suspended);
				return;
			case "player": {
				const player = this.#players.get(msg.id);
				if (player) {
					player.update(msg);
					return;
				}
				const transports = this.#transports;
				if (!transports) throw new Error("a player before hello");
				this.#players.set(
					msg.id,
					new Player(msg, {
						port: this.#port,
						dial: (url) => this.#dial(url, transports),
						suspended: this.#suspended,
						interval: this.#interval,
					}),
				);
				return;
			}
			case "close":
				this.#players.get(msg.id)?.close();
				this.#players.delete(msg.id);
				return;
			default: {
				const player = this.#players.get(msg.id);
				if (!player) throw new Error(`no player ${msg.id}`);
				player.receive(msg);
			}
		}
	}

	close(): void {
		this.#port.removeEventListener("message", this.#listener);
		for (const player of this.#players.values()) player.close();
		this.#players.clear();
	}
}

/**
 * The page's output clock, as the ring in this realm reads it.
 *
 * Only the page has `AudioContext.getOutputTimestamp`, so the page samples it (see `output` in
 * `protocol.ts`) and this answers from the last sample, moved onto this realm's `performance.now()`.
 * The ring only uses the offset between the pair, so the sample serves as it is, with no extrapolation
 * to now. Before the first sample, and while the page's device has not started, it reads as a device
 * that has not started: both zero, which the postMessage ring takes as no clock rather than a missing
 * one.
 */
class OutputClock implements Pick<AudioContext, "getOutputTimestamp"> {
	#output?: Output;

	set(output: Output | undefined): void {
		this.#output = output;
	}

	getOutputTimestamp(): AudioTimestamp {
		const output = this.#output;
		if (!output) return { contextTime: 0, performanceTime: 0 };
		return { contextTime: output.contextTime, performanceTime: output.at - performance.timeOrigin };
	}
}

interface PlayerProps {
	port: Port;
	dial: (url: URL) => Session;
	suspended: Getter<boolean>;
	interval: number;
}

// One player's audio, fed from a session of the worker's own.
class Player {
	readonly id: number;
	readonly #port: Port;

	// What the page said, as the components here read it.
	readonly #url: Signal<string>;
	readonly #name: Signal<Moq.Path.Valid>;
	readonly #announced: Signal<boolean>;
	readonly #enabled: Signal<boolean>;
	readonly #catalog: Signal<Catalog.Root | undefined>;
	readonly #target = new Signal<Time.Milli>(Time.Milli.zero);
	readonly #maxAge = new Signal<Time.Milli>(Time.Milli.zero);
	readonly #delay = new Signal<Delay>("auto");
	readonly #buffer = new Signal<Time.Milli>(Time.Milli.zero);
	readonly #buffered = new Signal<boolean>(false);
	// Whether the page has said how deep the ring is: the subscription's start and the ring's mode are
	// read once, when they open, so nothing opens before it has.
	readonly #timed = new Signal<boolean>(false);
	readonly #graph = new Signal<Graph | undefined>(undefined);
	readonly #output = new OutputClock();
	readonly #session = new Signal<Session | undefined>(undefined);

	// What goes back in reports. See `Report`.
	#epoch = 0;
	#timeline = 0;
	#arrivals: Arrival[] = [];
	// The clock's shape at the last report: gone, or its rate. See #runClock.
	#shape: number | "none" = "none";
	#closed = false;

	readonly #broadcast: Broadcast;
	readonly #source: Source;
	readonly #supply: Supply;
	#signals = new Effect();

	constructor(msg: PlayerMessage, props: PlayerProps) {
		this.id = msg.id;
		this.#port = props.port;
		this.#url = new Signal(new URL(msg.url).href);
		this.#name = new Signal(Path.from(msg.name));
		this.#announced = new Signal(msg.announced);
		this.#enabled = new Signal(msg.enabled);
		this.#catalog = new Signal(pick(msg));

		// The session to the relay the page named, held only while the page is not put away.
		this.#signals.run((effect) => {
			const session = props.dial(new URL(effect.get(this.#url)));
			effect.cleanup(() => session.close());
			effect.set(this.#session, session, undefined);
			effect.run((inner) => session.enabled.set(!inner.get(props.suspended)));
		});
		const origin = this.#signals.computed((effect) => {
			const session = effect.get(this.#session);
			return session ? effect.get(session.origin) : undefined;
		});

		this.#broadcast = new Broadcast({
			origin,
			name: this.#name,
			announced: this.#announced,
			catalogFormat: "manual",
			catalog: this.#catalog,
		});
		this.#signals.cleanup(() => this.#broadcast.close());

		// The catalog holds the page's pick and nothing else, so the source selects it or nothing.
		this.#source = new Source({ broadcast: this.#broadcast, supported: (config) => this.#probe(config) });
		this.#signals.cleanup(() => this.#source.close());

		this.#supply = new Supply({
			source: this.#source,
			sync: this.#sync(),
			enabled: new Derived([this.#enabled, this.#timed] as const, (enabled, timed) => enabled && timed),
			graph: this.#graph,
			target: this.#target,
			maxAge: this.#maxAge,
		});
		this.#signals.cleanup(() => this.#supply.close());

		// A replaced graph's port goes with it: the worklet behind it is not ours to write any more.
		this.#signals.run((effect) => {
			const graph = effect.get(this.#graph);
			if (graph) effect.cleanup(() => graph.target.port.close());
		});

		this.#signals.interval(() => this.#report(), props.interval);
		this.#signals.run(this.#runClock.bind(this));
	}

	// Report at once when the clock appears, goes, or changes rate, so `Sync` hears of a park or of
	// playback resuming without waiting out the interval. Between those it extrapolates.
	#runClock(effect: Effect): void {
		const ring = effect.get(this.#supply.out.ring);
		const clock = ring ? effect.get(ring.clock) : undefined;
		const shape = clock === undefined ? "none" : clock.rate;
		if (shape === this.#shape) return;
		this.#shape = shape;
		this.#report();
	}

	// The part of `Sync` the supply reads and reports to.
	#sync(): SupplySync {
		return {
			received: (timestamp) => {
				this.#arrivals.push({ timestamp, at: performance.timeOrigin + Time.Milli.now() });
			},
			reset: () => {
				// What was read before the reset belongs to the timeline it ends, so it goes under that one.
				if (this.#arrivals.length > 0) this.#report();
				this.#timeline++;
				this.#report();
			},
			in: { delay: this.#delay, buffer: this.#buffer },
			out: { buffered: this.#buffered },
		};
	}

	// Probe the page's pick against this realm's decoder, which is not guaranteed to match the page's.
	async #probe(config: Catalog.AudioConfig): Promise<boolean> {
		let reason: string | undefined;
		try {
			if (!(await supported(config))) reason = `the worker cannot decode ${config.codec}`;
		} catch (err) {
			reason = `the worker's decoder probe failed: ${err instanceof Error ? err.message : String(err)}`;
		}
		if (reason === undefined) return true;
		if (!this.#closed) this.#port.postMessage({ type: "refused", id: this.id, reason });
		return false;
	}

	update(msg: PlayerMessage): void {
		this.#url.set(new URL(msg.url).href);
		this.#name.set(Path.from(msg.name));
		this.#announced.set(msg.announced);
		this.#enabled.set(msg.enabled);
		this.#catalog.set(pick(msg));
	}

	receive(msg: Exclude<ToWorker, { type: "hello" | "suspend" | "player" | "close" }>): void {
		switch (msg.type) {
			case "timing":
				this.#target.set(msg.target);
				this.#maxAge.set(msg.maxAge);
				this.#delay.set(msg.delay);
				this.#buffer.set(msg.buffer);
				this.#buffered.set(msg.buffered);
				this.#timed.set(true);
				return;
			case "graph": {
				const ring = msg.ring;
				this.#graph.set(
					ring && {
						target: { port: ring.port },
						context: this.#output,
						rate: ring.rate,
						channels: ring.channels,
						conceal: ring.conceal,
					},
				);
				return;
			}
			case "output":
				this.#output.set(msg.output);
				return;
			case "flush":
				this.#epoch = msg.epoch;
				this.#supply.reset();
				// The ring is flushed by now, and the page is waiting on this epoch.
				this.#report();
				return;
		}
	}

	#report(): void {
		if (this.#closed) return;

		const supply = this.#supply.out;
		const ring = supply.ring.peek();
		const clock = ring?.clock.peek();
		const session = this.#session.peek();
		const report: Report = {
			type: "report",
			id: this.id,
			epoch: this.#epoch,
			timeline: this.#timeline,
			clock: clock && {
				timestamp: clock.timestamp,
				at: performance.timeOrigin + clock.reference,
				rate: clock.rate,
			},
			arrivals: this.#arrivals,
			spread: supply.spread.peek(),
			rate: supply.rate.peek(),
			ring: ring && {
				timestamp: ring.timestamp.peek(),
				stalled: ring.stalled.peek(),
				underruns: ring.underruns.peek(),
				debug: ring.debug.peek(),
			},
			stats: supply.stats.peek(),
			skipped: supply.skipped.peek(),
			buffered: supply.buffered.peek(),
			connection: session?.status.peek() ?? "disconnected",
			transport: session?.transport.peek(),
			resolved: this.#broadcast.out.active.peek() !== undefined,
		};
		this.#arrivals = [];
		this.#port.postMessage(report);
	}

	close(): void {
		this.#closed = true;
		this.#signals.close();
	}
}

// The catalog the worker's broadcast holds: the page's pick, alone, or none while the page has none. The
// supply keeps its estimate across the gap, as the page's does across a rendition that blinks.
function pick(msg: PlayerMessage): Catalog.Root | undefined {
	if (msg.track === undefined) return undefined;
	return { audio: { renditions: { [msg.track]: msg.config } } } as Catalog.Root;
}

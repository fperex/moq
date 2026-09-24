/**
 * The messages between the page and its audio worker, and how the page starts one.
 *
 * One dedicated worker per document feeds the ring of every player that hands it its audio (see
 * `host.ts`): a session of its own to each relay, the subscription, the container consumer, the
 * arrival estimate, the decoder and the ring writes. The page keeps what only a document can have,
 * the AudioContext and the worklet node, and hands the worker one end of a channel whose other end
 * the worklet reads ring writes from (see `Port` in `../render.ts`). It also keeps the `Sync` every
 * track paces against and everything the UI reads, fed from the worker's reports.
 *
 * Free of anything only Vite can resolve, so it runs under `bun test` and in the worker alike.
 *
 * @module
 */

import type * as Catalog from "@moq/hang/catalog";
import type * as Container from "@moq/hang/container";
import { Connection, Time } from "@moq/net";
import type { Delay } from "../../sync";
import type { Stats } from "../decoder";
import type { Snapshot } from "../playout";

/** The transports a realm's connection would race. */
export interface Transports {
	/** WebTransport: the global exists, and the browser is not one the connection keeps off it. */
	webTransport: boolean;
	/** The WebSocket fallback: `WebSocket` or `WebSocketStream` exists. */
	webSocket: boolean;
}

/** What the worker's realm offers, reported before it is handed anything. */
export interface Support extends Transports {
	/** A native WebCodecs `AudioDecoder`, which is all the worker decodes with. */
	audioDecoder: boolean;
}

/** What this realm offers. */
export function support(): Support {
	const scope = globalThis as Record<string, unknown>;
	return {
		audioDecoder: typeof scope.AudioDecoder === "function",
		webTransport: Connection.isWebTransportSupported(),
		webSocket: typeof scope.WebSocket === "function" || typeof scope.WebSocketStream === "function",
	};
}

/**
 * Why the page cannot hand its audio to a worker offering `worker`, or undefined when it can.
 *
 * The worker races exactly what the page races (see `hello`), so a transport the page would race and
 * the worker cannot is audio on another path than the picture, and the page keeps it instead.
 */
export function decide(worker: Support, page: Transports = support()): string | undefined {
	if (!worker.audioDecoder) return "AudioDecoder is not available in a dedicated worker";
	if (page.webTransport && !worker.webTransport) return "WebTransport is not available in a dedicated worker";
	if (page.webSocket && !worker.webSocket) return "WebSocket is not available in a dedicated worker";
	return undefined;
}

/** The graph the page built for a player: where its worklet reads ring writes from, and what it runs at. */
export interface Graph {
	/** This end writes the ring; the worklet holds the other. Transferred with the message. */
	port: MessagePort;
	/** The rate the page's AudioContext runs at, which is the rate the ring is written at. */
	rate: number;
	/** The channel count the worklet node was built with. */
	channels: number;
	/** Whether the reader conceals a gap with synthesized audio. */
	conceal: boolean;
}

/**
 * When a sample of the page's AudioContext leaves the output device, as `getOutputTimestamp` reads it.
 *
 * `at` is absolute (`performance.timeOrigin` plus `performanceTime`): the two realms' `performance.now()`
 * start at different times.
 */
export interface Output {
	/** The context time of the sample, in seconds. */
	contextTime: number;
	/** When it leaves the device, in absolute milliseconds. */
	at: number;
}

/**
 * The rendition the page picked, or none: the page's pick went away (a publisher hiding its microphone
 * takes it out of the catalog for a moment), and the worker plays nothing until it comes back.
 */
export type Rendition = { track: string; config: Catalog.AudioConfig } | { track?: undefined; config?: undefined };

/** What the page tells the worker. Everything but `hello` and `suspend` is about the player named by `id`. */
export type ToWorker =
	// The transports the worker's connections may race: what the page's would. Sent once, straight
	// after `ready`, before any player.
	| { type: "hello"; transports: Transports }
	// Play this rendition of this broadcast, or keep playing it with this changed. Sent whole on any
	// change; the first one starts the player. `enabled` is whether to download at all (a mute).
	| ({
			type: "player";
			id: number;
			url: string;
			name: string;
			announced: boolean;
			enabled: boolean;
	  } & Rendition)
	// What the supply reads of the page's `Sync`: the ring's target (`out.delay` plus `out.offset`),
	// the age budget, the delay mode, the configured lookahead (`in.buffer`) and whether it applies
	// (`out.buffered`). Sent whole on any change. The player downloads nothing until the first one.
	| {
			type: "timing";
			id: number;
			target: Time.Milli;
			maxAge: Time.Milli;
			delay: Delay;
			buffer: Time.Milli;
			buffered: boolean;
	  }
	// Write the ring into this graph from now on, or into none while the page has no graph.
	| { type: "graph"; id: number; ring?: Graph }
	// The page's output clock, or none while its device has not started. Sent when the graph is built,
	// when the context changes state, and every second.
	| { type: "output"; id: number; output?: Output }
	// Flush the ring. Every report composed after it carries `epoch`, so the page can drop the ones that
	// were already on their way.
	| { type: "flush"; id: number; epoch: number }
	// The page was put away (pagehide, unload), or came back (pageshow, shown again): hold no session
	// while it is away, as the page's own connections do.
	| { type: "suspend"; suspended: boolean }
	// Stop the player and release everything it holds.
	| { type: "close"; id: number };

/** A playhead sample on its way to the page's `Sync`. */
export interface Clock {
	/** The media position the playhead held at `at`. */
	timestamp: Time.Micro;
	/** When it held it, in absolute milliseconds. */
	at: number;
	/** Media time per unit of wall time: 1 while playing, 0 while parked. */
	rate: number;
}

/** An audio frame the worker read: its media timestamp, and when it read it, in absolute milliseconds. */
export interface Arrival {
	timestamp: Time.Milli;
	at: number;
}

/** The ring, as the worker last read it. */
export interface Ring {
	/** Where the reader has played up to, or undefined while the ring has no playhead. */
	timestamp: Time.Micro | undefined;
	/** Whether the ring is filling (or refilling) rather than playing. */
	stalled: boolean;
	/** How many times the ring ran dry mid-playback. */
	underruns: number;
	/** Every counter at once, or undefined until the first sample lands. */
	debug: Snapshot | undefined;
}

/** What the worker says about one player, every 50 ms and at once when its clock appears, goes or changes rate. */
export interface Report {
	type: "report";
	id: number;
	/** The epoch of the last `flush` the worker applied, or 0 before any. */
	epoch: number;
	/**
	 * How many times the worker reset the timeline on its own: a new publisher, or a discontinuity.
	 *
	 * When it moves, the page resets its `Sync` before anything else in the report. Frames read before a
	 * reset go out in a report of their own first, so no report's arrivals span one.
	 */
	timeline: number;
	/** The ring's playhead as a clock, or undefined while it is not one. */
	clock: Clock | undefined;
	/** The audio frames read since the previous report, in order. */
	arrivals: Arrival[];
	/** The rendition's arrival estimate, while it has one. */
	spread: Time.Milli | undefined;
	/** The rate the decoder turned out to emit, once it differs from the graph's. */
	rate: number | undefined;
	/** The ring, while there is a graph to write it into. */
	ring: Ring | undefined;
	/** Cumulative statistics across every subscription. */
	stats: Stats | undefined;
	/** Groups that lost content above the decoder, across every subscription. */
	skipped: number;
	/** What is buffered: network jitter and decode buffer, combined. */
	buffered: Container.BufferedRanges;
	/** The worker's own session to the relay. */
	connection: Connection.Status;
	/** What that session runs over, or undefined while disconnected. */
	transport: Connection.Transport | undefined;
	/** Whether the broadcast resolved on that session. */
	resolved: boolean;
}

/** What the worker tells the page. */
export type FromWorker =
	// Posted on load, before anything else, so the page can fall back without handing it anything.
	| { type: "ready"; support: Support }
	| Report
	// The worker cannot play this player's rendition; the page plays it instead.
	| { type: "refused"; id: number; reason: string }
	// Something went wrong: with this player's message when there is an `id`, in the worker itself otherwise.
	| { type: "error"; id?: number; message: string };

/** A started worker the page talks to. */
export interface Handle {
	/** What its realm offers. */
	readonly support: Support;
	/** Post one message, transferring `transfer`. */
	post(msg: ToWorker, transfer?: Transferable[]): void;
	/** Everything the worker says after `ready`, in order, and its own failures as an `error` with no `id`. */
	onmessage: ((msg: FromWorker) => void) | undefined;
	/** Terminate it. */
	close(): void;
}

/** A worker, or why the page cannot use one. */
export type Spawned = { handle: Handle } | { reason: string };

/**
 * Start a worker with `create` and hand it the page's transports once it says it can do the job.
 *
 * Resolves to the reason the page has to fall back when the worker cannot be created (a CSP refusing
 * `blob:` workers makes Chromium throw, and the lazy chunk it comes in can fail to load), reports a
 * load failure (the same CSP reaches Firefox as an `error` event), or lacks what {@link decide} needs.
 */
export async function spawn(create: () => Worker | Promise<Worker>, page: Transports = support()): Promise<Spawned> {
	let worker: Worker;
	try {
		worker = await create();
	} catch (err) {
		return { reason: `the worker could not be created: ${explain(err)}` };
	}

	return new Promise<Spawned>((resolve) => {
		const fail = (reason: string) => {
			detach(worker);
			worker.terminate();
			resolve({ reason });
		};

		worker.onerror = (event: ErrorEvent) => {
			// Before `ready` this can only be the script failing to load.
			event.preventDefault();
			fail(`the worker failed to load: ${event.message || "error event"}`);
		};
		worker.onmessageerror = () => fail("the worker's first message could not be deserialized");
		worker.onmessage = (event: MessageEvent<FromWorker>) => {
			const msg = event.data;
			if (msg?.type !== "ready") {
				fail(`the worker said ${JSON.stringify(msg?.type)} before it said ready`);
				return;
			}

			const reason = decide(msg.support, page);
			if (reason !== undefined) {
				fail(reason);
				return;
			}

			const hello: ToWorker = { type: "hello", transports: page };
			worker.postMessage(hello);
			resolve({ handle: handle(worker, msg.support) });
		};
	});
}

function handle(worker: Worker, support: Support): Handle {
	const out: Handle = {
		support,
		onmessage: undefined,
		post: (msg, transfer) => worker.postMessage(msg, transfer ?? []),
		close: () => {
			detach(worker);
			worker.terminate();
		},
	};

	worker.onmessage = (event: MessageEvent<FromWorker>) => out.onmessage?.(event.data);
	worker.onerror = (event: ErrorEvent) => {
		event.preventDefault();
		out.onmessage?.({ type: "error", message: `the worker failed: ${event.message || "error event"}` });
	};
	worker.onmessageerror = () =>
		out.onmessage?.({ type: "error", message: "a message from the worker could not be deserialized" });

	return out;
}

function detach(worker: Worker): void {
	worker.onmessage = null;
	worker.onerror = null;
	worker.onmessageerror = null;
}

function explain(err: unknown): string {
	return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

/**
 * How long a player's worker has to play audio, ten times what a healthy start took on the bench.
 *
 * Counted only while the worker has everything it needs from the page; see {@link Deadline}.
 */
export const AUDIO_DEADLINE = Time.Milli(5_000);

/**
 * How often the page checks on its worker.
 *
 * A check more than twice this late ran behind a page that was stalled, frozen or hidden, and whatever
 * the worker said in that time is still queued behind it, so a late check counts for nothing.
 */
export const TICK = Time.Milli(250);

/**
 * Where a player's worker has got to on its way to playing audio: what it is waiting for.
 *
 * `audio` waits on the publisher rather than on the worker (nothing to play has reached it), so it never
 * counts; `played` counts only while audio keeps reaching it, for the same reason.
 */
export type Stage = "ready" | "connected" | "resolved" | "audio" | "played";

// What the worker never managed, by the stage it stopped at.
const STUCK: Record<Exclude<Stage, "audio">, string> = {
	ready: "it never became ready",
	connected: "its session to the relay never connected",
	resolved: "its session never found the broadcast",
	played: "the audio it read never played",
};

/**
 * The time a player's worker has to play audio, counted only while it is the worker's to spend.
 *
 * The page ticks it on its own timer, every {@link TICK}, with where the worker is and whether anything
 * on the page holds the audio up: a mute or a pause, an instant delay, no graph or a context that is not
 * running, no rendition, or the page's own session or broadcast down. None of those is the worker's to
 * answer for, and nor is a check the page made late. A worker that has played never needs it again.
 */
export class Deadline {
	#last?: number;
	#spent = 0;

	/**
	 * Count the time since the last tick, then say why the page should take the audio back, once the
	 * worker has spent {@link AUDIO_DEADLINE} without playing it.
	 *
	 * `now` is the page's `performance.now()`. `target` is the ring's depth: a ring fills that much before
	 * it plays anything, so the last stage waits that much longer.
	 */
	tick(now: number, at: { stage: Stage; held: boolean; target: Time.Milli }): string | undefined {
		const elapsed = this.#last === undefined ? 0 : now - this.#last;
		this.#last = now;
		if (at.held || at.stage === "audio" || elapsed > 2 * TICK) return undefined;

		this.#spent += elapsed;
		const limit = at.stage === "played" ? AUDIO_DEADLINE + at.target : AUDIO_DEADLINE;
		if (this.#spent < limit) return undefined;
		return `the audio worker played nothing in ${AUDIO_DEADLINE / 1000} s: ${STUCK[at.stage]}`;
	}
}

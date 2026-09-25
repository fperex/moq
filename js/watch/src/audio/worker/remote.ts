/**
 * The page's half of a player whose audio the page's worker feeds: what `Supply` does on the page, done
 * in the worker (see `host.ts`), and published here as the same outputs a `Supply` publishes.
 *
 * The page keeps the graph and `Sync`. It tells the worker which rendition to play, how deep to hold the
 * ring and where the worklet reads it from, and it applies what the worker reports back to `Sync` and to
 * those outputs, so the `Decoder` reads either supply alike.
 *
 * It also says when the page has to take the audio back (see `out.failure`): the page's worker is not
 * available, fails or stops reporting, refuses this player's rendition or fails on it, or plays nothing
 * within `AUDIO_DEADLINE`, or the worklet could not read what it was sent.
 *
 * @module
 */

import type * as Container from "@moq/hang/container";
import type * as Moq from "@moq/net";
import { Time } from "@moq/net";
import { type Computed, Effect, type Getter, type Readonlys, readonlys, Signal } from "@moq/signals";
import type { Clock, Sync } from "../../sync";
import type { Stats } from "../decoder";
import type { Snapshot } from "../playout";
import type { Port, ToMain } from "../render";
import type { Source } from "../source";
import type { Graph, RingState, SupplyOutput } from "../supply";
import { type Lease, Pool } from "./pool";
import { Deadline, type FromWorker, type Output, type Report, type Stage, TICK, type ToWorker } from "./protocol";

// How often the page samples its output clock for the worker. Device and system clocks drift apart by
// tens of parts per million, so a sample a second old maps a playhead to well under a millisecond.
const OUTPUT_INTERVAL = 1_000;

let shared: Pool | undefined;

/**
 * The page's one audio worker, shared by every player that offloads.
 *
 * Compiled and inlined as a blob URL by Vite (`?worker&inline`), as `@moq/publish` builds its capture
 * worker, but behind a dynamic import: it ships as a chunk of its own, which only a page that offloads
 * ever loads.
 */
function pool(): Pool {
	shared ??= new Pool(async () => {
		const { default: AudioWorker } = await import("./worker.ts?worker&inline");
		return new AudioWorker();
	});
	return shared;
}

/**
 * Terminate the page's worker now and forget everything the page learned about it, so the next player
 * starts another.
 *
 * Exists for tests, which otherwise share one page across cases.
 *
 * @internal
 */
export function resetShared(): void {
	shared?.close();
	shared = undefined;
}

/** A graph the page built: a `Graph` whose context is the page's own, which only the page can read. */
export interface PageGraph extends Graph {
	context: AudioContext;
}

/** The wired dependencies of a {@link Remote}. */
export type RemoteInput = {
	/** The relay the worker dials for this player's broadcast. */
	url: Getter<URL | undefined>;
	/** Whether to download the audio track. */
	enabled: Getter<boolean>;
	/** The graph the page built, or undefined while it has none. */
	graph: Getter<PageGraph | undefined>;
	/** The ring's depth: `sync.out.delay` plus `sync.out.offset`. */
	target: Getter<Time.Milli>;
	/** The age budget the subscription and the container consumer skip against. See `audioMaxAge`. */
	maxAge: Getter<Time.Milli>;
};

/** Constructor properties for {@link Remote}. */
export type RemoteProps = RemoteInput & {
	/** The page's rendition selector, whose pick the worker plays. */
	source: Source;
	/** The page's playback clock. */
	sync: Sync;
	/** The worker to hand the audio to. Defaults to the page's own. */
	pool?: Pool;
};

type PlayerMessage = Extract<ToWorker, { type: "player" }>;
type TimingMessage = Extract<ToWorker, { type: "timing" }>;

/** Why the page has to take a player's audio back from its worker. */
export interface Failure {
	reason: string;
	/**
	 * Whose trouble it is: this player's alone, or the worker's, which every player on the page shares and
	 * the pool has already warned about once.
	 */
	scope: "player" | "worker";
}

type RemoteOutput = SupplyOutput & {
	/** Whether the worker took this player: it is ready, and hears about it. */
	ready: Signal<boolean>;
	/** What the worker's session to the relay runs over, or undefined while it has none. */
	transport: Signal<Moq.Connection.Transport | undefined>;
	/** Why the page has to take this player's audio back, once it has to. Final. */
	failure: Signal<Failure | undefined>;
};

/** A supply that runs in the page's worker, as the page sees it. See the module documentation. */
export class Remote {
	readonly in: Readonlys<RemoteInput>;
	readonly source: Source;
	readonly sync: Sync;

	readonly #out: RemoteOutput = {
		rate: new Signal<number | undefined>(undefined),
		spread: new Signal<Time.Milli | undefined>(undefined),
		buffered: new Signal<Container.BufferedRanges>([]),
		skipped: new Signal<number>(0),
		stats: new Signal<Stats | undefined>(undefined),
		ring: new Signal<RingState | undefined>(undefined),
		ready: new Signal<boolean>(false),
		transport: new Signal<Moq.Connection.Transport | undefined>(undefined),
		failure: new Signal<Failure | undefined>(undefined),
	};
	readonly out = readonlys(this.#out);

	// The ring as the worker last reported it, handed out as `out.ring` while the worker has the page's
	// graph to write it into.
	readonly #ring = {
		timestamp: new Signal<Time.Micro | undefined>(undefined),
		clock: new Signal<Clock | undefined>(undefined),
		stalled: new Signal<boolean>(true),
		underruns: new Signal<number>(0),
		debug: new Signal<Snapshot | undefined>(undefined),
	};

	readonly #lease: Lease;

	// Whether the worker has a player to take the rest: the first `player` went out.
	readonly #started = new Signal(false);

	// What the page asks of the worker, deduped by value, so a notification that changes nothing sends
	// nothing.
	readonly #player: Computed<PlayerMessage | undefined>;
	readonly #timing: Computed<TimingMessage>;

	// The page's own flushes and the worker's own resets, as `flush` and `Report` in protocol.ts describe
	// them.
	#epoch = 0;
	#timeline = 0;

	// How long the worker has to play this player's audio, and what it has to go on: the worker's last
	// report, whether audio reached it since the last check, and whether the ring has ever played.
	readonly #deadline = new Deadline();
	#last?: Report;
	#heard = false;
	readonly #played = new Signal(false);

	#closed = false;
	#signals = new Effect();

	constructor(props: RemoteProps) {
		this.in = {
			url: props.url,
			enabled: props.enabled,
			graph: props.graph,
			target: props.target,
			maxAge: props.maxAge,
		};
		this.source = props.source;
		this.sync = props.sync;

		const lease = (props.pool ?? pool()).acquire();
		this.#lease = lease;
		this.#signals.cleanup(() => lease.release());
		void lease.ready.then((reason) => {
			if (this.#closed) return;
			if (reason !== undefined) {
				this.#fail({ reason, scope: "worker" });
				return;
			}
			lease.onmessage = (msg) => this.#receive(msg);
			this.#out.ready.set(true);
		});

		this.#player = this.#signals.computed((effect): PlayerMessage | undefined => {
			const url = effect.get(this.in.url);
			const broadcast = effect.get(this.source.in.broadcast);
			if (!url || !broadcast) return undefined;

			const player: PlayerMessage = {
				type: "player",
				id: lease.id,
				url: url.href,
				name: effect.get(broadcast.in.name),
				announced: effect.get(broadcast.in.announced),
				enabled: effect.get(this.in.enabled),
			};
			const track = effect.get(this.source.out.track);
			const config = effect.get(this.source.out.config);
			return track !== undefined && config !== undefined ? { ...player, track, config } : player;
		});
		this.#timing = this.#signals.computed(
			(effect): TimingMessage => ({
				type: "timing",
				id: lease.id,
				target: effect.get(this.in.target),
				maxAge: effect.get(this.in.maxAge),
				delay: effect.get(this.sync.in.delay),
				buffer: effect.get(this.sync.in.buffer),
				buffered: effect.get(this.sync.out.buffered),
			}),
		);

		this.#signals.run(this.#runPlayer.bind(this));
		this.#signals.run(this.#runTiming.bind(this));
		this.#signals.run(this.#runGraph.bind(this));
		this.#signals.run(this.#runFlush.bind(this));
		this.#signals.run(this.#runInstant.bind(this));
		this.#signals.run(this.#runDeadline.bind(this));
	}

	// Tell the worker what to play, whole, whenever any of it changes. A player costs the worker a session
	// to the relay, so it hears of none until the page has picked a rendition; one that goes after that is
	// sent as none, which the worker plays out as the page's own supply would.
	#runPlayer(effect: Effect): void {
		if (!effect.get(this.#out.ready)) return;
		const player = effect.get(this.#player);
		if (!player) return;
		if (player.track === undefined && !this.#started.peek()) return;

		this.#lease.post(player);
		this.#started.set(true);
	}

	// What the supply reads of the page's `Sync`, whenever any of it changes.
	#runTiming(effect: Effect): void {
		if (!effect.get(this.#started)) return;
		const timing = effect.get(this.#timing);
		if (timing) this.#lease.post(timing);
	}

	/**
	 * Hand the worker the page's graph: one end of a channel whose other end the worklet takes ring writes
	 * from (see `Port` in `render.ts`), so the writes never wait on the page's event loop.
	 */
	#runGraph(effect: Effect): void {
		if (!effect.get(this.#started)) return;
		const graph = effect.get(this.in.graph);
		if (!graph) return;

		// The worklet reports to every port it holds, the node's own included: read here, where the page
		// sees the ring play, or hears that the worklet could not read what it was sent, without waiting
		// on the worker, and read at all, since a port never started would queue every report for the
		// node's life.
		const node = graph.target.port;
		effect.event(node, "message", (event) => {
			const msg = (event as MessageEvent<ToMain>).data;
			if (msg?.type === "state" && !msg.debug.fresh) this.#played.set(true);
			if (msg?.type === "unreadable") {
				this.#fail({
					reason: "the audio worklet could not deserialize a message sent to it",
					scope: "player",
				});
			}
		});
		node.start();

		const { port1, port2 } = new MessageChannel();
		const handoff: Port = { type: "port", port: port1 };
		node.postMessage(handoff, [port1]);
		const ring = { port: port2, rate: graph.rate, channels: graph.channels, conceal: graph.conceal };
		this.#lease.post({ type: "graph", id: this.#lease.id, ring }, [port2]);
		effect.cleanup(() => this.#lease.post({ type: "graph", id: this.#lease.id }));
		effect.set(this.#out.ring, this.#ring, undefined);

		// Only the page can read its output clock, which the postMessage ring maps its playhead through.
		const output = () => this.#lease.post({ type: "output", id: this.#lease.id, output: sample(graph.context) });
		output();
		effect.event(graph.context, "statechange", output);
		effect.interval(output, OUTPUT_INTERVAL);
	}

	/**
	 * Flush the ring when the download stops, as the page's own supply does.
	 *
	 * The worker flushes on the mute itself; the page flushes too, so the reports it composed before it
	 * heard of the mute are dropped rather than handing `Sync` a playhead from before it.
	 */
	#runFlush(effect: Effect): void {
		if (!effect.get(this.in.enabled)) return;
		effect.cleanup(() => this.#flush());
	}

	// Drop what the ring holds when the delay turns instant, as the page's own supply does. See #runFlush.
	#runInstant(effect: Effect): void {
		if (!effect.get(this.in.enabled)) return;
		if (effect.get(this.sync.in.delay) !== "instant") return;
		this.#flush();
	}

	#flush(): void {
		if (this.#started.peek()) {
			this.#epoch++;
			this.#lease.post({ type: "flush", id: this.#lease.id, epoch: this.#epoch });
		}

		// A flushed ring has no playhead until the next write anchors it. Mirrored now rather than at the
		// worker's next report, as the page's own rings mirror a flush before the worklet applies it.
		this.#ring.timestamp.set(undefined);
		this.#ring.clock.set(undefined);
		this.#ring.stalled.set(true);
	}

	#receive(msg: FromWorker): void {
		switch (msg.type) {
			case "report":
				this.#report(msg);
				return;
			case "refused":
				this.#fail({ reason: msg.reason, scope: "player" });
				return;
			case "error":
				this.#fail({ reason: msg.message, scope: msg.id === undefined ? "worker" : "player" });
				return;
		}
	}

	#fail(failure: Failure): void {
		if (this.#out.failure.peek() === undefined) this.#out.failure.set(failure);
	}

	/**
	 * Give the worker `AUDIO_DEADLINE` to play, checked on the page's own timer, until it has played.
	 *
	 * The page's session and broadcast are read through its broadcast, which a session that drops
	 * withdraws. A ring that played once is done with the deadline for good: after that, a worker that
	 * goes wrong is the liveness check's to catch (see `Liveness`), and anything else is the path's.
	 */
	#runDeadline(effect: Effect): void {
		if (effect.get(this.#played)) return;
		if (effect.get(this.#out.failure) !== undefined) return;
		effect.interval(() => {
			const stage = this.#stage();
			this.#heard = false;
			const reason = this.#deadline.tick(performance.now(), {
				stage,
				held: this.#held(),
				target: this.in.target.peek(),
			});
			if (reason !== undefined) this.#fail({ reason, scope: "player" });
		}, TICK);
	}

	// Where the worker is on its way to playing this player's audio. See `Stage`.
	#stage(): Stage {
		if (!this.#out.ready.peek()) return "ready";
		const report = this.#last;
		if (report?.connection !== "connected") return "connected";
		if (!report.resolved) return "resolved";
		return this.#heard ? "played" : "audio";
	}

	// Whether something on the page holds the audio up, which the worker is not to answer for.
	#held(): boolean {
		const broadcast = this.source.in.broadcast.peek();
		if (!broadcast?.out.active.peek() || broadcast.out.status.peek() !== "live") return true;
		if (this.source.out.track.peek() === undefined) return true;
		if (!this.in.enabled.peek() || this.sync.in.delay.peek() === "instant") return true;
		return this.in.graph.peek()?.context.state !== "running";
	}

	#report(report: Report): void {
		// What the deadline goes on, whichever flush it was composed under.
		this.#last = report;
		if (report.arrivals.length > 0) this.#heard = true;
		if (report.ring?.debug?.fresh === false) this.#played.set(true);

		// Composed before the worker applied the page's last flush: it describes the ring that flush threw away.
		if (report.epoch < this.#epoch) return;

		// The worker reset the timeline on its own (a new publisher, a discontinuity), as the page's own
		// supply resets `Sync`. Frames it read before the reset came in a report of their own.
		if (report.timeline > this.#timeline) {
			this.#timeline = report.timeline;
			this.sync.reset();
		}

		// Stamped when the worker read them, so the hop to the page does not read as the path being late.
		for (const { timestamp, at } of report.arrivals) {
			this.sync.received(timestamp, "audio", Time.Milli(at - performance.timeOrigin));
		}

		this.#out.spread.set(report.spread);
		this.#out.rate.set(report.rate);
		this.#out.stats.set(report.stats);
		this.#out.skipped.set(report.skipped);
		this.#out.buffered.set(report.buffered);
		this.#out.transport.set(report.transport);

		const ring = report.ring;
		if (ring) {
			this.#ring.timestamp.set(ring.timestamp);
			this.#ring.stalled.set(ring.stalled);
			this.#ring.underruns.set(ring.underruns);
			this.#ring.debug.set(ring.debug);
		}

		const clock = report.clock;
		this.#ring.clock.set(
			clock && {
				timestamp: clock.timestamp,
				reference: Time.Milli(clock.at - performance.timeOrigin),
				rate: clock.rate,
			},
		);
	}

	// Flush the audio buffer and re-stall, re-anchoring playback to the next frame.
	// Use in buffered mode at an utterance boundary (see Sync.reset).
	reset(): void {
		this.#flush();
	}

	close(): void {
		this.#closed = true;
		this.#signals.close();
	}
}

/**
 * When the context's current sample leaves the output device, or undefined while the device has not
 * started, which `getOutputTimestamp` reads as both zero.
 */
function sample(context: Pick<AudioContext, "getOutputTimestamp">): Output | undefined {
	const { contextTime, performanceTime } = context.getOutputTimestamp();
	if (contextTime === undefined || performanceTime === undefined) return undefined;
	if (contextTime === 0 && performanceTime === 0) return undefined;
	return { contextTime, at: performance.timeOrigin + performanceTime };
}

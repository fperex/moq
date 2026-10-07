import type * as Container from "@moq/hang/container";
import * as Util from "@moq/hang/util";
import type * as Moq from "@moq/net";
import { Time } from "@moq/net";
import {
	type Computed,
	Effect,
	type Getter,
	getter,
	type Inputs,
	type Readonlys,
	readonlys,
	Signal,
} from "@moq/signals";
import { hostedAssets } from "../assets";
import type { Sync } from "../sync";
import { reportTransport, supportsSharedArrayBuffer } from "./buffer";
import { AUTO_MAX_AGE, target } from "./latency";
import type { Snapshot } from "./playout";
import type { Close } from "./render";
// A blob: URL, or a hosted file when assets() is set; see vite-plugin-worklet.
import RenderWorklet from "./render-worklet.ts?worklet";
import type { Source } from "./source";
import { Supply } from "./supply";
import { supported } from "./supported";
import { type PageGraph, Remote } from "./worker/remote";

export type DecoderInput = {
	// Whether to download the audio track. Defaults to true.
	enabled: Getter<boolean>;

	/**
	 * Whether a gap in the audio is concealed with synthesized audio rather than played as a ramp
	 * into silence. Defaults to true.
	 *
	 * Concealment repeats the pitch period of the last real audio, fades it out over a long outage
	 * and ends in digital silence, and splices the media back on where it lines up. Turning it off
	 * leaves a gap audible as a gap, which is what a listener who would rather hear the loss than
	 * hear invented audio wants.
	 *
	 * Read when the audio graph is built, since it belongs to the reader running inside the worklet.
	 */
	conceal: Getter<boolean>;

	/**
	 * Whether the player is on the page at all. Defaults to true.
	 *
	 * A player that is not can never be heard, so it releases its audio context, the render thread
	 * behind it and the ring, and builds them again if it comes back. Separate from `enabled`, which
	 * a mute also clears: a muted tile keeps the context it has, so the unmute costs no gesture.
	 */
	attached: Getter<boolean>;

	/**
	 * The relay the broadcast is read from, which the page's audio worker dials for the audio. Without one
	 * the audio stays on the page.
	 */
	url: Getter<URL | undefined>;

	/**
	 * Whether the audio is fed from a dedicated worker rather than the page's main thread. Defaults to true.
	 *
	 * The worker subscribes, decodes and writes the ring on a session of its own to {@link url}, so a busy
	 * main thread cannot starve the ring. One worker serves every player on the page. Needs a {@link url},
	 * a `Worker` and Web Audio; without them the audio stays on the page. So it does, for good, once the
	 * worker cannot start (a CSP without `worker-src blob:`, say), fails, stops reporting, refuses the
	 * rendition, or plays nothing in five seconds of trying, or once the worklet cannot read what it is
	 * sent: `out.thread` says which.
	 */
	offload: Getter<boolean>;
};

/** Constructor properties for {@link Decoder}. */
export type DecoderProps = Inputs<DecoderInput> & {
	/** Rendition selector supplying encoded audio. */
	source: Source;
	/** Shared playback clock. */
	sync: Sync;
};

type DecoderOutput = {
	context: Signal<AudioContext | undefined>;

	// The root of the audio graph, which can be used for custom visualizations.
	// Downcast to AudioNode so it matches Publish.Audio
	root: Signal<AudioNode | undefined>;

	sampleRate: Signal<number | undefined>;
	stats: Signal<Stats | undefined>;

	// Current playback timestamp from worklet
	timestamp: Signal<Time.Milli | undefined>;

	// Whether the audio buffer is stalled (waiting to fill)
	stalled: Signal<boolean>;

	// How many times the ring ran dry mid-playback, so the UI can show that the target is too low.
	underruns: Signal<number>;

	// Combined buffered ranges (network jitter + decode buffer)
	buffered: Signal<Container.BufferedRanges>;

	/**
	 * Every audio ring counter at once: what it holds, what the playout engine did with it, and what
	 * either end threw away. Undefined until the graph is built and the ring has reported.
	 *
	 * @internal
	 */
	debug: Signal<Snapshot | undefined>;

	/**
	 * Which thread feeds the ring: the page's worker, with what its session runs over, or the page's own,
	 * with why when the worker could have and did not. Undefined while the worker is starting.
	 *
	 * @internal
	 */
	thread: Signal<Thread | undefined>;
};

/** Which thread feeds the audio ring. See `Decoder.out.thread`. */
type Thread = { kind: "worker"; transport: Moq.Connection.Transport | undefined } | { kind: "main"; reason?: string };

// What the audio graph is built for. `catalog` is the advertised rate and `sampleRate` the rate the
// decoder actually outputs, which can differ (Opus decodes to 48kHz on Chrome/Firefox but to the
// configured rate on Safari). Until a frame arrives the graph is pre-built at the advertised rate.
type Shape = {
	catalog: number;
	sampleRate: number;
	channels: number;
};

/** Cumulative audio statistics since the decoder started. */
export interface Stats {
	/** Number of encoded bytes received. */
	bytesReceived: number;
}

// The supply feeding the ring, and the graph built for it.
type Active = { graph: Signal<PageGraph | undefined> } & (
	| { kind: "main"; supply: Supply }
	| { kind: "worker"; supply: Remote }
);

/**
 * Downloads audio from a track and emits it to an AudioContext.
 *
 * The user is responsible for hooking up audio to speakers, an analyzer, etc.
 */
export class Decoder {
	readonly in: Readonlys<DecoderInput>;
	readonly source: Source;
	readonly sync: Sync;

	readonly #out: DecoderOutput = {
		context: new Signal<AudioContext | undefined>(undefined),
		root: new Signal<AudioNode | undefined>(undefined),
		sampleRate: new Signal<number | undefined>(undefined),
		stats: new Signal<Stats | undefined>(undefined),
		timestamp: new Signal<Time.Milli | undefined>(undefined),
		stalled: new Signal<boolean>(true),
		underruns: new Signal<number>(0),
		buffered: new Signal<Container.BufferedRanges>([]),
		debug: new Signal<Snapshot | undefined>(undefined),
		thread: new Signal<Thread | undefined>(undefined),
	};
	readonly out = readonlys(this.#out);

	// Everything that feeds the ring (the subscription, the estimator, the decoder and the writes) and the
	// graph it writes into: on the page, or in the page's worker. See #runSupply.
	readonly #active = new Signal<Active | undefined>(undefined);

	// Where the supply runs, once decided. See #runSupply.
	readonly #mode: Computed<"main" | "worker">;

	// Why the page took the audio back from its worker, once it has: for good. See #runFallback.
	readonly #fallback = new Signal<string | undefined>(undefined);

	// The context the graph runs in, with what it was built for. Nodes are built against this and not
	// against the shape, so a node never meets a context the shape has already moved past.
	readonly #built = new Signal<{ context: AudioContext; rate: number; channels: number } | undefined>(undefined);

	// The context, worklet, and ring are keyed on this alone. It outlives a rendition's absence, so
	// the queued tail plays out and a return with the same shape reuses the graph.
	#shape = new Signal<Shape | undefined>(undefined);

	// The rendition is absent and the ring has drained its tail, so the graph has nothing to play.
	readonly #idle: Computed<boolean>;

	// The subscription's max age: the shared budget, raised to the estimator's ceiling in "auto".
	#subscribeMaxAge = new Signal<Time.Milli>(Time.Milli.zero);

	#signals = new Effect();

	constructor(props: DecoderProps) {
		this.in = {
			enabled: getter(props?.enabled ?? true),
			conceal: getter(props?.conceal ?? true),
			attached: getter(props?.attached ?? true),
			url: getter<URL | undefined>(props?.url),
			offload: getter(props?.offload ?? true),
		};

		this.source = props.source;
		this.sync = props.sync;
		this.#mode = this.#signals.computed((effect) => {
			if (effect.get(this.#fallback) !== undefined) return "main";
			if (!effect.get(this.in.offload)) return "main";
			if (effect.get(this.in.url) === undefined) return "main";
			// No worker to hand it to, or no Web Audio for it to feed: server rendering, a test runner.
			if (typeof Worker !== "function" || typeof AudioContext !== "function") return "main";
			return "worker";
		});

		// The "auto" playout target this track needs, per doc/concept/audio-jitter.md.
		const playout = this.#signals.computed((effect) => {
			const active = effect.get(this.#active);
			const measured = active ? effect.get(active.supply.out.measured) : undefined;
			if (active === undefined || measured === undefined) return undefined;
			const delay = effect.get(this.source.out.config)?.delay;
			return target({
				measured,
				advertised: effect.get(this.source.out.jitter),
				frame: effect.get(active.supply.out.frame),
				delay: delay !== undefined ? Time.Milli(delay) : undefined,
			});
		});
		this.#signals.cleanup(this.sync.register(playout));
		this.#idle = this.#signals.computed(
			(effect) => effect.get(this.source.out.config) === undefined && effect.get(this.#out.stalled),
		);

		this.#signals.run(this.#runSubscribeMaxAge.bind(this));
		this.#signals.run(this.#runSupply.bind(this));
		this.#signals.run(this.#runFallback.bind(this));
		this.#signals.run(this.#runThread.bind(this));
		this.#signals.run(this.#runShape.bind(this));
		this.#signals.run(this.#runRate.bind(this));
		this.#signals.run(this.#runContext.bind(this));
		this.#signals.run(this.#runNode.bind(this));
		this.#signals.run(this.#runRing.bind(this));
		this.#signals.run(this.#runOutputs.bind(this));
		this.#signals.run(this.#runEnabled.bind(this));
		this.#signals.run(this.#runClock.bind(this));
	}

	/**
	 * Run the supply where it belongs: in the page's worker when the player offloads, on the page otherwise.
	 *
	 * Each supply gets a graph of its own (see #runNode), so one taking over from another never writes
	 * into a node the other was writing.
	 */
	#runSupply(effect: Effect): void {
		const mode = effect.get(this.#mode);

		const graph = new Signal<PageGraph | undefined>(undefined);
		const props = {
			source: this.source,
			sync: this.sync,
			enabled: this.in.enabled,
			graph,
			target: this.sync.out.delay,
			maxAge: this.sync.out.maxAge,
			subscribeMaxAge: this.#subscribeMaxAge,
			instant: this.sync.out.instant,
			buffered: this.sync.out.buffered,
		};

		if (mode === "worker") {
			// A player off the page holds no share of the worker, so the page's last player to leave lets
			// it go.
			if (!effect.get(this.in.attached)) return;
			const supply = new Remote({ ...props, url: this.in.url });
			effect.cleanup(() => supply.close());
			effect.set(this.#active, { kind: "worker", supply, graph }, undefined);
			return;
		}

		const supply = new Supply({ ...props, polyfill: Util.Libav.polyfill });
		effect.cleanup(() => supply.close());
		effect.set(this.#active, { kind: "main", supply, graph }, undefined);
	}

	/**
	 * Take the audio back from the worker for good once it cannot play it.
	 *
	 * The switch is #runSupply's: the worker hears the player is gone, the page's own supply subscribes on
	 * the page's session, and it writes a fresh node on the same context, so no gesture is spent and nothing
	 * the worker still had in flight reaches it. The clock goes with the worker's ring, and `Sync` runs on at
	 * wall speed from where the playhead was until the page's ring has one.
	 *
	 * The worker's own trouble reaches every player on the page, which the pool warns about once. A
	 * player's own is warned about here.
	 */
	#runFallback(effect: Effect): void {
		const active = effect.get(this.#active);
		if (active?.kind !== "worker") return;
		const failure = effect.get(active.supply.out.failure);
		if (!failure) return;
		if (failure.scope === "player") console.warn(`[audio] falling back to the main thread: ${failure.reason}`);
		this.#fallback.set(failure.reason);
	}

	#runThread(effect: Effect): void {
		const reason = effect.get(this.#fallback);
		if (reason !== undefined) {
			this.#out.thread.set({ kind: "main", reason });
			return;
		}

		const active = effect.get(this.#active);
		if (active?.kind !== "worker") {
			this.#out.thread.set(active && { kind: "main" });
			return;
		}

		const ready = effect.get(active.supply.out.ready);
		const transport = effect.get(active.supply.out.transport);
		this.#out.thread.set(ready ? { kind: "worker", transport } : undefined);
	}

	// A group the relay expires is never observed, so a subscription cut to the target would cap the
	// estimate at the target it already holds. The container consumer keeps the shared budget as its
	// local skip, since it observes each frame before applying it. See doc/concept/audio-jitter.md.
	#runSubscribeMaxAge(effect: Effect): void {
		const maxAge = effect.get(this.sync.out.maxAge);
		const auto = effect.get(this.sync.in.delay) === "auto";
		this.#subscribeMaxAge.set(auto ? Time.Milli.max(maxAge, AUTO_MAX_AGE) : maxAge);
	}

	#runShape(effect: Effect): void {
		// An absent rendition keeps the last shape, so the graph outlives it.
		const config = effect.get(this.source.out.config);
		if (!config) return;

		// A rendition matching either the advertised or the decoded rate keeps the graph, and with it the
		// rate the supply learned from the decoder.
		const shape = this.#shape.peek();
		const rate = shape?.catalog === config.sampleRate || shape?.sampleRate === config.sampleRate;
		if (rate && shape?.channels === config.numberOfChannels) return;

		this.#shape.set({
			catalog: config.sampleRate,
			sampleRate: config.sampleRate,
			channels: config.numberOfChannels,
		});
	}

	// The decoder's own rate is the source of truth for the graph, and the supply reports it when it
	// disagrees with the one the graph was built at: rebuild at the real rate.
	#runRate(effect: Effect): void {
		const active = effect.get(this.#active);
		if (!active) return;
		const rate = effect.get(active.supply.out.rate);
		if (rate === undefined) return;
		this.#shape.update((shape) => shape && { ...shape, sampleRate: rate });
	}

	/**
	 * Build the context for the shape, and release it when the player leaves the page.
	 *
	 * A context's rate is fixed for its lifetime, so the rate the decoder turns out to emit is the one
	 * change worth a new context. A replacement supply (the worker giving the audio back) writes a node
	 * under the context that is already running, since replacing it would spend a gesture that may never
	 * come again.
	 *
	 * A player taken off the page releases its context and pays for a new one if it comes back: nothing
	 * can be heard out of it, and what it holds is a render thread and one of the handful of contexts a
	 * browser allows. Keyed on `attached` rather than on `enabled`, which a mute also clears, so a muted
	 * tile keeps the context it has.
	 */
	#runContext(effect: Effect): void {
		if (!effect.get(this.in.attached)) return;
		// Server rendering, or a test runner: nothing here can play audio.
		if (typeof AudioContext !== "function") return;

		// It takes a second or so to initialize the AudioContext/AudioWorklet, so do it even if disabled.
		// This is less efficient for video-only playback but makes muting/unmuting instant.
		const shape = effect.get(this.#shape);
		if (!shape) return;

		// Expose the rate the graph actually runs at.
		effect.set(this.#out.sampleRate, shape.sampleRate);

		const context = new AudioContext({
			latencyHint: "interactive", // We don't use real-time because of the buffer.
			sampleRate: shape.sampleRate,
		});
		effect.set(this.#out.context, context);
		effect.set(this.#built, { context, rate: shape.sampleRate, channels: shape.channels });

		effect.cleanup(() => context.close());
	}

	/**
	 * Build the render node the active supply writes through, for as long as it and the context last.
	 *
	 * A node of its own for every supply: a writer reaches a node through what it was handed at build,
	 * so a supply taking over from another gets one nothing else writes into.
	 */
	#runNode(effect: Effect): void {
		const built = effect.get(this.#built);
		if (!built) return;
		const { context, rate: sampleRate, channels: channelCount } = built;

		const active = effect.get(this.#active);
		if (!active) return;

		effect.spawn(async () => {
			// Register the AudioWorklet processor, racing the load against teardown. If teardown wins,
			// `loaded` is undefined and we bail before constructing the node: the module registration was
			// abandoned, so building against its name would throw. Gate on the race result, not
			// `context.state`, because `AudioContext.close()` only flips `.state` to "closed" synchronously
			// on Chrome (Firefox/Safari report "suspended").
			const loaded = await effect.race(
				RenderWorklet(hostedAssets()).then(async (url) => {
					await context.audioWorklet.addModule(url);
					return true;
				}),
			);
			if (!loaded) return;

			// Create the worklet node. outputChannelCount must be set explicitly
			// so the process() callback receives a matching channel layout.
			// Firefox defaults differently than Chrome otherwise.
			const worklet = new AudioWorkletNode(context, "render", {
				channelCount,
				channelCountMode: "explicit",
				outputChannelCount: [channelCount],
			});
			effect.cleanup(() => {
				// The context outlives this node, so the processor has to be told to end. See `Close`.
				const close: Close = { type: "close" };
				worklet.port.postMessage(close);
				worklet.disconnect();
			});

			// Shared memory wherever the page can have it, for the page's own writes: the worker's ring is
			// messages on any page (see `Player` in `worker/host.ts`), so only the page's is worth naming.
			const shared = supportsSharedArrayBuffer();
			if (active.kind === "main") reportTransport(shared);

			// The supply builds the ring against the node and writes it from here on.
			effect.set(active.graph, {
				target: worklet,
				context,
				rate: sampleRate,
				channels: channelCount,
				conceal: this.in.conceal.peek(),
				shared,
			});

			effect.set(this.#out.root, worklet);
		});
	}

	// Mirror ring state (timestamp/stalled) onto our public signals, for as long as the supply has a ring.
	#runRing(effect: Effect): void {
		const active = effect.get(this.#active);
		if (!active) return;
		const ring = effect.get(active.supply.out.ring);
		if (!ring) return;

		effect.run((inner) => {
			this.#out.timestamp.set(Time.Milli.fromMicro(inner.get(ring.timestamp)));
		});
		effect.run((inner) => {
			this.#out.stalled.set(inner.get(ring.stalled));
		});
		effect.run((inner) => {
			this.#out.underruns.set(inner.get(ring.underruns));
		});
		effect.run((inner) => {
			this.#out.debug.set(inner.get(ring.debug));
		});
	}

	// Mirror the supply's other outputs onto ours.
	#runOutputs(effect: Effect): void {
		const active = effect.get(this.#active);
		if (!active) return;
		const out = active.supply.out;

		effect.proxy(this.#out.buffered, out.buffered);

		// The counters carry across a supply taking over from another, so they never run backwards.
		let received = 0;
		effect.run((inner) => {
			const bytes = inner.get(out.stats)?.bytesReceived;
			if (bytes === undefined) return;
			this.#out.stats.update((stats) => ({ bytesReceived: (stats?.bytesReceived ?? 0) + bytes - received }));
			received = bytes;
		});
	}

	#runEnabled(effect: Effect): void {
		const context = effect.get(this.#out.context);

		// An idle graph stops the audio thread while it waits, so pages with many tiles pay nothing.
		// The unlock below resumes it once the rendition returns.
		if (context && effect.get(this.#idle)) {
			context.suspend().catch(() => {});
			return;
		}

		const enabled = effect.get(this.in.enabled);
		if (!enabled) return;
		if (effect.get(this.sync.out.instant)) {
			this.reset();
			return;
		}

		if (!context) return;

		// The context is built at page load (see #runContext), before any user gesture, so it
		// must be started from a real interaction.
		Util.Gesture.unlock(effect, context);

		// NOTE: You should disconnect/reconnect the worklet to save power when disabled.
	}

	/**
	 * Drive playback from the ring's playhead while audio is being played.
	 *
	 * The ring consumes media on a clock of its own (the AudioContext's), and it stretches, parks
	 * and skips, so pacing video against a wall clock lets the two drift apart every time it does.
	 * Publishing the playhead makes it the reference every other track is paced against instead.
	 *
	 * Gated on `enabled` rather than on the ring existing: the graph is built up front so unmuting
	 * is instant, and a muted ring drains to a playhead that stopped meaning anything. `Sync` keeps
	 * the last value it saw, so handing the clock back costs no jump.
	 */
	#runClock(effect: Effect): void {
		if (!effect.get(this.in.enabled)) return;

		// Gate on the supply's ring so this effect re-runs once it is created.
		const active = effect.get(this.#active);
		if (!active) return;
		const ring = effect.get(active.supply.out.ring);
		if (!ring) return;

		const track = this.sync.track("audio");
		effect.run((inner) => track.clock.set(inner.get(ring.clock)));
		effect.cleanup(() => track.clock.set(undefined));
	}

	// Flush the audio buffer and re-stall, re-anchoring playback to the next frame.
	// Use in buffered mode at an utterance boundary (see Sync.reset).
	reset(): void {
		this.#active.peek()?.supply.reset();
	}

	close() {
		this.#signals.close();
	}

	// Whether the WebCodecs audio decoder can play this config.
	static supported = supported;
}

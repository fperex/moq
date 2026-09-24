import type * as Catalog from "@moq/hang/catalog";
import type * as Container from "@moq/hang/container";
import * as Util from "@moq/hang/util";
import { Time } from "@moq/net";
import {
	type Computed,
	Derived,
	Effect,
	type Getter,
	getter,
	type Inputs,
	type Readonlys,
	readonlys,
	Signal,
} from "@moq/signals";
import { accumulate } from "../media";
import type { Delay, Sync } from "../sync";
import { audioMaxAge, type DecoderConfig, decoderConfig } from "./config";
import type * as Playout from "./playout";
// Compiled and inlined as a blob URL via vite-plugin-worklet.
import RenderWorklet from "./render-worklet.ts?worklet";
import type { Source } from "./source";
import { Supply } from "./supply";
import { supported } from "./supported";
import { unlockOnGesture } from "./unlock";
import { type PageGraph, Remote } from "./worker/remote";

export type DecoderInput = {
	// Whether to download the audio track. Defaults to true.
	enabled: Getter<boolean>;

	/**
	 * Whether the player is on the page at all. Defaults to true.
	 *
	 * A player that is not can never be heard, so it releases its audio context, the render thread
	 * behind it and the ring, and builds them again if it comes back. Separate from `enabled`, which
	 * a mute also clears: a muted tile keeps the context it has, so the unmute costs no gesture.
	 */
	attached: Getter<boolean>;

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
	 * The relay the broadcast is read from, which the page's audio worker dials for the audio. Without one
	 * the audio stays on the page.
	 */
	url: Getter<URL | undefined>;

	/**
	 * Whether the audio is fed from a dedicated worker rather than the page's main thread. Defaults to false.
	 *
	 * The worker subscribes, decodes and writes the ring on a session of its own to {@link url}, so a busy
	 * main thread cannot starve the ring. One worker serves every player on the page. Needs a {@link url}
	 * and a `Worker`; without either the audio stays on the page.
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

	// Whether playback stopped rather than started: the ring is stalled after it had been playing.
	interrupted: Signal<boolean>;

	// How many times the ring ran dry mid-playback, so the UI can show that the target is too low.
	underruns: Signal<number>;

	// Groups that lost content above the decoder: the age budget skipped them, or the transport
	// gave up on delivering them in time.
	skipped: Signal<number>;

	// Combined buffered ranges (network jitter + decode buffer)
	buffered: Signal<Container.BufferedRanges>;

	// How late audio frames arrive relative to the earliest one, measured for as long as the
	// rendition lasts. Wired into Sync by the parent, which sizes the "auto" delay from it.
	spread: Signal<Time.Milli | undefined>;

	/**
	 * Every audio ring counter at once: what it holds, what the playout engine did with it, what
	 * either end threw away, and the budget its supply is skipped against. Undefined until the graph
	 * is built and the first sample lands.
	 *
	 * @internal
	 */
	debug: Signal<Playout.Debug | undefined>;
};

/** Cumulative audio statistics since the decoder started. */
export interface Stats {
	/** Number of encoded bytes received. */
	bytesReceived: number;
}

// The supply feeding the ring, and the graph built for it.
interface Active {
	supply: Supply | Remote;
	graph: Signal<PageGraph | undefined>;
}

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
		interrupted: new Signal<boolean>(false),
		underruns: new Signal<number>(0),
		skipped: new Signal<number>(0),
		buffered: new Signal<Container.BufferedRanges>([]),
		spread: new Signal<Time.Milli | undefined>(undefined),
		debug: new Signal<Playout.Debug | undefined>(undefined),
	};
	readonly out = readonlys(this.#out);

	// The AudioContext the graph runs in, owned here rather than by an effect: it is built by the
	// gesture that starts it (see #buildContext) and outlives every other change to the graph short
	// of the player leaving the page (see #runContext).
	#context: { audio: AudioContext; effects: Effect } | undefined;

	// Everything that feeds the ring (the subscription, the estimator, the decoder and the writes) and the
	// graph it writes into: on the page, or in the page's worker. See #runSupply.
	readonly #active = new Signal<Active | undefined>(undefined);

	// Where the supply runs, once decided. See #runSupply.
	readonly #mode: Computed<"main" | "worker">;

	#signals = new Effect();

	// The decoder fields that require a new worklet and ring. Routing and metadata changes leave
	// them alone.
	readonly #config: Computed<DecoderConfig | undefined>;

	// The rate the graph runs at: what the decoder turns out to emit, else what the catalog claims.
	// Deduped, so a decoded rate confirming the catalog's does not count as a change.
	readonly #rate: Computed<number | undefined>;

	/**
	 * The age budget for audio: `Sync.out.maxAge` plus what the ring can absorb past it.
	 *
	 * See {@link audioMaxAge} for what it adds and why.
	 *
	 * Audio only, and deliberately not `Sync.out.maxAge` itself. That value is also the lookahead
	 * cap in `Sync.received`, which bounds how far ahead of the playhead an *early* frame may be
	 * held before playback skips forward. Widening it would let buffered playback drift a headroom
	 * further from the live edge to solve a problem that only exists for late arrivals. Video is
	 * untouched for the same reason: it drops a late frame at render rather than losing the group.
	 *
	 * It reads synchronously from the first peek, which is what `subscribeMedia` and
	 * `Container.Consumer` need at construction.
	 */
	// The ring's depth: `sync.out.delay` plus `sync.out.offset`. See the constructor.
	readonly #target: Derived<readonly [Getter<Time.Milli>, Getter<Time.Milli>], Time.Milli>;

	readonly #maxAge: Derived<
		readonly [Getter<Time.Milli>, Getter<Delay>, Getter<Catalog.AudioConfig | undefined>],
		Time.Milli
	>;

	constructor(props: DecoderProps) {
		this.in = {
			enabled: getter(props?.enabled ?? true),
			attached: getter(props?.attached ?? true),
			conceal: getter(props?.conceal ?? true),
			url: getter<URL | undefined>(props?.url),
			offload: getter(props?.offload ?? false),
		};

		this.source = props.source;
		this.sync = props.sync;
		this.#config = this.#signals.computed((effect) => {
			const config = effect.get(this.source.out.config);
			return config ? decoderConfig(config) : undefined;
		});
		this.#rate = this.#signals.computed((effect) => {
			const config = effect.get(this.#config);
			if (!config) return undefined;
			const active = effect.get(this.#active);
			const decoded = active ? effect.get(active.supply.out.rate) : undefined;
			return decoded ?? config.sampleRate;
		});
		this.#mode = this.#signals.computed((effect) => {
			if (!effect.get(this.in.offload)) return "main";
			if (effect.get(this.in.url) === undefined) return "main";
			// No worker to hand it to: server rendering, or a runtime without one.
			if (typeof Worker !== "function") return "main";
			return "worker";
		});

		// What the ring holds on top of the chunk: the estimator's answer plus however much later
		// the picture arrives than the sound for the same timestamp. `sync.out.delay` stays the
		// estimator's answer alone, which is what the player's jitter buffer row reports; this is
		// the quantity the listener actually waits, and the one that puts the picture back in sync.
		this.#target = new Derived([this.sync.out.delay, this.sync.out.offset] as const, (delay, offset) =>
			Time.Milli.add(delay, offset),
		);
		this.#maxAge = new Derived(
			[this.sync.out.maxAge, this.sync.in.delay, this.source.out.config] as const,
			(maxAge, delay, config) => audioMaxAge(maxAge, config, delay === "instant"),
		);

		// There is no context until a user gesture builds one (see #buildContext). Armed for the
		// decoder's lifetime rather than while audio is enabled: the click that unmutes a tile is the
		// activation, and listeners armed as a consequence of it are armed one microtask too late to
		// hear it. See unlockOnGesture. A player off the page builds nothing: the gesture belongs to
		// whatever the viewer actually clicked.
		unlockOnGesture(this.#signals, this.#out.context, () =>
			this.in.attached.peek() ? (this.#context?.audio ?? this.#buildContext(this.#rate.peek())) : undefined,
		);
		this.#signals.cleanup(() => this.#closeContext());

		this.#signals.run(this.#runSupply.bind(this));
		this.#signals.run(this.#runContext.bind(this));
		this.#signals.run(this.#runRing.bind(this));
		this.#signals.run(this.#runClock.bind(this));
		this.#signals.run(this.#runOutputs.bind(this));
	}

	/**
	 * Run the supply where it belongs: in the page's worker when the player offloads, on the page otherwise.
	 *
	 * Each supply gets a graph of its own (see #runWorklet), so one taking over from another never writes
	 * into a node the other was writing.
	 */
	#runSupply(effect: Effect): void {
		const mode = effect.get(this.#mode);
		if (mode === undefined) return;

		const graph = new Signal<PageGraph | undefined>(undefined);
		const props = {
			source: this.source,
			sync: this.sync,
			enabled: this.in.enabled,
			graph,
			target: this.#target,
			maxAge: this.#maxAge,
		};

		if (mode === "worker") {
			// A player off the page holds no share of the worker, so the page's last player to leave lets
			// it go.
			if (!effect.get(this.in.attached)) return;
			const supply = new Remote({ ...props, url: this.in.url });
			effect.cleanup(() => supply.close());
			effect.set(this.#active, { supply, graph }, undefined);
			return;
		}

		const supply = new Supply({ ...props, polyfill: Util.Libav.polyfill });
		effect.cleanup(() => supply.close());
		effect.set(this.#active, { supply, graph }, undefined);
	}

	// Mirror the active supply's outputs onto ours.
	#runOutputs(effect: Effect): void {
		const active = effect.get(this.#active);
		if (!active) return;
		const out = active.supply.out;

		// Unlike the counters, the estimate goes when the player does: Sync holds the buffer open for
		// any track still publishing one.
		effect.run((inner) => inner.set(this.#out.spread, inner.get(out.spread)));
		effect.proxy(this.#out.buffered, out.buffered);

		// The counters carry across a supply taking over from another, so they never run backwards.
		accumulate(effect, this.#out.skipped, out.skipped);
		let received = 0;
		effect.run((inner) => {
			const bytes = inner.get(out.stats)?.bytesReceived;
			if (bytes === undefined) return;
			this.#out.stats.update((stats) => ({ bytesReceived: (stats?.bytesReceived ?? 0) + bytes - received }));
			received = bytes;
		});
	}

	/**
	 * Build the context for a tile whose audio is on, replace it when the rate it must run at
	 * changes, and release it when the player leaves the page.
	 *
	 * A context's rate is fixed for its lifetime, so the rate the decoder turns out to emit (see
	 * `Supply.#emit`) is the one change worth a new context. Everything else that rebuilds the graph
	 * (a later catalog frame carrying the codec description, a channel count change) rebuilds the
	 * worklet and ring *under* the context that is already playing, since replacing it would spend a
	 * gesture that may never come again. The replacement here is built outside a handler, so it
	 * starts only while the page's activation is still live; unlockOnGesture stays armed and spends
	 * the next gesture on it otherwise.
	 *
	 * A player taken off the page releases its context and pays for a new one if it comes back:
	 * nothing can be heard out of it, and what it holds is a render thread and one of the handful of
	 * contexts a browser allows. Keyed on `attached` rather than on `enabled`, which a mute also
	 * clears, so a muted tile keeps the context it has.
	 */
	#runContext(effect: Effect): void {
		if (!effect.get(this.in.attached)) {
			this.#closeContext();
			return;
		}

		const rate = effect.get(this.#rate);
		const enabled = effect.get(this.in.enabled);

		const context = this.#context?.audio;
		if (!context) {
			// Audio is asked for, so build the graph and let unlockOnGesture try to start it: a
			// permissive autoplay policy runs it with no gesture at all (the audio-quality lane
			// launches Chromium that way and never clicks), a strict one leaves it suspended until the
			// next gesture, and a tile unmuted by a click the listeners never saw is still inside that
			// click's activation. A muted tile builds nothing, which is the load-time cost the viewer
			// sees: three muted tiles were three contexts nothing could start and three autoplay
			// warnings. Waits for the rate, unlike the gesture path, which cannot.
			if (enabled && rate !== undefined) this.#buildContext(rate);
			return;
		}

		if (rate !== undefined && context.sampleRate !== rate) this.#buildContext(rate);
	}

	/**
	 * Build the AudioContext the graph runs in, replacing the one it has.
	 *
	 * Called from the gesture handler, synchronously, because a context is the only thing here a
	 * user gesture starts: one built later can only be started while the page's activation lasts, a
	 * few seconds in WebKit, and past that it stays suspended and nothing is ever rendered while
	 * video keeps painting. Building one at load instead costs an autoplay warning per tile in
	 * Chromium and a render thread per muted tile, for a graph nobody has asked to hear yet.
	 *
	 * `rate` is what the catalog claims, or what the decoder turns out to emit once a frame has
	 * arrived (see `Supply.#emit`). It is undefined when the gesture lands before the catalog does,
	 * and the context then runs at the device default until a rate that differs replaces it.
	 */
	#buildContext(rate: number | undefined): AudioContext {
		this.#closeContext();

		const context = new AudioContext({
			latencyHint: "interactive", // We don't use real-time because of the buffer.
			// Absent rather than undefined, so the browser picks the device default.
			...(rate !== undefined && { sampleRate: rate }),
		});
		const effects = new Effect();
		this.#context = { audio: context, effects };

		// Expose the rate the graph actually runs at.
		this.#out.sampleRate.set(context.sampleRate);
		this.#out.context.set(context);
		effects.run((effect) => this.#runWorklet(effect, context));

		return context;
	}

	/** Tear down the context and everything built against it, which the graph rebuilds without. */
	#closeContext(): void {
		const context = this.#context;
		if (!context) return;

		this.#context = undefined;
		// Cancel module loads before close rejects them; signal propagation happens later.
		context.effects.close();
		this.#out.context.set(undefined);
		this.#out.sampleRate.set(undefined);

		// A context closed twice rejects, and there is nothing to do about a close that fails anyway.
		context.audio.close().catch(() => {});
	}

	#runWorklet(effect: Effect, context: AudioContext): void {
		// It takes a second or so to initialize the AudioWorklet, so do it even if disabled. This is
		// less efficient for video-only playback but makes muting/unmuting instant, since the first
		// gesture on the page builds a context for every tile whether or not it is the one clicked.

		//const enabled = effect.get(this.enabled);
		//if (!enabled) return;

		const config = effect.get(this.#config);
		if (!config) return;

		// A node of its own for every supply: a writer reaches a node through what it was handed at build,
		// so a supply taking over from another gets one nothing else writes into.
		const active = effect.get(this.#active);
		if (!active) return;

		const sampleRate = context.sampleRate;
		const channelCount = config.numberOfChannels;

		effect.spawn(async () => {
			// Register the AudioWorklet processor, racing the load against teardown. If teardown wins,
			// `loaded` is undefined and we bail before constructing the node: the module registration was
			// abandoned, so building against its name would throw. Gate on the race result, not
			// `context.state`, because `AudioContext.close()` only flips `.state` to "closed" synchronously
			// on Chrome (Firefox/Safari report "suspended").
			const loaded = await Promise.race([
				context.audioWorklet.addModule(RenderWorklet).then(() => true),
				effect.cancel,
			]);
			if (!loaded) return;

			// Create the worklet node. outputChannelCount must be set explicitly
			// so the process() callback receives a matching channel layout.
			// Firefox defaults differently than Chrome otherwise.
			const worklet = new AudioWorkletNode(context, "render", {
				channelCount,
				channelCountMode: "explicit",
				outputChannelCount: [channelCount],
			});
			effect.cleanup(() => worklet.disconnect());

			// The supply builds the ring against the node and writes it from here on.
			effect.set(active.graph, {
				target: worklet,
				context,
				rate: sampleRate,
				channels: channelCount,
				conceal: this.in.conceal.peek(),
			});

			effect.set(this.#out.root, worklet);
		});
	}

	// Mirror ring state onto our public signals, for as long as the supply has a ring.
	#runRing(effect: Effect): void {
		const active = effect.get(this.#active);
		if (!active) return;
		const ring = effect.get(active.supply.out.ring);
		if (!ring) return;

		// A flushed ring reports no playhead until the next insert re-anchors it.
		effect.run((inner) => {
			const timestamp = inner.get(ring.timestamp);
			this.#out.timestamp.set(timestamp === undefined ? undefined : Time.Milli.fromMicro(timestamp));
		});
		// A stall means one of two things and the ring reports one flag for both, so the
		// distinction is drawn here: a ring nobody has played from is filling, whatever it
		// holds, and only a ring that stops after it has played has interrupted anything.
		effect.run((inner) => {
			const stalled = inner.get(ring.stalled);
			this.#out.stalled.set(stalled);

			// The download being off disconnects the emitter, so nothing is draining the ring
			// and whatever plays next is a fresh fill rather than playback resuming.
			const enabled = inner.get(this.in.enabled);
			const fresh = inner.get(ring.debug)?.fresh ?? true;
			this.#out.interrupted.set(enabled && stalled && !fresh);
		});
		effect.run((inner) => {
			this.#out.underruns.set(inner.get(ring.underruns));
		});
		effect.run((inner) => {
			const debug = inner.get(ring.debug);
			this.#out.debug.set(debug && { ...debug, budget: inner.get(this.#maxAge) });
		});
	}

	/**
	 * Drive playback from the ring's playhead while audio is being played.
	 *
	 * The ring consumes media on a clock of its own (the AudioContext's), so pacing video against a
	 * wall clock lets the two drift apart every time the ring re-buffers or skips. Publishing the
	 * playhead makes it the reference every other track is paced against instead.
	 *
	 * Gated on `enabled` rather than on the ring existing: the graph is built up front so unmuting
	 * is instant, and a muted ring drains to a playhead that stopped meaning anything. `Sync` keeps
	 * the last value it saw, so handing the clock back costs no jump.
	 */
	#runClock(effect: Effect): void {
		if (!effect.get(this.in.enabled)) return;

		// Gate on the supply's ring so this effect re-runs once the ring is created.
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

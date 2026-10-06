import * as Catalog from "@moq/hang/catalog";
import * as Container from "@moq/hang/container";
import * as Util from "@moq/hang/util";
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
import { base64ToBytes } from "../base64";
import type { Sync } from "../sync";
import { reportTransport, supportsSharedArrayBuffer } from "./buffer";
import { AUTO_MAX_AGE, target } from "./latency";
import type { Snapshot } from "./playout";
// A blob: URL, or a hosted file when assets() is set; see vite-plugin-worklet.
import RenderWorklet from "./render-worklet.ts?worklet";
import type { Source } from "./source";
import { type Graph, Supply } from "./supply";

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
};

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
	};
	readonly out = readonlys(this.#out);

	// Everything that feeds the ring: the subscription, the estimator, the decoder and the writes. It
	// writes into the graph this builds, and reads the rest from `sync` and `source`.
	readonly #supply: Supply;
	readonly #graph = new Signal<Graph | undefined>(undefined);

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
		};

		this.source = props.source;
		this.sync = props.sync;
		this.#supply = new Supply({
			source: this.source,
			sync: this.sync,
			enabled: this.in.enabled,
			graph: this.#graph,
			target: this.sync.out.delay,
			maxAge: this.sync.out.maxAge,
			subscribeMaxAge: this.#subscribeMaxAge,
			instant: this.sync.out.instant,
			buffered: this.sync.out.buffered,
			polyfill: Util.Libav.polyfill,
		});
		this.#signals.cleanup(() => this.#supply.close());

		// The "auto" playout target this track needs, per doc/concept/audio-jitter.md.
		const playout = this.#signals.computed((effect) => {
			const measured = effect.get(this.#supply.out.measured);
			if (measured === undefined) return undefined;
			const delay = effect.get(this.source.out.config)?.delay;
			return target({
				measured,
				advertised: effect.get(this.source.out.jitter),
				frame: effect.get(this.#supply.out.frame),
				delay: delay !== undefined ? Time.Milli(delay) : undefined,
			});
		});
		this.#signals.cleanup(this.sync.register(playout));
		this.#idle = this.#signals.computed(
			(effect) => effect.get(this.source.out.config) === undefined && effect.get(this.#out.stalled),
		);

		this.#signals.run(this.#runSubscribeMaxAge.bind(this));
		this.#signals.run(this.#runShape.bind(this));
		this.#signals.run(this.#runRate.bind(this));
		this.#signals.run(this.#runWorklet.bind(this));
		this.#signals.run(this.#runRing.bind(this));
		this.#signals.run(this.#runOutputs.bind(this));
		this.#signals.run(this.#runEnabled.bind(this));
		this.#signals.run(this.#runClock.bind(this));
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
		const rate = effect.get(this.#supply.out.rate);
		if (rate === undefined) return;
		this.#shape.update((shape) => shape && { ...shape, sampleRate: rate });
	}

	#runWorklet(effect: Effect): void {
		// It takes a second or so to initialize the AudioContext/AudioWorklet, so do it even if disabled.
		// This is less efficient for video-only playback but makes muting/unmuting instant.
		const shape = effect.get(this.#shape);
		if (!shape) return;

		const { sampleRate, channels: channelCount } = shape;

		// Expose the rate the graph actually runs at.
		effect.set(this.#out.sampleRate, sampleRate);

		const context = new AudioContext({
			latencyHint: "interactive", // We don't use real-time because of the buffer.
			sampleRate,
		});
		effect.set(this.#out.context, context);

		effect.cleanup(() => context.close());

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
			effect.cleanup(() => worklet.disconnect());

			// Shared memory wherever the page can have it, for the page's own writes.
			const shared = supportsSharedArrayBuffer();
			reportTransport(shared);

			// The supply builds the ring against the node and writes it from here on.
			effect.set(this.#graph, {
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
		const ring = effect.get(this.#supply.out.ring);
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
		effect.proxy(this.#out.buffered, this.#supply.out.buffered);
		effect.proxy(this.#out.stats, this.#supply.out.stats);
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

		// The context is built at page load (see #runWorklet), before any user gesture, so it
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

		// Gate on the ring so this effect re-runs once it is created.
		const ring = effect.get(this.#supply.out.ring);
		if (!ring) return;

		const track = this.sync.track("audio");
		effect.run((inner) => track.clock.set(inner.get(ring.clock)));
		effect.cleanup(() => track.clock.set(undefined));
	}

	// Flush the audio buffer and re-stall, re-anchoring playback to the next frame.
	// Use in buffered mode at an utterance boundary (see Sync.reset).
	reset(): void {
		this.#supply.reset();
	}

	close() {
		this.#signals.close();
	}

	// Whether the WebCodecs audio decoder can play this config.
	static supported = supported;
}

async function supported(config: Catalog.AudioConfig): Promise<boolean> {
	if (!Catalog.containerSupported(config.container)) {
		// `kind` is the literal "unknown" tag; the container the publisher actually named is in `raw`.
		const kind = config.container.kind === "unknown" ? config.container.raw.kind : config.container.kind;
		console.warn(`audio: ignoring rendition with unknown container: ${kind}`);
		return false;
	}

	// Opus only runs at its native rates, so a catalog advertising anything else is wrong and Safari
	// refuses to decode it. Warn rather than reject: Chrome and Firefox ignore the configured rate and
	// play these streams fine, so rejecting would silence them for a publisher they handle today.
	if (config.codec === "opus" && !Util.Opus.supportsRate(config.sampleRate)) {
		console.warn(`audio: opus advertised at ${config.sampleRate}Hz, which some browsers cannot decode`);
	}

	// Opus in CMAF uses raw packets; dOps is not a valid OGG Identification Header.
	let description: Uint8Array | undefined;
	if (config.codec !== "opus") {
		if (config.description) {
			description = Util.Hex.toBytes(config.description);
		} else if (config.container.kind === "cmaf") {
			try {
				description = Container.Cmaf.decodeInitSegment(base64ToBytes(config.container.init)).description;
			} catch (err) {
				// A malformed init segment means we can't extract the codec
				// description, so we can't probe support reliably. Reject the
				// track rather than letting isConfigSupported pass on a
				// description-less config and then having decode() fail later.
				console.warn(`audio: malformed CMAF init segment for codec ${config.codec}`, err);
				return false;
			}
		}
	}
	const res = await AudioDecoder.isConfigSupported({
		...config,
		description,
	});
	return res.supported ?? false;
}

import * as Catalog from "@moq/hang/catalog";
import * as Container from "@moq/hang/container";
import * as Util from "@moq/hang/util";
import type * as Moq from "@moq/net";
import { Time } from "@moq/net";
import { type Computed, Effect, type Getter, type Readonlys, readonlys, Signal } from "@moq/signals";
import { base64ToBytes } from "../base64";
import { accumulate, Estimator, nextMedia, subscribeMedia } from "../media";
import type { Sync } from "../sync";
import { Anchor } from "./anchor";
import { type AudioBuffer, type AudioBufferProps, createAudioBuffer, type RingTarget } from "./buffer";
import { type DecoderConfig, type PlaybackIdentity, playbackIdentity } from "./config";
import type { Stats } from "./decoder";
import { Handover } from "./handover";
import { LOWER_INTERVAL, nextLatency, ringSamples } from "./latency";
import * as Playout from "./playout";
import type { Source } from "./source";
import { type DecodedSpan, Terminal } from "./terminal";
import { Warmup } from "./warmup";

// How long a viewer's deeper delay must stand before the ring parks to refill into it. A slider
// drag passes through every value on its way, and one taken straight back again costs nothing.
const LATENCY_REANCHOR_DEBOUNCE_MS = 150;

const LEGACY_WARMUP_CALLBACKS = 3;

/** Where the ring's writes go, and what the graph reading them runs at. */
export interface Graph {
	/** The render worklet node, or a port the worklet takes ring writes from. */
	target: RingTarget;
	/** Maps render time to the output device's clock. */
	context: AudioBufferProps["context"];
	/** The rate the graph runs at, which is the rate the ring is written at. */
	rate: number;
	/** The channel count the worklet node was built with. */
	channels: number;
	/** Whether the reader conceals a gap with synthesized audio. See `DecoderInput.conceal`. */
	conceal: boolean;
}

/** What the ring reports about itself, and nothing that writes to it. */
export type RingState = Pick<AudioBuffer, "timestamp" | "clock" | "stalled" | "underruns" | "debug">;

/** The part of {@link Sync} a supply reads and reports to. */
export type SupplySync = Pick<Sync, "received" | "reset"> & {
	readonly in: Pick<Sync["in"], "delay" | "buffer">;
	readonly out: Pick<Sync["out"], "buffered">;
};

/** The wired dependencies of a {@link Supply}. */
export type SupplyInput = {
	/** Whether to download the audio track. */
	enabled: Getter<boolean>;

	/** Where the ring's writes go, or undefined while there is no graph to play them. */
	graph: Getter<Graph | undefined>;

	/** The ring's depth: `sync.out.delay` plus `sync.out.offset`. */
	target: Getter<Time.Milli>;

	/** The age budget the subscription and the container consumer skip against. See `audioMaxAge`. */
	maxAge: Getter<Time.Milli>;
};

/** Constructor properties for {@link Supply}. */
export type SupplyProps = SupplyInput & {
	/** Rendition selector supplying encoded audio. */
	source: Source;
	/** Shared playback clock. */
	sync: SupplySync;
};

type SupplyOutput = {
	// The rate the decoder actually outputs, learned from the first decoded frame. This is the source
	// of truth for the graph: a decoder can output a different rate than it was configured with (e.g.
	// Opus decodes to 48kHz on Chrome/Firefox but to the configured rate on Safari). Until a frame
	// arrives the graph is built at the catalog rate; if the real rate differs it is rebuilt.
	rate: Signal<number | undefined>;

	// How late audio frames arrive relative to the earliest one, measured for as long as the
	// rendition lasts. See #runSpread.
	spread: Signal<Time.Milli | undefined>;

	// Combined buffered ranges (network jitter + decode buffer)
	buffered: Signal<Container.BufferedRanges>;

	// Groups that lost content above the decoder: the age budget skipped them, or the transport
	// gave up on delivering them in time.
	skipped: Signal<number>;

	stats: Signal<Stats | undefined>;

	// The ring being written, for as long as there is a graph to write it into. See #runRing.
	ring: Signal<RingState | undefined>;
};

/**
 * Feeds the audio ring: the subscription, the container consumer, the rendition's arrival estimate,
 * the WebCodecs decoder, and the ring writes.
 *
 * The graph the ring plays through belongs to whoever built it. This reaches it only through the
 * {@link Graph} it is handed: somewhere to write the ring, and the output clock to stamp its playhead.
 */
export class Supply {
	readonly in: Readonlys<SupplyInput>;
	readonly source: Source;
	readonly sync: SupplySync;

	readonly #out: SupplyOutput = {
		rate: new Signal<number | undefined>(undefined),
		spread: new Signal<Time.Milli | undefined>(undefined),
		buffered: new Signal<Container.BufferedRanges>([]),
		skipped: new Signal<number>(0),
		stats: new Signal<Stats | undefined>(undefined),
		ring: new Signal<RingState | undefined>(undefined),
	};
	readonly out = readonlys(this.#out);

	// Decode buffer: audio sent to worklet but not yet played
	#decodeBuffered = new Signal<Container.BufferedRanges>([]);

	// Audio ring bridging the decode loop and the worklet (shared memory or postMessage transport).
	#ring: AudioBuffer | undefined;

	// Ordered discontinuity and endpoint state from the container consumer.
	#terminal = new Terminal();

	// The depth the ring was last told to hold, and when, so a fall walks down one bucket at a
	// time. See #runLatency.
	#latency?: Time.Milli;
	#latencyAt?: Time.Milli;

	// Bumped by the walk's own timer, so the effect reruns and sheds the next bucket.
	readonly #latencyStep = new Signal<number>(0);

	// Which subscription the ring's buffered samples came from. See #runDecoder.
	#handover = new Handover();

	// The broadcast the ring is currently filled from, so a different one is recognised as a new
	// publisher rather than a continuation. See #runDecoder.
	#broadcast?: Moq.Broadcast.Consumer;

	// Whether the ring is playing out a declared endpoint, so the playhead event that closes the
	// marker group is that endpoint's own and must not throw the tail away. See #onNext.
	#ended = false;

	#signals = new Effect();

	// The catalog fields that require a replacement subscription or decoder.
	readonly #identity: Computed<PlaybackIdentity | undefined>;

	// What makes "as long as the rendition lasts" outlive the effect below, which ends the moment
	// the rendition leaves the catalog. See `Estimator`.
	#estimator = new Estimator();

	constructor(props: SupplyProps) {
		this.in = {
			enabled: props.enabled,
			graph: props.graph,
			target: props.target,
			maxAge: props.maxAge,
		};

		this.source = props.source;
		this.sync = props.sync;
		this.#identity = this.#signals.computed((effect) => {
			const config = effect.get(this.source.out.config);
			return config ? playbackIdentity(config) : undefined;
		});

		this.#signals.run(this.#runRing.bind(this));
		this.#signals.run(this.#runFlush.bind(this));
		this.#signals.run(this.#runInstant.bind(this));
		this.#signals.run(this.#runLatency.bind(this));
		this.#signals.run(this.#runSpread.bind(this));
	}

	// Build the ring against the graph, for as long as there is one.
	#runRing(effect: Effect): void {
		const graph = effect.get(this.in.graph);
		if (!graph) return;

		// Initial ring depth in samples.
		const delay = this.in.target.peek();
		const latencySamples = ringSamples(graph.rate, delay);
		const buffered = this.sync.out.buffered.peek();

		// Let the factory pick the best transport (SharedArrayBuffer or postMessage).
		const ring = createAudioBuffer(graph.target, {
			context: graph.context,
			channels: graph.channels,
			rate: graph.rate,
			latency: latencySamples,
			buffered,
			conceal: graph.conceal,
		});
		this.#ring = ring;
		effect.cleanup(() => {
			ring.close();
			this.#ring = undefined;
		});

		// A flushed ring reports no playhead until the next insert re-anchors it, and there is nothing
		// to trim against in the meantime: the ranges it held went with the flush.
		effect.run((inner) => {
			const timestamp = inner.get(ring.timestamp);
			if (timestamp !== undefined) this.#trimDecodeBuffered(Time.Milli.fromMicro(timestamp));
		});

		effect.set(this.#out.ring, ring);
	}

	/**
	 * Flush the ring when the download stops.
	 *
	 * Nothing drains it while audio is off, since the emitter disconnects the graph, so what it holds
	 * is media that will be stale by the time the download comes back. Playing it out would step the
	 * playhead back to where the audio stopped and take every track paced against it along, so drop
	 * it and let the restarted subscription's first frame anchor the ring where playback actually is.
	 */
	#runFlush(effect: Effect): void {
		if (!effect.get(this.in.enabled)) return;
		effect.cleanup(() => this.#ring?.reset());
	}

	/**
	 * Drop what the ring holds when the delay turns instant.
	 *
	 * "instant" paces nothing, so the decoder refuses it (see `#runDecoder`) and the ring stops
	 * being filled. Playing out what is left would run audio against video that just jumped to the
	 * live edge. Its own effect rather than a branch of `#runFlush`, whose cleanup must not fire on
	 * every delay change.
	 */
	#runInstant(effect: Effect): void {
		if (!effect.get(this.in.enabled)) return;
		if (effect.get(this.sync.in.delay) !== "instant") return;
		this.reset();
	}

	// Hold the ring at the depth the target asks for.
	//
	// A rise is reached by stretching, however big it is: `setLatency` moves the bar and the reader
	// expands one pitch period per cooldown until the ring holds it, about 150ms of extra cushion a
	// second. That is how the native engine reaches every deeper hold (`retarget` in
	// `rs/moq-audio/src/playout/engine.rs` only moves the target), and sync survives the walk: audio
	// is the clock and video is painted when the playhead reaches its timestamp, so sound playing
	// slightly slow takes the picture with it and the pair gains the cushion together. Parking spends
	// the whole deficit as silence instead, which is what a rising shared target cost the listener
	// through tune-in and on every return to a tab.
	//
	// A delay the app set as a number is the exception: that is a jump a viewer asked for, and
	// walking 100ms up to 2s would bend thirteen seconds of speech to spare them a cut they expect.
	// Past the reader's own stretch bound it parks once, debounced, since a drag passes through every
	// value on the way to the one meant.
	//
	// A fall is `nextLatency`'s. Either way the step is measured from the depth the ring was actually
	// last set to, so a run of small steps is judged as the steps it was rather than as their sum.
	#runLatency(effect: Effect): void {
		// Gate on the ring signal so this effect re-runs once the ring is created.
		if (!effect.get(this.#out.ring)) return;

		const ring = this.#ring;
		if (!ring) return;

		const target = effect.get(this.in.target);
		// Whether the viewer named this delay, which is the only rise still worth a cut. Peeked: the
		// mode decides nothing on its own, and a rerun on it would tear down a park still waiting out
		// the debounce the same change scheduled.
		const fixed = typeof this.sync.in.delay.peek() === "number";
		// The walk's own tick, so the timer below reruns this effect rather than reaching into the ring.
		effect.get(this.#latencyStep);

		const now = Time.Milli.now();
		const current = this.#latency;
		// The first depth the ring is given is whatever is asked for: there is nothing to shed yet.
		const held = current === undefined ? LOWER_INTERVAL : Time.Milli.sub(now, this.#latencyAt ?? now);
		const next = current === undefined ? target : nextLatency(current, target, held);

		if (next !== current) {
			this.#latency = next;
			this.#latencyAt = now;
			ring.setLatency(ringSamples(ring.rate, next));

			// The first depth is the fill's own, which builds the cushion without parking anything.
			if (fixed && current !== undefined && next - current > Playout.STRETCH_BOUND) {
				effect.timer(() => ring.stall(), LATENCY_REANCHOR_DEBOUNCE_MS);
			}
		}

		// Still above what is asked for: come back for the next bucket. The timer is the effect's,
		// so a target that moves again in the meantime tears it down and re-decides from there.
		if (next > target) {
			const wait = Time.Milli(Math.max(LOWER_INTERVAL - held, 0));
			effect.timer(() => this.#latencyStep.update((step) => step + 1), next === current ? wait : LOWER_INTERVAL);
		}
	}

	/**
	 * Measure how late frames arrive, for as long as the rendition lasts.
	 *
	 * One estimator per rendition rather than per subscription. Muting stops the download and the
	 * container consumer goes with it, but what the path was measured at did not change while
	 * nobody was reading it: a replacement consumer continues this measurement instead of starting
	 * over at the publisher's declaration, which is a prior the estimator has already improved on.
	 * Starting over costs the viewer the difference as a cold fill on every unmute, which is the
	 * declared span plus a chunk of parked playhead. NetEq keeps its delay manager across a pause
	 * for the same reason (`modules/audio_coding/neteq/delay_manager.cc`).
	 *
	 * The declaration seeds it again when the rendition itself changes, since that is a different
	 * path with a different publisher's claim about it. A rendition that leaves the catalog and
	 * comes back unchanged is the same one.
	 */
	#runSpread(effect: Effect): void {
		const identity = effect.get(this.#identity);
		if (!identity) return;

		const spread = this.#estimator.spread(identity, effect.get(this.source.out.jitter));

		// Published for as long as the estimator lives, not for as long as a subscription does. A
		// mute would otherwise drop what Sync knows about this track and hand it back a moment
		// later, which reads as the delay collapsing and then deepening: Sync re-derives its
		// reference, and the decoder parks the playhead a second time to rebuild a cushion it
		// never actually lost. Cleared when the rendition goes, so a departed track stops holding
		// the buffer open.
		effect.run((inner) => this.#out.spread.set(inner.get(spread.value)));
		effect.cleanup(() => this.#out.spread.set(undefined));

		// Nested, so the subscription can come and go (mute, reconnect) under one estimator.
		effect.run((inner) => this.#runDecoder(inner, identity, spread));
	}

	#runDecoder(effect: Effect, identity: PlaybackIdentity, spread: Container.Jitter): void {
		const enabled = effect.get(this.in.enabled);
		if (!enabled) return;
		if (effect.get(this.sync.in.delay) === "instant") return;

		const broadcast = effect.get(this.source.in.broadcast);
		if (!broadcast) return;

		const track = effect.get(this.source.out.track);
		if (!track) return;

		const config = identity.decoder;

		// Honor a per-rendition `broadcast` override: subscribe on the resolved source
		// broadcast instead of the catalog's own broadcast.
		const active = broadcast.relativeBroadcast(effect, identity.broadcast);
		if (!active) return;

		// A different broadcast consumer is a different publisher: an element that followed a
		// republish (`reload`) rather than being rebuilt around it. Its timeline starts wherever
		// its encoder starts, which is near zero, so everything anchored to the old publisher has
		// to go: the ring would discard every sample below its anchor and the clock would hold a
		// reference no frame can ever reach, and nothing else raises a discontinuity to break it.
		// A rendition swap reopens a subscription on the timeline already playing and keeps both.
		if (this.#broadcast !== undefined && this.#broadcast !== active) {
			this.#ring?.reset();
			this.sync.reset();
		}
		this.#broadcast = active;

		// The ring outlives this effect (it's keyed on the sample rate and channel count), so a
		// replacement subscription (a rendition swap, a republished broadcast, a reconnect) inherits
		// whatever its predecessor decoded. Samples are timestamp indexed, so the replacement
		// overwrites the slots it lands on, but a publisher writing ahead of real-time leaves seconds
		// of tail beyond them. Drop that once the replacement's first frame says where it starts.
		this.#handover.opened();
		// A tune-in, not a resume: whatever the previous subscription declared is not this one's to
		// play out, so its first playhead event flushes the ring like any other.
		this.#ended = false;

		const sub = subscribeMedia(effect, {
			broadcast: active,
			track,
			priority: Catalog.PRIORITY.audio,
			maxAge: this.in.maxAge,
			// Buffered playback is media written ahead of the playhead, so what the track already
			// holds is the point rather than a backlog to skip. Read at open, which is the only
			// moment it decides anything; a later change re-derives the age budget instead.
			start: this.sync.in.buffer.peek() > 0 ? "oldest" : "latest",
		});
		if (!sub) return;

		if (config.container.kind === "cmaf") {
			this.#runCmafDecoder(effect, sub, config, spread);
		} else {
			this.#runLegacyDecoder(effect, sub, config, spread);
		}
	}

	#runLegacyDecoder(
		effect: Effect,
		sub: Moq.Track.Subscriber,
		config: DecoderConfig,
		spread: Container.Jitter,
	): void {
		const preSkip =
			config.codec === "opus" && config.description ? Util.Opus.preSkip(Util.Hex.toBytes(config.description)) : 0;
		this.#terminal.clear(preSkip);
		const format =
			config.container.kind === "loc" ? new Container.Loc.Format("audio") : new Container.Legacy.Format(config);
		// Create consumer with slightly less latency than the render worklet to avoid underflowing.
		// TODO include JITTER_UNDERHEAD
		const consumer = new Container.Consumer(sub, {
			format,
			maxAge: this.in.maxAge,
			// The estimator for this rendition, which outlives any one subscription. See #runSpread.
			jitter: spread,
		});
		effect.cleanup(() => consumer.close());

		// Combine network jitter buffer with decode buffer
		effect.run((inner) => {
			const network = inner.get(consumer.buffered);
			const decode = inner.get(this.#decodeBuffered);
			this.#out.buffered.update(() => Container.mergeBufferedRanges(network, decode));
		});

		accumulate(effect, this.#out.skipped, consumer.skipped);

		effect.spawn(async () => {
			const loaded = await Util.Libav.polyfill();
			if (!loaded) return; // cancelled

			const warmup = new Warmup(LEGACY_WARMUP_CALLBACKS);
			const anchor = new Anchor();
			let primed = false;

			const decoder = new AudioDecoder({
				output: (data) => {
					primed = true;
					const decoded = this.#terminal.span(data);
					if (warmup.drop()) {
						// Drop initial callbacks to prime the decoder.
						data.close();
						return;
					}
					this.#emit(data, decoded);
				},
				error: (error) => console.error("audio decoder error", error),
			});
			effect.cleanup(() => {
				if (decoder.state !== "closed") decoder.close();
			});

			// Opus in CMAF uses raw packets; dOps is not a valid OGG Identification Header.
			const description =
				config.codec === "opus"
					? undefined
					: config.description
						? Util.Hex.toBytes(config.description)
						: undefined;
			const decoderConfig: AudioDecoderConfig = {
				codec: config.codec,
				sampleRate: config.sampleRate,
				numberOfChannels: config.numberOfChannels,
				description,
			};
			decoder.configure(decoderConfig);

			for (;;) {
				const next = await nextMedia(consumer);
				if (!next) break;
				if (this.#onNext(next)) {
					decoder.reset();
					decoder.configure(decoderConfig);
					anchor.restarted();
				}
				// The endpoint arrives before the playhead event that closes its marker group, so
				// the flush runs with the tail still queued. See #onNext.
				if (next.end !== undefined) {
					await this.#declareEnd(decoder, anchor);
					continue;
				}

				const { frame } = next;
				if (!frame) continue;

				// Mark that we received this frame right now.
				const timestamp = Time.Milli.fromMicro(frame.timestamp as Time.Micro);
				this.sync.received(timestamp, "audio");

				// A hole in the source has to reach the decoder as one. See #reanchor.
				if (!this.#terminal.continues(frame.timestamp as Time.Micro)) {
					await this.#reanchor(decoder, anchor, decoderConfig);
				}

				this.#out.stats.update((stats) => ({
					bytesReceived: (stats?.bytesReceived ?? 0) + frame.payload.byteLength,
				}));

				// Backpressure: in buffered mode this holds the encoded frame until the playhead nears
				// it, keeping the lookahead above the floor as Opus instead of decoded PCM. No-op live.
				await this.#ring?.wait(frame.timestamp as Time.Micro);

				const chunk = new EncodedAudioChunk({
					type: anchor.type(frame.keyframe),
					data: frame.payload,
					timestamp: frame.timestamp,
				});

				// A fatal decode error closes the decoder, so decoding again throws InvalidStateError out
				// of this loop. Stop instead: the error callback already reported the real failure.
				if (decoder.state === "closed") break;
				decoder.decode(chunk);
				// Learn the packet duration before another input can hide a tune-in gap.
				// Native decoders accumulate output timestamps across unreported gaps.
				if (!primed) {
					const flushed = await Promise.race([decoder.flush().then(() => true), effect.cancel]);
					if (!flushed) break;
					anchor.restarted();
				}
			}
		});
	}

	#runCmafDecoder(effect: Effect, sub: Moq.Track.Subscriber, config: DecoderConfig, spread: Container.Jitter): void {
		if (config.container.kind !== "cmaf") return; // just to help typescript

		const initSegment = base64ToBytes(config.container.init);
		const init = Container.Cmaf.decodeInitSegment(initSegment);
		const opusDescription = config.description ? Util.Hex.toBytes(config.description) : init.description;
		const preSkip = config.codec === "opus" && opusDescription ? Util.Opus.preSkip(opusDescription) : 0;
		this.#terminal.clear(preSkip);
		// Opus in CMAF uses raw packets (not OGG-wrapped), so description must be omitted.
		// The dOps box from the init segment is not a valid OGG Identification Header.
		const description =
			config.codec === "opus"
				? undefined
				: config.description
					? Util.Hex.toBytes(config.description)
					: init.description;

		const consumer = new Container.Consumer(sub, {
			format: new Container.Cmaf.Format(init),
			maxAge: this.in.maxAge,
			// The estimator for this rendition, which outlives any one subscription. See #runSpread.
			jitter: spread,
		});
		effect.cleanup(() => consumer.close());

		// Combine network jitter buffer with decode buffer
		effect.run((inner) => {
			const network = inner.get(consumer.buffered);
			const decode = inner.get(this.#decodeBuffered);
			this.#out.buffered.update(() => Container.mergeBufferedRanges(network, decode));
		});

		accumulate(effect, this.#out.skipped, consumer.skipped);

		effect.spawn(async () => {
			const loaded = await Util.Libav.polyfill();
			if (!loaded) return; // cancelled

			let primed = false;
			const decoder = new AudioDecoder({
				output: (data) => {
					primed = true;
					this.#emit(data);
				},
				error: (error) => console.error("audio decoder error", error),
			});
			effect.cleanup(() => {
				if (decoder.state !== "closed") decoder.close();
			});

			// Configure decoder with description from catalog
			const decoderConfig: AudioDecoderConfig = {
				codec: config.codec,
				sampleRate: config.sampleRate,
				numberOfChannels: config.numberOfChannels,
				description,
			};
			decoder.configure(decoderConfig);
			const anchor = new Anchor();

			for (;;) {
				const next = await nextMedia(consumer);
				if (!next) break;

				// Reset and re-anchor before decoding the first frame of a new codec epoch.
				if (this.#onNext(next)) {
					decoder.reset();
					decoder.configure(decoderConfig);
					anchor.restarted();
				}

				// The endpoint arrives before the playhead event that closes its marker group, so
				// the flush runs with the tail still queued. See #onNext.
				if (next.end !== undefined) {
					await this.#declareEnd(decoder, anchor);
					continue;
				}

				const { frame } = next;
				if (!frame) continue;

				const timestamp = Time.Milli.fromMicro(frame.timestamp);
				this.sync.received(timestamp, "audio");

				// A hole in the source has to reach the decoder as one. See #reanchor.
				if (!this.#terminal.continues(frame.timestamp)) {
					await this.#reanchor(decoder, anchor, decoderConfig);
				}

				this.#out.stats.update((stats) => ({
					bytesReceived: (stats?.bytesReceived ?? 0) + frame.payload.byteLength,
				}));

				// Backpressure: in buffered mode this holds the encoded frame until the playhead nears
				// it, keeping the lookahead above the floor as Opus instead of decoded PCM. No-op live.
				await this.#ring?.wait(frame.timestamp);

				if (decoder.state === "closed") break;
				decoder.decode(
					new EncodedAudioChunk({
						type: anchor.type(frame.keyframe),
						data: frame.payload,
						timestamp: frame.timestamp,
					}),
				);
				// Establish the decoded packet duration before checking the next input gap.
				if (!primed) {
					const flushed = await Promise.race([decoder.flush().then(() => true), effect.cancel]);
					if (!flushed) break;
					anchor.restarted();
				}
			}
		});
	}

	/**
	 * Put the decoder back on the source timeline after a hole in it.
	 *
	 * A decoder timestamps its output by accumulating decoded frame durations from the chunk that
	 * opened its run, not by copying each chunk's own timestamp, so a hole it is not told about is
	 * swallowed: the subscription that restarts at the live edge after a mute, or a group the age
	 * budget skipped, and every sample after it lands in the ring that far in the past. The ring then
	 * plays a contiguous stream whose playhead sits behind the live edge for good, and since the
	 * playhead is the clock, every other track is paced behind it too. Restarting the decoder is what
	 * re-anchors it: the next chunk's own timestamp opens the new run.
	 *
	 * Draining first keeps the frames still in flight, which belong to the run that is ending.
	 */
	async #reanchor(decoder: AudioDecoder, anchor: Anchor, config: AudioDecoderConfig): Promise<void> {
		// Teardown rejects a flush in progress; the decode loop checks `state` before its next decode.
		await decoder.flush().catch(() => {});
		// The flush alone already ends the run the decoder will accept a chunk into, so the next chunk
		// has to open a new one whether or not the reset below runs.
		anchor.restarted();
		if (decoder.state !== "configured") return;

		this.#terminal.reanchor();
		decoder.reset();
		decoder.configure(config);
	}

	#emit(sample: AudioData, decoded: DecodedSpan = this.#terminal.span(sample)) {
		const { timestamp, frameOffset, frames } = decoded;
		const timestampMilli = Time.Milli.fromMicro(timestamp);
		if (frames === 0) {
			sample.close();
			return;
		}

		const ring = this.#ring;
		if (!ring) {
			// There is nowhere to play this: either we are closing, or there is no graph under it yet
			// (on the page, no gesture has built the context: see `Decoder.#buildContext`). Downloading
			// and decoding continues either way, so the arrival estimate is already measured when the
			// graph lands rather than starting cold from the publisher's declaration.
			sample.close();
			return;
		}

		// sample.sampleRate is the source of truth, and it can differ from the rate we pre-built the
		// graph against (Opus decodes to 48kHz on Chrome/Firefox but to the configured rate on Safari).
		// If they disagree, report the real rate so the graph is rebuilt at it, and drop this frame; the
		// ring being torn down can't accept it, and the next frame lands in the correctly-rated ring.
		if (sample.sampleRate !== ring.rate) {
			this.#out.rate.set(sample.sampleRate);
			sample.close();
			return;
		}

		// Calculate end time from sample duration
		const durationMicro = ((frames / sample.sampleRate) * 1_000_000) as Time.Micro;
		const durationMilli = Time.Milli.fromMicro(durationMicro);
		const end = Time.Milli.add(timestampMilli, durationMilli);

		// A new subscription has taken over the timeline: drop the previous one's write-ahead tail
		// rather than letting it play out after this frame. See #runDecoder.
		if (this.#handover.takeover()) {
			ring.truncate(timestamp);
			this.#truncateDecodeBuffered(timestampMilli);
		}

		// Add to decode buffer
		this.#addDecodeBuffered(timestampMilli, end);

		// Firefox's Opus decoder sometimes outputs more channels than requested
		// (e.g. 6 for stereo). Clamp to the ring's channel count.
		const channels = Math.min(sample.numberOfChannels, ring.channels);
		const channelData: Float32Array[] = [];
		for (let channel = 0; channel < channels; channel++) {
			const data = new Float32Array(frames);
			sample.copyTo(data, { format: "f32-planar", planeIndex: channel, frameOffset, frameCount: frames });
			channelData.push(data);
		}

		// Hand off to the ring. Shared transport writes directly; post transport
		// transfers the ArrayBuffers.
		ring.insert(timestamp, channelData);
		// Media is back, so the declared pause is over and the next playhead event is somebody
		// else's. The ring takes its own endpoint back on the same write.
		this.#ended = false;

		sample.close();
	}

	#addDecodeBuffered(start: Time.Milli, end: Time.Milli): void {
		if (start > end) return;

		this.#decodeBuffered.mutate((current) => {
			for (const range of current) {
				// Extend range if new sample overlaps or is adjacent (1ms tolerance for float precision)
				if (start <= range.end + 1 && end >= range.start) {
					range.start = Time.Milli.min(range.start, start);
					range.end = Time.Milli.max(range.end, end);
					return;
				}
			}

			current.push({ start, end });
			current.sort((a, b) => a.start - b.start);
		});
	}

	// Drop reported decode ranges at or after `timestamp`, mirroring a ring truncation.
	#truncateDecodeBuffered(timestamp: Time.Milli): void {
		this.#decodeBuffered.mutate((current) => {
			while (current.length > 0 && current[current.length - 1].start >= timestamp) current.pop();
			const last = current[current.length - 1];
			if (last && last.end > timestamp) last.end = timestamp;
		});
	}

	#trimDecodeBuffered(timestamp: Time.Milli): void {
		this.#decodeBuffered.mutate((current) => {
			while (current.length > 0) {
				if (current[0].end >= timestamp) {
					current[0].start = Time.Milli.max(current[0].start, timestamp);
					break;
				}
				current.shift();
			}
		});
	}

	// Flush the audio buffer and re-stall, re-anchoring playback to the next frame.
	// Use in buffered mode at an utterance boundary (see Sync.reset).
	reset(): void {
		this.#ring?.reset();
	}

	/**
	 * Tell the ring the publisher declared the timeline finished here.
	 *
	 * Everything before the endpoint has been handed to the decoder, but its PCM may still be in
	 * flight, and the ring may only render silence once it holds all of it. Each hang audio frame is
	 * independently decodable, so flushing costs nothing but the wait.
	 */
	async #declareEnd(decoder: AudioDecoder, anchor: Anchor): Promise<void> {
		if (decoder.state === "configured") {
			// A flush rejects only when the decoder is torn down under it, in which case the ring is
			// going away too and there is no endpoint left to declare.
			const flushed = await decoder.flush().then(
				() => true,
				() => false,
			);
			// A flushed decoder starts a new run, so whatever follows the endpoint has to open it.
			anchor.restarted();
			if (!flushed) return;
		}
		this.#ring?.end();
		this.#ended = true;
	}

	// Apply ordered container metadata before handling the result.
	//
	// The consumer raises the playhead on the result that closes a marker group, which arrives after
	// the endpoint that group carried, so the flush above has already queued the tail. Throwing it
	// away here would spend the declared pause as a flush instead of playing it out, and leave the
	// ring parked with nothing to un-park it. A hole or a conviction has no tail to protect and
	// still resets.
	#onNext(next: {
		discontinuity: number;
		group: number;
		end?: Time.Micro;
		frame?: { timestamp: Time.Micro };
	}): boolean {
		if (!this.#terminal.update(next)) return false;
		if (!this.#ended) this.#ring?.reset();
		this.sync.reset();
		return true;
	}

	close() {
		this.#signals.close();
	}
}

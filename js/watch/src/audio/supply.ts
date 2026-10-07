import * as Catalog from "@moq/hang/catalog";
import * as Container from "@moq/hang/container";
import * as Util from "@moq/hang/util";
import type * as Moq from "@moq/net";
import { Time } from "@moq/net";
import { type Computed, Effect, type Getter, type Readonlys, readonlys, Signal } from "@moq/signals";
import { base64ToBytes } from "../base64";
import { nextMedia, subscribeMedia } from "../media";
import type { Sync } from "../sync";
import { type AudioBuffer, type AudioBufferProps, createAudioBuffer, type RingTarget } from "./buffer";
import { type DecoderConfig, frameDuration, type PlaybackIdentity, packetDuration, playbackIdentity } from "./config";
import type { Stats } from "./decoder";
import { Handover } from "./handover";
import { ringSamples } from "./latency";
import type { Source } from "./source";
import { type DecodedSpan, Terminal } from "./terminal";
import { Warmup } from "./warmup";

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
	/** Whether the ring is shared memory rather than messages, which needs a cross-origin isolated page. */
	shared: boolean;
}

/** What the ring reports about itself, and nothing that writes to it. */
export type RingState = Pick<AudioBuffer, "timestamp" | "clock" | "stalled" | "underruns" | "debug">;

/** The part of {@link Sync} a supply reports to. */
export type SupplySync = Pick<Sync, "received" | "reset">;

/** The wired dependencies of a {@link Supply}. */
export type SupplyInput = {
	/** Whether to download the audio track. */
	enabled: Getter<boolean>;

	/** Where the ring's writes go, or undefined while there is no graph to play them. */
	graph: Getter<Graph | undefined>;

	/** The ring's depth: `sync.out.delay`. */
	target: Getter<Time.Milli>;

	/** The container consumer's age budget: `sync.out.maxAge`. */
	maxAge: Getter<Time.Milli>;

	/** The transport subscription's age budget, which "auto" raises to the estimator's ceiling. */
	subscribeMaxAge: Getter<Time.Milli>;

	/** Whether the delay is "instant", which holds no buffer and so refuses audio. */
	instant: Getter<boolean>;

	/** Whether playback buffers a lookahead (`sync.out.buffered`), which the ring reads when it is built. */
	buffered: Getter<boolean>;
};

/** Constructor properties for {@link Supply}. */
export type SupplyProps = SupplyInput & {
	/** Rendition selector supplying encoded audio. */
	source: Source;
	/** Shared playback clock. */
	sync: SupplySync;
	/**
	 * Makes WebCodecs' `AudioDecoder` available before the first decode, resolving true once it is: the
	 * page's polyfill for a browser without one. Absent, the decoder must be native. Handed in rather
	 * than called from here, so a bundle that never needs the polyfill leaves it out.
	 */
	polyfill?: () => Promise<boolean>;
};

/** What a {@link Supply} publishes. */
export type SupplyOutput = {
	// The rate the decoder actually outputs, learned from the first decoded frame. This is the source
	// of truth for the graph: a decoder can output a different rate than it was configured with (e.g.
	// Opus decodes to 48kHz on Chrome/Firefox but to the configured rate on Safari). Until a frame
	// arrives the graph is built at the catalog rate; if the real rate differs it is rebuilt.
	rate: Signal<number | undefined>;

	// The container consumer's arrival estimate, unset while nothing is subscribed.
	measured: Signal<Time.Milli | undefined>;

	// The codec's frame duration: the catalog constant, refined by each frame's own duration.
	frame: Signal<Time.Milli | undefined>;

	// Combined buffered ranges (network jitter + decode buffer)
	buffered: Signal<Container.BufferedRanges>;

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
		measured: new Signal<Time.Milli | undefined>(undefined),
		frame: new Signal<Time.Milli | undefined>(undefined),
		buffered: new Signal<Container.BufferedRanges>([]),
		stats: new Signal<Stats | undefined>(undefined),
		ring: new Signal<RingState | undefined>(undefined),
	};
	readonly out = readonlys(this.#out);

	// Decode buffer: audio sent to worklet but not yet played
	#decodeBuffered = new Signal<Container.BufferedRanges>([]);

	// Audio ring bridging the decode loop and the worklet (shared memory or postMessage transport).
	#ring = new Signal<AudioBuffer | undefined>(undefined);

	// Ordered discontinuity and endpoint state from the container consumer.
	#terminal = new Terminal();

	// Which subscription the ring's buffered samples came from. See #runDecoder.
	#handover = new Handover();

	// The broadcast instance the ring's timeline belongs to. See #runDecoder.
	#instance?: Moq.Broadcast.Consumer["closed"];

	#signals = new Effect();

	// The catalog fields that require a replacement subscription or decoder.
	readonly #identity: Computed<PlaybackIdentity | undefined>;

	// See `SupplyProps.polyfill`.
	readonly #polyfill: () => Promise<boolean>;

	constructor(props: SupplyProps) {
		this.in = {
			enabled: props.enabled,
			graph: props.graph,
			target: props.target,
			maxAge: props.maxAge,
			subscribeMaxAge: props.subscribeMaxAge,
			instant: props.instant,
			buffered: props.buffered,
		};

		this.source = props.source;
		this.sync = props.sync;
		this.#polyfill = props.polyfill ?? (async () => true);
		this.#identity = this.#signals.computed((effect) => {
			const config = effect.get(this.source.out.config);
			return config ? playbackIdentity(config) : undefined;
		});

		this.#signals.run(this.#runRing.bind(this));
		this.#signals.run(this.#runLatency.bind(this));
		this.#signals.run(this.#runDecoder.bind(this));
	}

	// Build the ring against the graph, for as long as there is one.
	#runRing(effect: Effect): void {
		const graph = effect.get(this.in.graph);
		if (!graph) return;

		// Initial ring depth in samples.
		const delay = this.in.target.peek();
		const latencySamples = ringSamples(graph.rate, delay);

		// The transport is the graph's: shared memory where the page can have it, messages otherwise.
		const ring = createAudioBuffer(graph.target, {
			context: graph.context,
			channels: graph.channels,
			rate: graph.rate,
			latency: latencySamples,
			buffered: this.in.buffered.peek(),
			conceal: graph.conceal,
			shared: graph.shared,
		});
		effect.cleanup(() => ring.close());
		effect.set(this.#ring, ring);

		// Whatever the ring has played is no longer buffered ahead of it.
		effect.run((inner) => this.#trimDecodeBuffered(Time.Milli.fromMicro(inner.get(ring.timestamp))));

		effect.set(this.#out.ring, ring);
	}

	// Hold the ring at the depth the target asks for.
	#runLatency(effect: Effect): void {
		const ring = effect.get(this.#ring);
		if (!ring) return;

		// A rise parks playback until the ring refills to the new floor, which is what keeps audio in
		// step with video. The measured target moves a bucket at a time, and a rise the buffered
		// slack already covers costs no silence at all.
		const delay = effect.get(this.in.target);
		ring.setLatency(ringSamples(ring.rate, delay));
	}

	#runDecoder(effect: Effect): void {
		const enabled = effect.get(this.in.enabled);
		if (!enabled) return;
		if (effect.get(this.in.instant)) return;

		const broadcast = effect.get(this.source.in.broadcast);
		if (!broadcast) return;

		const track = effect.get(this.source.out.track);
		if (!track) return;

		const identity = effect.get(this.#identity);
		if (!identity) return;

		const config = identity.decoder;
		this.#out.frame.set(frameDuration(config));
		// The rate a decoder emits belongs to the decoder that learned it, so a new subscription starts
		// without one and reports again if the graph it finds is at another rate.
		this.#out.rate.set(undefined);

		// Honor a per-rendition `broadcast` override: subscribe on the resolved source
		// broadcast instead of the catalog's own broadcast.
		const active = broadcast.relativeBroadcast(effect, identity.broadcast);
		if (!active) return;

		// Another broadcast (a new name, or a republish) brings its own timeline, which a ring anchored
		// on the previous one would discard as already played. A return to the same instance keeps the
		// anchor, so the relay's redelivered last group is still dropped as old. Every handle to one
		// instance shares `closed`, so it identifies the instance where the handle itself does not.
		if (this.#instance !== undefined && this.#instance !== active.closed) {
			this.#ring.peek()?.reset();
			this.#decodeBuffered.set([]);
		}
		this.#instance = active.closed;

		// The ring outlives this effect (it's keyed on the sample rate and channel count), so a
		// replacement subscription on the same broadcast (a rendition swap, a return from an absence)
		// inherits whatever its predecessor decoded. Samples are timestamp indexed, so the replacement
		// overwrites the slots it lands on, but a publisher writing ahead of real-time leaves seconds
		// of tail beyond them. Drop that once the replacement's first frame says where it starts.
		this.#handover.opened();

		const sub = subscribeMedia(effect, {
			broadcast: active,
			track,
			priority: Catalog.PRIORITY.audio,
			maxAge: this.in.subscribeMaxAge,
		});
		if (!sub) return;

		if (config.container.kind === "cmaf") {
			this.#runCmafDecoder(effect, sub, config);
		} else {
			this.#runLegacyDecoder(effect, sub, config);
		}
	}

	#runLegacyDecoder(effect: Effect, sub: Moq.Track.Subscriber, config: DecoderConfig): void {
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
		});
		effect.cleanup(() => consumer.close());

		// Combine network jitter buffer with decode buffer
		effect.run((inner) => {
			const network = inner.get(consumer.buffered);
			const decode = inner.get(this.#decodeBuffered);
			this.#out.buffered.update(() => Container.mergeBufferedRanges(network, decode));
		});

		// Publish the arrival estimate. Cleared on teardown so a departed track stops holding the buffer
		// open.
		effect.run((inner) => this.#out.measured.set(inner.get(consumer.spread)));
		effect.cleanup(() => this.#out.measured.set(undefined));

		effect.spawn(async () => {
			const loaded = await this.#polyfill();
			if (!loaded) return; // cancelled

			const warmup = new Warmup(LEGACY_WARMUP_CALLBACKS);

			const decoder = new AudioDecoder({
				output: (data) => {
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
				}
				if (next.end !== undefined) {
					continue;
				}

				const { frame } = next;
				if (!frame) continue;

				// Mark that we received this frame right now.
				const timestamp = Time.Milli.fromMicro(frame.timestamp as Time.Micro);
				this.sync.received(timestamp, "audio");

				const duration = packetDuration(config.codec, frame);
				if (duration !== undefined) this.#out.frame.set(duration);

				this.#out.stats.update((stats) => ({
					bytesReceived: (stats?.bytesReceived ?? 0) + frame.payload.byteLength,
				}));

				const ring = await this.#ready(effect);
				if (!ring) break;

				// Backpressure: in buffered mode this holds the encoded frame until the playhead nears
				// it, keeping the lookahead above the floor as Opus instead of decoded PCM. No-op live.
				await ring.wait(frame.timestamp as Time.Micro);

				const chunk = new EncodedAudioChunk({
					type: frame.keyframe ? "key" : "delta",
					data: frame.payload,
					timestamp: frame.timestamp,
				});

				// A fatal decode error closes the decoder, so decoding again throws InvalidStateError out
				// of this loop. Stop instead: the error callback already reported the real failure.
				if (decoder.state === "closed") break;
				decoder.decode(chunk);
			}
		});
	}

	#runCmafDecoder(effect: Effect, sub: Moq.Track.Subscriber, config: DecoderConfig): void {
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
		});
		effect.cleanup(() => consumer.close());

		// Combine network jitter buffer with decode buffer
		effect.run((inner) => {
			const network = inner.get(consumer.buffered);
			const decode = inner.get(this.#decodeBuffered);
			this.#out.buffered.update(() => Container.mergeBufferedRanges(network, decode));
		});

		// Publish the arrival estimate. Cleared on teardown so a departed track stops holding the buffer
		// open.
		effect.run((inner) => this.#out.measured.set(inner.get(consumer.spread)));
		effect.cleanup(() => this.#out.measured.set(undefined));

		effect.spawn(async () => {
			const loaded = await this.#polyfill();
			if (!loaded) return; // cancelled

			const decoder = new AudioDecoder({
				output: (data) => this.#emit(data),
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

			for (;;) {
				const next = await nextMedia(consumer);
				if (!next) break;

				// Reset and re-anchor before decoding the first frame of a new codec epoch.
				if (this.#onNext(next)) {
					decoder.reset();
					decoder.configure(decoderConfig);
				}

				const { frame } = next;
				if (!frame) continue;

				const timestamp = Time.Milli.fromMicro(frame.timestamp);
				this.sync.received(timestamp, "audio");

				const duration = packetDuration(config.codec, frame);
				if (duration !== undefined) this.#out.frame.set(duration);

				this.#out.stats.update((stats) => ({
					bytesReceived: (stats?.bytesReceived ?? 0) + frame.payload.byteLength,
				}));

				const ring = await this.#ready(effect);
				if (!ring) break;

				// Backpressure: in buffered mode this holds the encoded frame until the playhead nears
				// it, keeping the lookahead above the floor as Opus instead of decoded PCM. No-op live.
				await ring.wait(frame.timestamp);

				if (decoder.state === "closed") break;
				decoder.decode(
					new EncodedAudioChunk({
						type: frame.keyframe ? "key" : "delta",
						data: frame.payload,
						timestamp: frame.timestamp,
					}),
				);
			}
		});
	}

	// The ring, once there is a graph to build it against. Decoding waits for it, so the frames that
	// arrive first queue in the consumer instead of being decoded into nowhere. Undefined once `effect`
	// is torn down.
	async #ready(effect: Effect): Promise<AudioBuffer | undefined> {
		for (;;) {
			const ring = this.#ring.peek();
			if (ring) return ring;
			await effect.race(Signal.race(this.#ring));
			if (effect.abort.aborted) return undefined;
		}
	}

	#emit(sample: AudioData, decoded: DecodedSpan = this.#terminal.span(sample)) {
		const { timestamp, frameOffset, frames } = decoded;
		const timestampMilli = Time.Milli.fromMicro(timestamp);
		if (frames === 0) {
			sample.close();
			return;
		}

		const ring = this.#ring.peek();
		if (!ring) {
			// The graph is being rebuilt or closed.
			sample.close();
			return;
		}

		// sample.sampleRate is the source of truth, and it can differ from the rate the graph was
		// pre-built at (Opus decodes to 48kHz on Chrome/Firefox but to the configured rate on Safari).
		// If they disagree, report the real rate so the graph is rebuilt at it, and drop this frame; the
		// ring being torn down can't accept it, and the next frame lands in the new ring.
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
		this.#ring.peek()?.reset();
	}

	// Apply ordered container metadata before handling the result. An endpoint that also
	// starts a new epoch must survive the reset so its following drain is trimmed.
	#onNext(next: {
		discontinuity: number;
		group: number;
		end?: Time.Micro;
		frame?: { timestamp: Time.Micro };
	}): boolean {
		if (!this.#terminal.update(next)) return false;
		this.#ring.peek()?.reset();
		this.sync.reset();
		return true;
	}

	close() {
		this.#signals.close();
	}
}

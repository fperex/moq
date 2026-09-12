import * as Catalog from "@moq/hang/catalog";
import * as Container from "@moq/hang/container";
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
import { base64ToBytes } from "../base64";
import { nextMedia, subscribeMedia } from "../media";

import type { Clock, Sync } from "../sync";
import { AudioBuffer } from "./buffer";
import { type DecoderConfig, decoderConfig, type PlaybackIdentity, playbackIdentity } from "./config";
import { duration } from "./duration";
import { Handover } from "./handover";
import { reanchorFloor } from "./latency";
import type { Stats as PlayoutStats } from "./playout";
import type { Policy } from "./render";
// Compiled and inlined as a blob URL via vite-plugin-worklet.
import RenderWorklet from "./render-worklet.ts?worklet";
import type { Source } from "./source";
import { type DecodedSpan, Terminal } from "./terminal";
import { unlockOnGesture } from "./unlock";
import { Warmup } from "./warmup";

// How long the latency target must hold steady before a floor increase re-anchors. Coalesces a
// slider drag (many small steps) into a single re-anchor once the user settles on a value.
const LATENCY_REANCHOR_DEBOUNCE_MS = 150;

const LEGACY_WARMUP_CALLBACKS = 3;

export type DecoderInput = {
	// Whether to download the audio track. Defaults to true.
	enabled: Getter<boolean>;
};

type DecoderOutput = {
	clock: Signal<Clock | undefined>;
	target: Signal<Time.Milli | undefined>;
	playout: Signal<PlayoutStats | undefined>;
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

	// Combined buffered ranges (network jitter + decode buffer)
	buffered: Signal<Container.BufferedRanges>;
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
		clock: new Signal<Clock | undefined>(undefined),
		target: new Signal<Time.Milli | undefined>(undefined),
		playout: new Signal<PlayoutStats | undefined>(undefined),
		context: new Signal<AudioContext | undefined>(undefined),
		root: new Signal<AudioNode | undefined>(undefined),
		sampleRate: new Signal<number | undefined>(undefined),
		stats: new Signal<Stats | undefined>(undefined),
		timestamp: new Signal<Time.Milli | undefined>(undefined),
		stalled: new Signal<boolean>(true),
		buffered: new Signal<Container.BufferedRanges>([]),
	};
	readonly out = readonlys(this.#out);

	// Decode buffer: audio sent to worklet but not yet played
	#decodeBuffered = new Signal<Container.BufferedRanges>([]);

	// Audio ring bridging main thread and worklet (shared memory or postMessage transport).
	#ring: AudioBuffer | undefined;

	// The rate the decoder actually outputs, learned from the first decoded frame. This is the source
	// of truth for the graph: a decoder can output a different rate than it was configured with (e.g.
	// Opus decodes to 48kHz on Chrome/Firefox but to the configured rate on Safari). Until a frame
	// arrives we pre-build the graph from the catalog rate; if the real rate differs we rebuild it.
	#decodedSampleRate = new Signal<number | undefined>(undefined);

	// Ordered discontinuity and endpoint state from the container consumer.
	#terminal = new Terminal();

	// The latency floor as of the last settled change, to detect a floor *increase* (needs a deeper
	// cushion) versus a decrease or a real-time RTT wiggle. See #runLatencyReanchor.
	#prevFloor?: Time.Milli;

	// Which subscription the ring's buffered samples came from. See #runDecoder.
	#handover = new Handover();

	#signals = new Effect();

	// The catalog fields that require a replacement subscription or decoder.
	readonly #identity: Computed<PlaybackIdentity | undefined>;

	// The decoder fields that require a new audio graph. Routing and metadata changes leave the
	// context, worklet, and ring alone.
	readonly #config: Computed<DecoderConfig | undefined>;

	constructor(source: Source, sync: Sync, props?: Inputs<DecoderInput>) {
		this.in = {
			enabled: getter(props?.enabled ?? true),
		};

		this.source = source;
		this.sync = sync;
		this.#identity = this.#signals.computed((effect) => {
			const config = effect.get(this.source.out.config);
			return config ? playbackIdentity(config) : undefined;
		});
		this.#config = this.#signals.computed((effect) => {
			const config = effect.get(this.source.out.config);
			return config ? decoderConfig(config) : undefined;
		});

		this.#signals.run(this.#runWorklet.bind(this));
		this.#signals.run(this.#runEnabled.bind(this));
		this.#signals.run(this.#runLatency.bind(this));
		this.#signals.run(this.#runLatencyReanchor.bind(this));
		this.#signals.run(this.#runDecoder.bind(this));
	}

	#runWorklet(effect: Effect): void {
		// It takes a second or so to initialize the AudioContext/AudioWorklet, so do it even if disabled.
		// This is less efficient for video-only playback but makes muting/unmuting instant.

		//const enabled = effect.get(this.enabled);
		//if (!enabled) return;

		const config = effect.get(this.#config);
		if (!config) return;

		// Pre-build the graph at the catalog rate so warm-up starts before the first frame arrives. The
		// decoder's actual output rate is the source of truth (see #emit); if it differs, #emit sets
		// #decodedSampleRate, which re-runs this effect and rebuilds the graph at the real rate.
		const sampleRate = effect.get(this.#decodedSampleRate) ?? config.sampleRate;
		const channelCount = config.numberOfChannels;

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

			// Let the factory pick the best transport (SharedArrayBuffer or postMessage).
			const ring = new AudioBuffer({
				worklet,
				channels: channelCount,
				rate: context.sampleRate,
				policy: this.#policy(),
			});
			this.#ring = ring;
			effect.cleanup(() => {
				ring.close();
				this.#ring = undefined;
			});

			// Mirror ring state (timestamp/stalled) onto our public signals.
			effect.run((inner) => {
				const ts = Time.Milli.fromMicro(inner.get(ring.timestamp));
				this.#out.timestamp.set(ts);
				this.#trimDecodeBuffered(ts);
			});
			effect.run((inner) => {
				this.#out.stalled.set(inner.get(ring.stalled));
			});

			effect.run((inner) => {
				const enabled = inner.get(this.in.enabled);
				this.#out.clock.set(enabled ? inner.get(ring.clock) : undefined);
				this.#out.target.set(enabled ? inner.get(ring.target) : undefined);
				this.#out.playout.set(inner.get(ring.stats));
			});
			effect.cleanup(() => {
				this.#out.clock.set(undefined);
				this.#out.target.set(undefined);
				this.#out.playout.set(undefined);
			});
			effect.set(this.#out.root, worklet);
		});
	}

	#runEnabled(effect: Effect): void {
		const enabled = effect.get(this.in.enabled);
		if (!enabled) {
			this.#ring?.reset();
			return;
		}

		const context = effect.get(this.#out.context);
		if (!context) return;

		// The context is built at page load (see #runWorklet), before any user gesture, so it
		// must be started from a real interaction. See unlockOnGesture.
		unlockOnGesture(effect, context);

		// NOTE: You should disconnect/reconnect the worklet to save power when disabled.
	}

	#runLatency(effect: Effect): void {
		// Gate on the worklet signal so this effect re-runs once the ring is created.
		const worklet = effect.get(this.#out.root);
		if (!worklet) return;

		const ring = this.#ring;
		if (!ring) return;

		effect.get(this.sync.out.delay);
		effect.get(this.sync.out.jitter);
		effect.get(this.sync.out.buffered);
		effect.get(this.sync.in.delay);
		effect.get(this.sync.in.audio);
		effect.get(this.sync.in.video);
		ring.configure(this.#policy());
	}

	#policy(): Policy {
		const delay = this.sync.in.delay.peek();
		const mode =
			delay === "instant"
				? "instant"
				: this.sync.out.buffered.peek()
					? "buffered"
					: delay === "auto"
						? "auto"
						: "fixed";
		const target =
			mode === "auto"
				? this.sync.out.jitter.peek() + Math.max(this.sync.in.audio.peek() ?? 0, this.sync.in.video.peek() ?? 0)
				: this.sync.out.delay.peek();
		return { kind: "target", mode, milliseconds: Math.max((128 / (this.#ring?.rate ?? 48000)) * 1000, target) };
	}

	// Re-anchor when the delay floor *increases*. A larger floor needs a deeper cushion: video
	// rebuilds it implicitly (its per-frame sync.wait() reads the live buffer, so it just holds
	// longer), but the audio ring keeps draining at its old depth -- resize() (via setLatency) only
	// re-stalls an *empty* ring, so a mid-playback ring never refills to the new floor and audio runs
	// ahead of video (the "raise latency, only video re-buffers" desync). reset() re-stalls the ring
	// so it refills to the new floor. Watch the latency target and media delay, excluding adaptive
	// RTT jitter, and debounce so a slider drag coalesces into one re-anchor. Decreases are left to
	// natural catch-up.
	#runLatencyReanchor(effect: Effect): void {
		const floor = reanchorFloor({
			delay: effect.get(this.sync.in.delay),
			audio: effect.get(this.sync.in.audio),
			video: effect.get(this.sync.in.video),
		});
		if (this.#prevFloor === undefined) {
			// Startup: the initial fill already builds the cushion; just record the baseline.
			this.#prevFloor = floor;
			return;
		}
		// When the timer fires, the floor read above is still current: any change would have rerun
		// this effect (tearing down the timer), so compare it against the pre-change baseline directly.
		const baseline = this.#prevFloor;
		effect.timer(() => {
			if (floor > baseline) this.reset();
			this.#prevFloor = floor;
		}, LATENCY_REANCHOR_DEBOUNCE_MS);
	}

	#runDecoder(effect: Effect): void {
		const enabled = effect.get(this.in.enabled);
		if (!enabled) return;

		const broadcast = effect.get(this.source.in.broadcast);
		if (!broadcast) return;

		const track = effect.get(this.source.out.track);
		if (!track) return;

		const identity = effect.get(this.#identity);
		if (!identity) return;

		const config = identity.decoder;

		// Honor a per-rendition `broadcast` override: subscribe on the resolved source
		// broadcast instead of the catalog's own broadcast.
		const active = broadcast.relativeBroadcast(effect, identity.broadcast);
		if (!active) return;

		// The ring outlives this effect (it's keyed on the sample rate and channel count), so a
		// replacement subscription (a rendition swap, a republished broadcast, a reconnect) inherits
		// whatever its predecessor decoded. Samples are timestamp indexed, so the replacement
		// overwrites the slots it lands on, but a publisher writing ahead of real-time leaves seconds
		// of tail beyond them. Drop that once the replacement's first frame says where it starts.
		this.#handover.opened();

		const sub = subscribeMedia(effect, {
			broadcast: active,
			track,
			priority: Catalog.PRIORITY.audio,
			maxAge: this.sync.out.maxAge,
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
			maxAge: this.sync.out.maxAge,
		});
		effect.cleanup(() => consumer.close());

		// Combine network jitter buffer with decode buffer
		effect.run((inner) => {
			const network = inner.get(consumer.buffered);
			const decode = inner.get(this.#decodeBuffered);
			this.#out.buffered.update(() => Container.mergeBufferedRanges(network, decode));
		});

		effect.spawn(async () => {
			const loaded = await Util.Libav.polyfill();
			if (!loaded) return; // cancelled

			const warmup = new Warmup(LEGACY_WARMUP_CALLBACKS);

			let decoder: AudioDecoder;
			const createDecoder = () => {
				const current = new AudioDecoder({
					output: (data) => {
						// Libav can deliver queued output after close; it belongs to the old timeline.
						if (effect.abort.aborted || decoder !== current) {
							data.close();
							return;
						}
						try {
							const decoded = this.#terminal.spans(data);
							if (!warmup.drop()) this.#emit(data, decoded);
						} finally {
							data.close();
						}
					},
					error: (error) => {
						if (!effect.abort.aborted && decoder === current) console.error("audio decoder error", error);
					},
				});
				return current;
			};
			decoder = createDecoder();
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
					decoder.close();
					decoder = createDecoder();
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

				this.#out.stats.update((stats) => ({
					bytesReceived: (stats?.bytesReceived ?? 0) + frame.payload.byteLength,
				}));

				// Backpressure: in buffered mode this holds the encoded frame until the playhead nears
				// it, keeping the lookahead above the floor as Opus instead of decoded PCM. No-op live.
				if (!(await this.#ready(effect, decoder, frame.timestamp as Time.Micro))) break;

				const packetDuration = duration(config, frame);
				this.#terminal.push({ timestamp: frame.timestamp, duration: packetDuration });
				const chunk = new EncodedAudioChunk({
					duration: packetDuration === undefined ? undefined : Math.round(packetDuration),
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
			maxAge: this.sync.out.maxAge,
		});
		effect.cleanup(() => consumer.close());

		// Combine network jitter buffer with decode buffer
		effect.run((inner) => {
			const network = inner.get(consumer.buffered);
			const decode = inner.get(this.#decodeBuffered);
			this.#out.buffered.update(() => Container.mergeBufferedRanges(network, decode));
		});

		effect.spawn(async () => {
			const loaded = await Util.Libav.polyfill();
			if (!loaded) return; // cancelled

			let decoder: AudioDecoder;
			const createDecoder = () => {
				const current = new AudioDecoder({
					output: (data) => {
						if (effect.abort.aborted || decoder !== current) {
							data.close();
							return;
						}
						try {
							this.#emit(data, this.#terminal.spans(data));
						} finally {
							data.close();
						}
					},
					error: (error) => {
						if (!effect.abort.aborted && decoder === current) console.error("audio decoder error", error);
					},
				});
				return current;
			};
			decoder = createDecoder();
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
					decoder.close();
					decoder = createDecoder();
					decoder.configure(decoderConfig);
				}

				const { frame } = next;
				if (!frame) continue;

				const timestamp = Time.Milli.fromMicro(frame.timestamp);
				this.sync.received(timestamp, "audio");

				this.#out.stats.update((stats) => ({
					bytesReceived: (stats?.bytesReceived ?? 0) + frame.payload.byteLength,
				}));

				// Backpressure: in buffered mode this holds the encoded frame until the playhead nears
				// it, keeping the lookahead above the floor as Opus instead of decoded PCM. No-op live.
				if (!(await this.#ready(effect, decoder, frame.timestamp))) break;

				if (decoder.state === "closed") break;
				const packetDuration = duration(config, frame);
				this.#terminal.push({ timestamp: frame.timestamp, duration: packetDuration });
				decoder.decode(
					new EncodedAudioChunk({
						duration: packetDuration === undefined ? undefined : Math.round(packetDuration),
						type: frame.keyframe ? "key" : "delta",
						data: frame.payload,
						timestamp: frame.timestamp,
					}),
				);
			}
		});
	}

	async #ready(effect: Effect, decoder: AudioDecoder, timestamp: Time.Micro): Promise<boolean> {
		await this.#ring?.wait(timestamp, effect.abort);
		while (!effect.abort.aborted && decoder.state === "configured" && decoder.decodeQueueSize >= 2) {
			const changed = Promise.withResolvers<void>();
			const dequeue = () => changed.resolve();
			decoder.addEventListener("dequeue", dequeue, { once: true });
			try {
				await Promise.race([changed.promise, effect.cancel]);
			} finally {
				decoder.removeEventListener("dequeue", dequeue);
			}
		}
		return !effect.abort.aborted && decoder.state === "configured";
	}

	#emit(sample: AudioData, decoded: DecodedSpan[]) {
		for (const span of decoded) {
			const { timestamp, frameOffset, frames } = span;
			const timestampMilli = Time.Milli.fromMicro(timestamp);
			if (frames === 0) {
				continue;
			}

			const ring = this.#ring;
			if (!ring) {
				return;
			}

			// sample.sampleRate is the source of truth, and it can differ from the rate we pre-built the
			// graph against (Opus decodes to 48kHz on Chrome/Firefox but to the configured rate on Safari).
			// If they disagree, rebuild the graph at the real rate and drop this frame; the ring being torn
			// down can't accept it, and the next frame lands in the correctly-rated ring.
			if (sample.sampleRate !== ring.rate) {
				this.#decodedSampleRate.set(sample.sampleRate);
				return;
			}

			const durationMicro = ((frames / sample.sampleRate) * 1_000_000) as Time.Micro;
			const durationMilli = Time.Milli.fromMicro(durationMicro);
			const end = Time.Milli.add(timestampMilli, durationMilli);

			// A new subscription has taken over the timeline: drop the previous one's write-ahead tail
			// rather than letting it play out after this frame. See #runDecoder.
			if (this.#handover.takeover()) {
				ring.truncate(timestamp, this.#terminal.end);
				this.#truncateDecodeBuffered(timestampMilli);
			}

			this.#addDecodeBuffered(timestampMilli, end);

			// Firefox's Opus decoder sometimes outputs more channels than requested
			// (e.g. 6 for stereo). Clamp to the ring's channel count.
			const channels = Math.min(sample.numberOfChannels, ring.channels);
			const channelData = Array.from({ length: channels }, () => new Float32Array(frames));
			// Omit a full remainder count because Libav rejects that optional bound.
			const frameCount = frames < sample.numberOfFrames - frameOffset ? frames : undefined;
			if (sample.format?.endsWith("-planar")) {
				for (let channel = 0; channel < channels; channel++) {
					sample.copyTo(channelData[channel], {
						format: "f32-planar",
						planeIndex: channel,
						frameOffset,
						frameCount,
					});
				}
			} else {
				// Copy packed output as packed PCM; Libav's packed-to-planar conversion misindexes stereo.
				const packed = new Float32Array(frames * sample.numberOfChannels);
				sample.copyTo(packed, { format: "f32", planeIndex: 0, frameOffset, frameCount });
				for (let channel = 0; channel < channels; channel++) {
					for (let frame = 0; frame < frames; frame++) {
						channelData[channel][frame] = packed[frame * sample.numberOfChannels + channel];
					}
				}
			}

			ring.insert(timestamp, channelData);
		}
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

	// Apply ordered container metadata before handling the result. An endpoint that also
	// starts a new epoch must survive the reset so its following drain is trimmed.
	#onNext(next: { discontinuity: number; end?: Time.Micro; frame?: { timestamp: Time.Micro } }): boolean {
		const changed = this.#terminal.update(next);
		if (!changed) {
			if (next.end !== undefined) this.#ring?.end(next.end);
			return false;
		}
		this.#ring?.reset();
		this.sync.reset();
		if (next.end !== undefined) this.#ring?.end(next.end);
		return true;
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
	await Util.Libav.polyfill();
	const res = await AudioDecoder.isConfigSupported({
		...config,
		description,
	});
	return res.supported ?? false;
}

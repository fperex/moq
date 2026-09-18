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
import { accumulate, Estimator, nextMedia, subscribeMedia } from "../media";

import type { Sync } from "../sync";
import {
	type DecoderConfig,
	decoderConfigKey,
	type PlaybackIdentity,
	playbackIdentity,
	supportCacheKey,
} from "./config";
import { caughtUp, renditionJitter, switchJitter } from "./playhead";
import { rotateVideoDimensions } from "./presentation";
import type { Source } from "./source";

// The amount of time to wait before considering the video to be buffering.
const BUFFERING = Time.Milli(500);

// How long the picture may sit frozen before the track is rebuilt from scratch.
//
// The 500ms watchdog above only labels the stall; nothing acts on it, so a subscription that stops
// producing leaves the tile frozen for as long as the viewer is willing to look at it. Long enough
// that an ordinary keyframe wait (a 2s GOP, plus the flush the publisher declares) never trips it,
// short enough that a viewer does not sit through it twice.
const RECOVER = Time.Milli(5_000);

// The ceiling the recovery window backs off to when rebuilding does not help.
//
// A publisher that advertises a video rendition and sends nothing would otherwise be re-subscribed
// every RECOVER for as long as the tab is open. Backing off keeps a hopeless case cheap without
// giving up on it; the window resets the moment a picture lands.
const RECOVER_MAX = Time.Milli(60_000);

// How long to wait before rebuilding a track whose codec errored.
//
// Not zero: a config the hardware refuses fails again the moment it is configured, and rebuilding
// within the same tick would spin. This is the floor on that retry, not a delay anything healthy
// pays.
const RETRY = Time.Milli(1_000);

export type DecoderInput = {
	/** Whether to download the video track. Defaults to true; the parent may wire it from the renderer's output. */
	enabled: Getter<boolean>;
};

/** Constructor properties for {@link Decoder}. */
export type DecoderProps = Inputs<DecoderInput> & {
	/** Rendition selector supplying encoded video. */
	source: Source;
	/** Shared playback clock. */
	sync: Sync;
};

/** Cumulative video statistics since the decoder started. */
export interface Stats {
	/** Number of decoded frames. */
	frameCount: number;

	/** Number of encoded bytes received. */
	bytesReceived: number;
}

type DecoderOutput = {
	// The current frame to render.
	frame: Signal<VideoFrame | undefined>;

	// The timestamp of the current frame.
	timestamp: Signal<Time.Milli | undefined>;

	// The display size of the video in pixels, ideally sourced from the catalog.
	display: Signal<{ width: number; height: number } | undefined>;

	stalled: Signal<boolean>;
	stats: Signal<Stats | undefined>;

	// The rendition delay Sync must cover while switching tracks.
	jitter: Signal<Time.Milli | undefined>;

	// Combined buffered ranges (network jitter + decode buffer)
	buffered: Signal<Container.BufferedRanges>;

	// How late video frames arrive relative to the earliest one, measured by the container
	// consumer. Wired into Sync by the parent, which sizes the "auto" delay from it.
	spread: Signal<Time.Milli | undefined>;

	// Groups that lost content above the decoder: the age budget skipped them, or the transport
	// gave up on delivering them in time.
	skipped: Signal<number>;
};

/** Downloads video from a track and decodes it into {@link VideoFrame}s with WebCodecs. */
export class Decoder {
	readonly in: Readonlys<DecoderInput>;
	readonly source: Source;
	readonly sync: Sync;

	readonly #out: DecoderOutput = {
		frame: new Signal<VideoFrame | undefined>(undefined),
		timestamp: new Signal<Time.Milli | undefined>(undefined),
		display: new Signal<{ width: number; height: number } | undefined>(undefined),
		stalled: new Signal<boolean>(false),
		stats: new Signal<Stats | undefined>(undefined),
		jitter: new Signal<Time.Milli | undefined>(undefined),
		buffered: new Signal<Container.BufferedRanges>([]),
		spread: new Signal<Time.Milli | undefined>(undefined),
		skipped: new Signal<number>(0),
	};
	readonly out = readonlys(this.#out);

	// The current track running, held so we can cancel it when the new track is ready.
	#active = new Signal<DecoderTrack | undefined>(undefined);
	#pendingJitter = new Signal<Time.Milli | undefined>(undefined);
	readonly #identity: Computed<PlaybackIdentity | undefined>;

	// How late this rendition's frames arrive, measured for as long as the rendition lasts rather
	// than for as long as one subscription does. See `#runSpread`.
	#spread = new Signal<Container.Jitter | undefined>(undefined);

	// What makes "as long as the rendition lasts" outlive the effect below, which ends the moment
	// the rendition leaves the catalog. See `Estimator`.
	#estimator = new Estimator();

	// The broadcast the current track is reading, so a different one is recognised as a new
	// publisher rather than a continuation. See `#runPending`.
	#broadcast?: Moq.Broadcast.Consumer;

	// Bumped to rebuild the track without anything else about the rendition changing: a codec that
	// errored, or a picture that stayed frozen past RECOVER. `#runPending` reads it, so a bump tears
	// the old subscription down and opens a new one at the live edge.
	#generation = new Signal(0);

	// How long the next stall is given before the track is rebuilt. Doubles on each rebuild that
	// does not produce a picture, and resets as soon as one lands. A plain field: `#runRecover`
	// re-runs on the stall, and making the backoff itself reactive would re-arm the timer it just
	// set.
	#recover = RECOVER;

	#signals = new Effect();

	#clearCurrentFrame(): void {
		this.#out.frame.update((prev) => {
			prev?.close();
			return undefined;
		});
		this.#out.timestamp.set(undefined);
	}

	constructor(props: DecoderProps) {
		this.in = {
			enabled: getter(props?.enabled ?? true),
		};

		this.source = props.source;
		this.sync = props.sync;
		this.#identity = this.#signals.computed((effect) => {
			const config = effect.get(this.source.out.config);
			return config ? playbackIdentity(config) : undefined;
		});

		this.#signals.run(this.#runJitter.bind(this));
		this.#signals.run(this.#runSpread.bind(this));
		this.#signals.run(this.#runPending.bind(this));
		this.#signals.run(this.#runActive.bind(this));
		this.#signals.run(this.#runDisplay.bind(this));
		this.#signals.run(this.#runBuffering.bind(this));
		this.#signals.run(this.#runRecover.bind(this));
	}

	// Rebuild the active track: drop it, then bump the generation so `#runPending` opens a fresh
	// subscription. The held frame stays on screen, so the tile keeps its last picture instead of
	// flashing empty while the new keyframe is fetched.
	//
	// Dropping `#active` first is load-bearing: `#runPending` holds a replacement back until it has
	// caught up with the picture it replaces, and a track that is already dead never gets there.
	#rebuild(reason: string): void {
		console.warn(`video: rebuilding the track: ${reason}`);
		this.#active.set(undefined);
		this.#generation.update((generation) => generation + 1);
	}

	#runJitter(effect: Effect): void {
		const active = effect.get(this.#active)?.jitter;
		const pending = effect.get(this.#pendingJitter);
		effect.set(this.#out.jitter, switchJitter({ active, pending }));
	}

	/**
	 * Measure how late frames arrive, for as long as the rendition lasts.
	 *
	 * One estimator per rendition rather than per subscription, the same rule the audio decoder
	 * keeps (`Audio.Decoder`'s `#runSpread`). A rebuild replaces the subscription, and every
	 * reason to rebuild is a path that just proved it delivers late; starting the measurement
	 * over at the publisher's declaration hands Sync a delay sized for a path nobody is on, so
	 * the shared delay collapses to whatever audio measured and the replacement subscription is
	 * convicted by a budget the picture could never meet. Cleared when the rendition goes, so a
	 * departed track stops holding the buffer open, and picked up again where it left off when the
	 * same rendition comes back: a camera hidden and shown is a gap in one rendition, not a new one.
	 */
	#runSpread(effect: Effect): void {
		const identity = effect.get(this.#identity);
		if (!identity) return;

		const spread = this.#estimator.spread(identity, renditionJitter(identity.decoder));
		effect.set(this.#spread, spread);
		effect.run((inner) => this.#out.spread.set(inner.get(spread.value)));
		effect.cleanup(() => this.#out.spread.set(undefined));
	}

	#runPending(effect: Effect): void {
		// A bump rebuilds the track even though nothing about the rendition changed. See `#rebuild`.
		effect.get(this.#generation);

		const values = effect.getAll([
			this.in.enabled,
			this.source.in.broadcast,
			this.source.out.track,
			this.#identity,
		]);
		if (!values) {
			// Close the active track when disabled (e.g. paused or not visible).
			// The pending cleanup won't do this because it was already promoted to #active.
			this.#active.set(undefined);
			return;
		}
		const [_, broadcast, track, identity] = values;

		// Honor a per-rendition `broadcast` override: subscribe on the resolved source
		// broadcast instead of the catalog's own broadcast.
		const active: Moq.Broadcast.Consumer | undefined = broadcast.relativeBroadcast(effect, identity.broadcast);
		if (!active) {
			// Going offline should clear the last rendered frame.
			this.#active.set(undefined);
			this.#clearCurrentFrame();
			this.#out.buffered.set([]);
			return;
		}

		// A different broadcast consumer is a different publisher: an element that followed a
		// republish (`reload`) rather than being rebuilt around it. The new encoder's timestamps
		// start near zero, so a clock still anchored to the old publisher parks every picture
		// behind a reference it can never reach. A rendition swap keeps the reference, since it
		// reopens a subscription on the timeline already playing.
		if (this.#broadcast !== undefined && this.#broadcast !== active) this.sync.reset();
		this.#broadcast = active;

		const spread = effect.get(this.#spread);
		if (!spread) return;

		// Start a new pending effect.
		let pending: DecoderTrack | undefined = new DecoderTrack({
			sync: this.sync,
			broadcast: active,
			track,
			config: identity.decoder,
			stats: this.#out.stats,
			spread,
		});
		effect.set(this.#pendingJitter, pending.jitter);

		effect.cleanup(() => pending?.close());

		// A codec error tears the track's own effect down, subscription included, and leaves
		// `#active` pointing at the corpse, so nothing below ever rebuilds: the relay sees the
		// subscription cancelled and never sees another, and the tile stalls for good while audio
		// keeps playing. Watch the track for it here instead, through promotion (the reference
		// outlives `pending`, which is cleared once it is promoted).
		const built = pending;
		effect.run((inner) => {
			const failed = inner.get(built.failed);
			if (!failed) return;

			// Rebuild after a beat: a config the hardware refuses fails again on configure, and an
			// immediate retry would spin within the tick.
			inner.timer(() => this.#rebuild(`decoder error: ${failed.message}`), RETRY);
		});

		effect.run((effect) => {
			if (!pending) return;

			const current = effect.get(this.#active);
			if (current) {
				// A zero timestamp is a rendered frame, not a missing one.
				const pendingTimestamp = effect.get(pending.timestamp);
				if (pendingTimestamp === undefined) return;

				// Hold off until the new rendition has caught up to the picture it's replacing.
				if (!caughtUp({ playhead: pendingTimestamp, active: effect.get(current.timestamp) })) return;
			}

			// Upgrade the pending track to active.
			// #runActive will be in charge of it now.
			this.#active.set(pending);
			this.#pendingJitter.set(undefined);
			pending = undefined;

			// This effect is done; close it to avoid a useless re-run.
			effect.close();
		});
	}

	#runActive(effect: Effect): void {
		const active = effect.get(this.#active);
		if (!active) {
			// Clear stale data when disabled (e.g. paused or not visible).
			this.#out.buffered.set([]);
			return;
		}

		effect.cleanup(() => active.close());

		// Clone the frame so we own it independently of the DecoderTrack.
		// proxy() would share the same reference, allowing the source to close our frame.
		effect.run((inner) => {
			const frame = inner.get(active.frame);
			this.#out.frame.update((prev) => {
				prev?.close();
				return frame?.clone();
			});
		});
		effect.proxy(this.#out.timestamp, active.timestamp);
		effect.proxy(this.#out.buffered, active.buffered);
		accumulate(effect, this.#out.skipped, active.skipped);
	}

	#runDisplay(effect: Effect): void {
		const catalog = effect.get(this.source.out.catalog);
		if (!catalog) return;

		const display = catalog.display;
		if (display) {
			effect.set(this.#out.display, { width: display.width, height: display.height });
			return;
		}

		const frame = effect.get(this.#out.frame);
		if (!frame) return;

		effect.set(
			this.#out.display,
			rotateVideoDimensions({ width: frame.displayWidth, height: frame.displayHeight }, catalog.rotation),
		);
	}

	#runBuffering(effect: Effect): void {
		const enabled = effect.get(this.in.enabled);
		if (!enabled) return;

		// A rendition that is not in the catalog is not late: a publisher hiding its camera takes
		// the picture away on purpose, and there is nothing on its way to wait for. The buffering
		// overlay reads this flag, so labelling that gap a stall spun a spinner over the held
		// picture for as long as the camera was away. The overlay gates its audio half the same
		// way, on there being a ring to speak for.
		if (!effect.get(this.source.out.config)) {
			this.#out.stalled.set(false);
			return;
		}

		const frame = effect.get(this.#out.frame);
		if (!frame) {
			this.#out.stalled.set(true);
			return;
		}

		this.#out.stalled.set(false);
		// A picture landed, so whatever the last stall was, it is over and the next one starts from
		// the full window again.
		this.#recover = RECOVER;

		effect.timer(() => {
			this.#out.stalled.set(true);
		}, BUFFERING);
	}

	// Act on a stall that lasts. `#runBuffering` only labels one, which left a subscription that
	// stopped producing frozen for as long as the viewer kept looking at it. Only a track we
	// believe is playing is worth replacing: with nothing active there is no subscription to
	// rebuild, and `#runPending` is already the thing waiting for the broadcast to come back.
	#runRecover(effect: Effect): void {
		if (!effect.get(this.in.enabled)) return;
		if (!effect.get(this.#active)) return;
		if (!effect.get(this.#out.stalled)) return;

		const after = this.#recover;
		effect.timer(() => {
			this.#recover = Time.Milli(Math.min(RECOVER_MAX, after * 2));
			this.#rebuild(`no frame for ${after}ms`);
		}, after);
	}

	close() {
		this.#clearCurrentFrame();

		this.#signals.close();
	}

	// Whether the WebCodecs video decoder can play this config.
	static supported = supported;
}

interface DecoderTrackProps {
	sync: Sync;
	broadcast: Moq.Broadcast.Consumer;
	track: string;
	config: DecoderConfig;

	stats: Signal<Stats | undefined>;

	/** The rendition's arrival estimator, which outlives this subscription. */
	spread: Container.Jitter;
}

class DecoderTrack {
	sync: Sync;
	broadcast: Moq.Broadcast.Consumer;
	track: string;
	config: DecoderConfig;
	stats: Signal<Stats | undefined>;
	spread: Container.Jitter;
	jitter: Time.Milli | undefined;

	timestamp = new Signal<Time.Milli | undefined>(undefined);
	frame = new Signal<VideoFrame | undefined>(undefined);

	// Network jitter + decode buffer.
	buffered = new Signal<Container.BufferedRanges>([]);

	// Groups this track lost to the age budget or a transport that gave up.
	skipped = new Signal<number>(0);

	/**
	 * Why this track stopped producing frames for good, once it has.
	 *
	 * A codec error ends the decode loop and the subscription with it, which no amount of waiting
	 * undoes. The parent {@link Decoder} watches this and builds a replacement.
	 */
	readonly failed = new Signal<Error | undefined>(undefined);

	// Decoded frames waiting to be rendered.
	#buffered = new Signal<Container.BufferedRanges>([]);

	// The last discontinuity count seen from the container consumer; doubles as a generation
	// so in-flight decodes from before a rewind can be dropped on output.
	#discontinuity = 0;

	#signals = new Effect();

	constructor(props: DecoderTrackProps) {
		this.sync = props.sync;
		this.broadcast = props.broadcast;
		this.track = props.track;
		this.config = props.config;
		this.stats = props.stats;
		this.spread = props.spread;
		this.jitter = renditionJitter(props.config);

		this.#signals.run(this.#run.bind(this));
	}

	#run(effect: Effect): void {
		const sub = subscribeMedia(effect, {
			broadcast: this.broadcast,
			track: this.track,
			priority: Catalog.PRIORITY.video,
			maxAge: this.sync.out.maxAge,
		});
		if (!sub) return;

		const decoder = new VideoDecoder({
			output: async (frame: VideoFrame) => {
				try {
					// The generation this frame was decoded in. If a rewind bumps it while we wait
					// below, this frame belongs to the reneged timeline and must be dropped.
					const generation = this.#discontinuity;

					const timestamp = Time.Milli.fromMicro(frame.timestamp as Time.Micro);
					if (timestamp < (this.timestamp.peek() ?? 0)) {
						// Late frame, don't render it.
						return;
					}

					// `received()` runs at submit, so a frame is anchored by the time it decodes.
					// Reaching here unanchored means a rewind reset the clock after this frame's
					// received(), so it predates the current timeline. Drop it: painting it would
					// set `timestamp` from the old timeline and late-reject the whole rewind.
					if (this.sync.out.reference.peek() === undefined) return;

					if (this.frame.peek() === undefined) {
						// Render something while we wait for the sync to catch up.
						this.frame.set(frame.clone());
					}

					// Returns immediately when the latency is "instant".
					const wait = this.sync.wait(timestamp).then(() => true);
					const ok = await Promise.race([wait, effect.cancel]);
					if (!ok) return;
					if (generation !== this.#discontinuity) return; // a rewind happened while waiting

					if (timestamp < (this.timestamp.peek() ?? 0)) {
						// Late frame, don't render it.
						// NOTE: This can happen when the ref is updated, such as on playback start.
						return;
					}

					this.timestamp.set(timestamp);

					// Trim the decode buffer as frames are rendered
					this.#trimBuffered(timestamp);

					this.frame.update((prev) => {
						prev?.close();
						return frame.clone(); // avoid closing the frame here
					});
				} finally {
					frame.close();
				}
			},
			error: (error) => {
				// Record it before tearing down: closing the effect ends the decode loop and the
				// subscription, so the parent's rebuild is the only way this track comes back.
				this.failed.set(error);
				effect.close();
			},
		});
		effect.cleanup(() => {
			if (decoder.state !== "closed") decoder.close();
		});

		// Input processing - depends on container type
		if (this.config.container.kind === "cmaf") {
			this.#runCmaf(effect, sub, decoder);
		} else {
			this.#runLegacy(effect, sub, decoder);
		}
	}

	#runLegacy(effect: Effect, sub: Moq.Track.Subscriber, decoder: VideoDecoder): void {
		const format =
			this.config.container.kind === "loc"
				? new Container.Loc.Format("video")
				: new Container.Legacy.Format(this.config);
		// Create consumer that reorders groups/frames up to the provided latency.
		const consumer = new Container.Consumer(sub, {
			format,
			maxAge: this.sync.out.maxAge,
			// The estimator for this rendition, which outlives any one subscription. See #runSpread.
			jitter: this.spread,
		});
		effect.cleanup(() => consumer.close());

		// Combine network jitter buffer with decode buffer
		effect.run((inner) => {
			const network = inner.get(consumer.buffered);
			const decode = inner.get(this.#buffered);
			this.buffered.update(() => Container.mergeBufferedRanges(network, decode));
		});

		accumulate(effect, this.skipped, consumer.skipped);

		decoder.configure({
			codec: this.config.codec,
			description: this.config.description ? Util.Hex.toBytes(this.config.description) : undefined,
			displayAspectWidth: this.config.displayAspectWidth,
			displayAspectHeight: this.config.displayAspectHeight,
			optimizeForLatency: this.config.optimizeForLatency,
			// @ts-expect-error Only supported by Chrome, so the renderer has to flip manually.
			flip: false,
		});

		let previous: Time.Micro | undefined;
		// Nothing has been decoded yet, so the first thing fed to the codec has to be a keyframe.
		let keyframeNeeded = true;

		effect.spawn(async () => {
			for (;;) {
				const next = await nextMedia(consumer);
				if (!next) break;

				// Publisher rewound: flush queued/in-flight video and re-anchor before decoding.
				if (this.#onDiscontinuity(next.discontinuity)) {
					previous = undefined;
					keyframeNeeded = true;
				}

				const { frame } = next;
				if (!frame) continue; // The group is done

				if (!next.continuous) keyframeNeeded = true;
				if (keyframeNeeded) {
					// A hole in delivery (the age budget skipped a group, the transport gave up on
					// one) leaves the frames after it referring to pictures that were never decoded.
					// A delta fed across that hole is garbage at best, and at worst a decoder error
					// that ends this track's decode loop and its subscription for good. Wait for the
					// keyframe that makes the stream decodable again.
					if (!frame.keyframe) {
						previous = undefined;
						continue;
					}
					keyframeNeeded = false;
				}

				// Mark that we received this frame right now.
				const timestamp = Time.Milli.fromMicro(frame.timestamp as Time.Micro);
				this.sync.received(timestamp, "video");

				const chunk = new EncodedVideoChunk({
					type: frame.keyframe ? "key" : "delta",
					data: frame.payload,
					timestamp: frame.timestamp,
				});

				// Track both frame count and bytes received for stats in the UI
				this.stats.update((current) => ({
					frameCount: (current?.frameCount ?? 0) + 1,
					bytesReceived: (current?.bytesReceived ?? 0) + frame.payload.byteLength,
				}));

				// Track decode buffer: frames sent to decoder but not yet rendered. Only bridge from
				// the previous frame when the consumer says nothing is missing in between. Group ids
				// can't answer that: they aren't required to be sequential (some encoders derive them
				// from DTS), so adjacency neither proves continuity nor rules out a gap the consumer
				// skipped, and reporting a skipped span as decoded overstates the buffer.
				if (previous !== undefined && next.continuous) {
					this.#addBuffered(Time.Milli.fromMicro(previous), Time.Milli.fromMicro(frame.timestamp));
				}

				previous = frame.timestamp;

				decoder.decode(chunk);
			}
		});
	}

	#runCmaf(effect: Effect, sub: Moq.Track.Subscriber, decoder: VideoDecoder): void {
		const container = this.config.container;
		if (container.kind !== "cmaf") return;

		const initSegment = base64ToBytes(container.init);
		const init = Container.Cmaf.decodeInitSegment(initSegment);
		const description = this.config.description ? Util.Hex.toBytes(this.config.description) : init.description;

		const consumer = new Container.Consumer(sub, {
			format: new Container.Cmaf.Format(init),
			maxAge: this.sync.out.maxAge,
			// The estimator for this rendition, which outlives any one subscription. See #runSpread.
			jitter: this.spread,
		});
		effect.cleanup(() => consumer.close());

		// Combine network jitter buffer with decode buffer
		effect.run((inner) => {
			const network = inner.get(consumer.buffered);
			const decode = inner.get(this.#buffered);
			this.buffered.update(() => Container.mergeBufferedRanges(network, decode));
		});

		accumulate(effect, this.skipped, consumer.skipped);

		// Configure decoder with description from catalog
		decoder.configure({
			codec: this.config.codec,
			description,
			displayAspectWidth: this.config.displayAspectWidth,
			displayAspectHeight: this.config.displayAspectHeight,
			optimizeForLatency: this.config.optimizeForLatency,
			// @ts-expect-error Only supported by Chrome, so the renderer has to flip manually.
			flip: false,
		});

		let previous: Time.Micro | undefined;
		// See `#runLegacy`: nothing has been decoded yet, so the codec needs a keyframe first.
		let keyframeNeeded = true;

		effect.spawn(async () => {
			for (;;) {
				const next = await nextMedia(consumer);
				if (!next) break;

				// Publisher rewound: flush queued/in-flight video and re-anchor before decoding.
				if (this.#onDiscontinuity(next.discontinuity)) {
					previous = undefined;
					keyframeNeeded = true;
				}

				const { frame } = next;
				if (!frame) continue;

				// A hole in delivery makes every following delta undecodable. See `#runLegacy`.
				if (!next.continuous) keyframeNeeded = true;
				if (keyframeNeeded) {
					if (!frame.keyframe) {
						previous = undefined;
						continue;
					}
					keyframeNeeded = false;
				}

				// Mark that we received this frame right now.
				const timestamp = Time.Milli.fromMicro(frame.timestamp);
				this.sync.received(timestamp, "video");

				// Track stats
				this.stats.update((current) => ({
					frameCount: (current?.frameCount ?? 0) + 1,
					bytesReceived: (current?.bytesReceived ?? 0) + frame.payload.byteLength,
				}));

				// Track decode buffer (see #runLegacy: bridge on the consumer's continuity signal,
				// never on group adjacency, which proves nothing about the timeline).
				if (previous !== undefined && next.continuous) {
					this.#addBuffered(Time.Milli.fromMicro(previous), Time.Milli.fromMicro(frame.timestamp));
				}

				previous = frame.timestamp;

				if (decoder.state === "closed") break;
				decoder.decode(
					new EncodedVideoChunk({
						type: frame.keyframe ? "key" : "delta",
						data: frame.payload,
						timestamp: frame.timestamp,
					}),
				);
			}
		});
	}

	// React to the container consumer's discontinuity counter. On a change the publisher has
	// rewound the timeline, so drop what's queued downstream and re-anchor the shared clock
	// before the new utterance. Clearing `timestamp` is load-bearing: otherwise its stale high
	// value would late-reject the rewound (lower-timestamp) frames at the output guard. Bumping
	// the generation drops in-flight decodes on output. The held frame is left in place so the
	// last picture shows until the new keyframe renders, instead of flashing empty. Returns true
	// if a rewind was handled.
	#onDiscontinuity(count: number): boolean {
		if (count === this.#discontinuity) return false;
		this.#discontinuity = count;
		this.timestamp.set(undefined);
		this.#buffered.set([]);
		this.sync.reset();
		return true;
	}

	// Add a range to the decode buffer (decoded, waiting to render)
	#addBuffered(start: Time.Milli, end: Time.Milli): void {
		if (start > end) return;

		this.#buffered.mutate((current) => {
			for (const range of current) {
				// Check if there's any overlap, then merge
				if (range.start <= end && range.end >= start) {
					range.start = Time.Milli.min(range.start, start);
					range.end = Time.Milli.max(range.end, end);
					return;
				}
			}

			current.push({ start, end });
			current.sort((a, b) => a.start - b.start);
		});
	}

	// Trim the decode buffer up to the rendered timestamp
	#trimBuffered(timestamp: Time.Milli): void {
		this.#buffered.mutate((current) => {
			while (current.length > 0) {
				if (current[0].end >= timestamp) {
					current[0].start = Time.Milli.max(current[0].start, timestamp);
					break;
				}
				current.shift();
			}
		});
	}

	close(): void {
		this.#signals.close();

		this.frame.update((prev) => {
			prev?.close();
			return undefined;
		});
	}
}

async function supported(config: Catalog.VideoConfig): Promise<boolean> {
	if (!Catalog.containerSupported(config.container)) {
		// `kind` is the literal "unknown" tag; the container the publisher actually named is in `raw`.
		const kind = config.container.kind === "unknown" ? config.container.raw.kind : config.container.kind;
		console.warn(`video: ignoring rendition with unknown container: ${kind}`);
		return false;
	}

	let description: Uint8Array | undefined;
	if (config.description) {
		description = Util.Hex.toBytes(config.description);
	} else if (config.container.kind === "cmaf") {
		try {
			description = Container.Cmaf.decodeInitSegment(base64ToBytes(config.container.init)).description;
		} catch (err) {
			// A malformed init segment means we can't extract the codec
			// description, so we can't probe support reliably. Reject the
			// track rather than letting isConfigSupported pass on a
			// description-less config and then having runCmaf fail later.
			console.warn(`video: malformed CMAF init segment for codec ${config.codec}`, err);
			return false;
		}
	}
	const { supported } = await VideoDecoder.isConfigSupported({
		codec: config.codec,
		description,
		displayAspectWidth: config.displayAspectWidth,
		displayAspectHeight: config.displayAspectHeight,
		optimizeForLatency: config.optimizeForLatency ?? true,
	});

	if (supported) return true;

	// Safari rejects `avc3.*` codec strings even though its H.264 decoder handles
	// inline SPS/PPS. Rewrite to `avc1.*` and retry; mutate config.codec so the
	// later `decoder.configure()` call uses the accepted string too.
	if (config.codec.startsWith("avc3.")) {
		const avc1 = `avc1.${config.codec.slice("avc3.".length)}`;
		const retry = await VideoDecoder.isConfigSupported({
			codec: avc1,
			description,
			displayAspectWidth: config.displayAspectWidth,
			displayAspectHeight: config.displayAspectHeight,
			optimizeForLatency: config.optimizeForLatency ?? true,
		});
		if (retry.supported) {
			config.codec = avc1;
			return true;
		}
	}

	return false;
}

Object.assign(supported, { [supportCacheKey]: decoderConfigKey });

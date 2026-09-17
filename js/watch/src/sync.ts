import * as Container from "@moq/hang/container";
import { Time } from "@moq/net";
import { Effect, type Getter, getter, type Inputs, type Readonlys, readonlys, Signal } from "@moq/signals";

/**
 * How far playback trails the live edge.
 *
 * `"auto"` (the default) sizes the jitter buffer from how late frames actually arrive; a
 * `Time.Milli` is the whole delay, with nothing added to it for what the publisher advertises.
 *
 * `"instant"` drops the buffer and the pacing together: nothing is held, and {@link Sync.wait}
 * returns without sleeping, so a frame presents as soon as it exists. It also overrides
 * {@link SyncInput.buffer}, since holding a lookahead would contradict holding nothing. Audio is
 * the owner's business: a ring with no depth underruns, so whoever wants this mode is expected to
 * turn audio off.
 */
export type Delay = "instant" | "auto" | Time.Milli;

// The widest measured jitter "auto" sizes a buffer from, which is the estimator's own ceiling.
const JITTER_CEILING = Time.Milli(Container.Jitter.CEILING);

// How long one track's arrival floor stands before it stops counting.
//
// Two of these are kept and rotated, so a track that stops delivering (a muted tile, a hidden
// canvas) drops out of the comparison within two windows rather than holding the buffer deep for
// the rest of the session. Wide enough that an ordinary group cadence refreshes it many times over.
const OFFSET_WINDOW = Time.Milli(2_000);

/**
 * One track's arrival floor, as two rotating windows.
 *
 * A minimum rather than a mean, for the same reason the estimator measures each arrival against
 * the fastest recent one: the floor is the path, and everything above it is jitter the estimator
 * already covers.
 */
type Arrival = {
	/** The floor seen since the window opened. */
	current: number;
	/** The previous window's floor, so the reading spans at least one full window. */
	previous: number;
	/** When the current window opened. */
	opened: Time.Milli;
};

/**
 * A sample of a track's playhead: where it is on the media timeline, and when it was there.
 *
 * The track that publishes one drives playback for every other track. See {@link Sync.track}.
 */
export type Clock = {
	/** The media position the playhead held at {@link Clock.reference}. */
	timestamp: Time.Micro;

	/** The monotonic time (`Time.Milli.now()`) at which the playhead held {@link Clock.timestamp}. */
	reference: Time.Milli;

	/**
	 * Media time per unit of wall time: 1 while playing, 0 while the playhead is parked.
	 *
	 * {@link Sync} extrapolates with it between samples, so a parked playhead parks playback rather
	 * than letting the other tracks run away from it.
	 */
	rate: number;
};

/** Where `clock` puts the playhead at `now`, extrapolated at its own rate. */
function extrapolate(clock: Clock, now: Time.Milli): Time.Milli {
	const elapsed = Time.Milli.sub(now, clock.reference);
	return Time.Milli.add(Time.Milli.fromMicro(clock.timestamp), Time.Milli(elapsed * clock.rate));
}

/**
 * One of the tracks {@link Sync} keeps in step.
 *
 * See {@link Sync.track}.
 */
export class SyncTrack {
	/** Which track this is. */
	readonly name: "audio" | "video" | "text";

	/**
	 * How late this track's frames arrive relative to the earliest one, from the container consumer.
	 *
	 * This is what `"auto"` sizes the jitter buffer from: it measures what the publisher and the
	 * network actually deliver, which the round trip does not describe. The rendition's advertised
	 * flush span is where that measurement starts, applied by the container consumer, so it needs no
	 * second term here.
	 */
	readonly spread = new Signal<Time.Milli | undefined>(undefined);

	constructor(name: "audio" | "video" | "text") {
		this.name = name;
	}
}

/**
 * A track that renders on a playhead of its own, so it can drive the clock.
 *
 * Set {@link SyncClockTrack.clock} while that playhead is moving and every other track is paced
 * against it; clear it when the track stops rendering. Captions are not one of these: they render
 * on {@link Sync.now}, so nominating one would leave the clock chasing itself.
 */
export class SyncClockTrack extends SyncTrack {
	/**
	 * This track's playhead, or `undefined` while it is not rendering.
	 *
	 * Republish it as the playhead moves; {@link Sync} extrapolates between samples, so a slow
	 * cadence costs accuracy rather than motion.
	 */
	readonly clock = new Signal<Clock | undefined>(undefined);
}

export type SyncInput = {
	/** How far playback trails the live edge. See {@link Delay}. */
	delay: Getter<Delay>;

	/**
	 * Future-dated media held beyond the live edge before playback skips ahead (default: zero).
	 *
	 * Zero minimizes latency, the live default: playback re-anchors as soon as anything arrives
	 * early. A larger value lets faster-than-real-time frames (a TTS response with future
	 * timestamps) build up instead of being skipped. Always finite, so worst case the audio ring
	 * drops its oldest samples rather than exhausting memory.
	 */
	buffer: Getter<Time.Milli>;
};

type SyncOutput = {
	// The earliest time we've received a frame, relative to its timestamp: the wall-clock anchor
	// playback runs on. While a track drives the clock this is re-derived from its playhead instead,
	// so dropping the clock leaves playback exactly where the playhead left it.
	reference: Signal<Time.Milli | undefined>;

	// Which track's playhead the reference follows, or undefined while it follows the wall clock.
	clock: Signal<"audio" | "video" | undefined>;

	// The resolved delay from the live edge to the playhead. See `#runDelay` for how the terms combine.
	delay: Signal<Time.Milli>;

	// The jitter component of `delay` (always numeric).
	// In "auto" mode this follows the measured arrival spread, the largest across tracks.
	// When the delay is a number, jitter equals that number.
	jitter: Signal<Time.Milli>;

	// How much later the picture arrives than the sound, for the same media timestamp. Zero when
	// they arrive together, which is the ordinary case. See `#observeArrival`.
	offset: Signal<Time.Milli>;

	// The media timestamp of the most recently received frame.
	timestamp: Signal<Time.Milli | undefined>;

	// Derived: true when a lookahead is configured. Buffered playback lets the reference stay
	// anchored so future-dated frames build up, re-anchoring (skipping ahead) only once they
	// would sit further than `maxAge` ahead of the playhead. See `reset()`.
	buffered: Signal<boolean>;

	// Derived: `delay + buffer`, the furthest a held frame may sit ahead of the playhead. Feeds the
	// transport subscription and the container consumer, which bound the same span. Always finite.
	maxAge: Signal<Time.Milli>;
};

export class Sync {
	readonly in: Readonlys<SyncInput>;

	readonly #tracks = {
		audio: new SyncClockTrack("audio"),
		video: new SyncClockTrack("video"),
		text: new SyncTrack("text"),
	};

	readonly #out: SyncOutput = {
		reference: new Signal<Time.Milli | undefined>(undefined),
		clock: new Signal<"audio" | "video" | undefined>(undefined),
		delay: new Signal<Time.Milli>(Time.Milli.zero),
		jitter: new Signal<Time.Milli>(Time.Milli.zero),
		offset: new Signal<Time.Milli>(Time.Milli.zero),
		timestamp: new Signal<Time.Milli | undefined>(undefined),
		buffered: new Signal<boolean>(false),
		maxAge: new Signal<Time.Milli>(Time.Milli.zero),
	};
	readonly out = readonlys(this.#out);

	// The playhead sample playback is extrapolated from, or undefined while it runs on the wall
	// clock. Read on every `now()`/`wait()`, which is why it is a plain field: video paces against
	// main-thread memory rather than reaching across to the worklet per frame.
	#clock: Clock | undefined;

	// A ghetto way to learn when the reference/buffer changes.
	// There's probably a way to use Effect, but lets keep it simple for now.
	#update: PromiseWithResolvers<void>;

	// Per-label late-frame tracking: accumulate count and max lateness, flush on recovery.
	#late = new Map<string, { count: number; maxMs: number }>();

	// Per-track arrival floors, for the cross-track offset. Only the tracks that render on the
	// shared clock: captions render on `now()`, so holding sound for a late one would be wrong.
	#arrivals = new Map<"audio" | "video", Arrival>();

	#signals = new Effect();

	constructor(props?: Inputs<SyncInput>) {
		this.in = {
			delay: getter(props?.delay ?? ("auto" as Delay)),
			buffer: getter(props?.buffer ?? Time.Milli.zero),
		};

		this.#update = Promise.withResolvers();

		this.#signals.run(this.#runJitter.bind(this));
		this.#signals.run(this.#runDelay.bind(this));
		this.#signals.run(this.#runMaxAge.bind(this));
		this.#signals.run(this.#runClock.bind(this));
	}

	/**
	 * The handle for one of the tracks being kept in step.
	 *
	 * Stable for the life of the `Sync`: the decoders wire their measured spread into it, and the
	 * ones that render on a playhead nominate themselves as the clock.
	 */
	track(name: "audio" | "video"): SyncClockTrack;
	track(name: "text"): SyncTrack;
	track(name: "audio" | "video" | "text"): SyncTrack {
		return this.#tracks[name];
	}

	// Derive `buffered` / `maxAge` from how far playback trails and the configured lookahead.
	//
	// The offset is in here because the budget has to reach as far back as playback waits: a
	// picture the deeper hold is still waiting for would otherwise be convicted as stale before
	// it was ever due.
	#runMaxAge(effect: Effect): void {
		const trail = Time.Milli.add(effect.get(this.#out.delay), effect.get(this.#out.offset));
		// "instant" holds nothing, so a configured lookahead doesn't apply.
		const buffer = effect.get(this.in.delay) === "instant" ? Time.Milli.zero : effect.get(this.in.buffer);

		this.#out.buffered.set(buffer > 0);
		this.#out.maxAge.set(Time.Milli.add(trail, buffer));
	}

	/**
	 * How far behind the live edge playback runs: the estimator's answer plus the cross-track offset.
	 *
	 * `out.delay` stays the estimator's answer alone, which is what the player's jitter buffer row
	 * reports and what the conformance corpus holds both languages to. This is what the clock, the
	 * age budget and the audio ring are actually sized from.
	 */
	#trail(): Time.Milli {
		return Time.Milli.add(this.#out.delay.peek(), this.#out.offset.peek());
	}

	// "auto" sizes the buffer from what arrives, not from the round trip. A retransmit costs an RTT,
	// but a publisher flushing a second of media at once costs a second, and a well-paced publisher
	// across the world costs nothing above its frame duration: the arrival spread measures both, so
	// it is the only term here.
	#runJitter(effect: Effect): void {
		const delay = effect.get(this.in.delay);

		if (delay === "instant") {
			// Holds nothing at all.
			this.#out.jitter.set(Time.Milli.zero);
			return;
		}

		if (typeof delay === "number") {
			// Fixed mode: the configured delay is the jitter.
			this.#out.jitter.set(delay);
			return;
		}

		let spread = Time.Milli.zero;
		for (const track of Object.values(this.#tracks)) {
			spread = Time.Milli.max(spread, effect.get(track.spread) ?? Time.Milli.zero);
		}

		// The estimator drops anything past its histogram's range rather than clamping it, so a
		// reading above the range is not a reading. Bound the buffer by it either way.
		this.#out.jitter.set(Time.Milli.min(JITTER_CEILING, spread));
	}

	// The delay is the jitter and nothing else. The publisher's advertised flush span is not a second
	// term: it is the same quantity the estimator measures, so it seeds the estimate (see
	// `Container.Consumer`'s `jitter` prop) rather than flooring or adding to the result. Carrying it
	// here too made a viewer asking for 100ms on a source declaring 300ms wait 400ms, and pinned a
	// LAN viewer at whatever the publisher's flush span happened to be however well it delivered.
	// "instant" holds nothing.
	#runDelay(effect: Effect): void {
		const mode = effect.get(this.in.delay);
		const jitter = effect.get(this.#out.jitter);
		// Read so a moved offset wakes everything parked in `wait()` too; it moves the playhead
		// exactly as the delay does.
		effect.get(this.#out.offset);

		this.#out.delay.set(mode === "instant" ? Time.Milli.zero : jitter);

		this.#wake();
	}

	/**
	 * Follow whichever track nominated itself, and re-derive the reference from its playhead.
	 *
	 * Audio wins over video: it is the track a listener notices a discontinuity in, and it is the
	 * one whose renderer consumes media on a clock of its own. The reference is kept up to date
	 * rather than only consulted, so dropping the clock (a mute, a track ending) leaves playback
	 * running at wall speed from exactly where the playhead was, with no jump for video.
	 */
	#runClock(effect: Effect): void {
		const audio = effect.get(this.#tracks.audio.clock);
		const video = effect.get(this.#tracks.video.clock);
		// The reference is expressed relative to how far playback trails, so a change re-derives it.
		effect.get(this.#out.delay);
		effect.get(this.#out.offset);
		const delay = this.#trail();

		let source: "audio" | "video" | undefined;
		if (audio) source = "audio";
		else if (video) source = "video";

		const clock = audio ?? video;
		const previous = this.#clock;
		this.#clock = clock;
		this.#out.clock.set(source);

		// Nothing nominated and nothing to hand over: the wall-clock anchor from `received` stands.
		const sample = clock ?? previous;
		if (!sample) return;

		const now = Time.Milli.now();
		this.#setReference(Time.Milli.sub(Time.Milli.sub(now, delay), extrapolate(sample, now)));
	}

	/**
	 * The media position that should be rendering at `now`, or undefined before anything anchored it.
	 *
	 * The nominated playhead when there is one, extrapolated locally so a per-frame `wait()` never
	 * crosses a thread, and the wall-clock anchor otherwise.
	 */
	#playhead(now: Time.Milli): Time.Milli | undefined {
		const clock = this.#clock;
		if (clock) return extrapolate(clock, now);

		const reference = this.#out.reference.peek();
		if (reference === undefined) return undefined;
		return Time.Milli.sub(Time.Milli.sub(now, reference), this.#trail());
	}

	/**
	 * Measure how much later one track arrives than the other for the same media timestamp.
	 *
	 * Sound and picture are meant to leave the device together. Each track's own spread is measured
	 * against that track's fastest recent arrival, so a track that is uniformly later than the other
	 * measures a spread of zero and nothing in the estimator can see it. This is that difference,
	 * and it covers both halves of it at once: the path (one track's frames simply take longer) and
	 * the publisher (an engine that stamps its video behind its audio, which is 22ms of the Firefox
	 * case on its own). Both show up as the same quantity here because both move the frame's arrival
	 * relative to its timestamp.
	 *
	 * Delaying the earlier track to match the later one is what WebRTC does in
	 * `modules/video_coding/stream_synchronization.cc`, and for the same reason: the picture cannot
	 * be pulled forward, so the sound has to wait.
	 *
	 * A whole bucket or nothing. Below the estimator's own resolution this is noise, and a term that
	 * flickered by a millisecond would re-park the audio ring for nothing.
	 */
	#observeArrival(name: "audio" | "video", timestamp: Time.Milli, now: Time.Milli): void {
		const floor = Time.Milli.sub(now, timestamp);

		const entry = this.#arrivals.get(name);
		if (!entry) {
			this.#arrivals.set(name, { current: floor, previous: Number.POSITIVE_INFINITY, opened: now });
		} else if (Time.Milli.sub(now, entry.opened) >= 2 * OFFSET_WINDOW) {
			// Gone for longer than the pair of windows: nothing it measured before describes the
			// path it is on now, so start over rather than walking empty windows.
			entry.current = floor;
			entry.previous = Number.POSITIVE_INFINITY;
			entry.opened = now;
		} else if (Time.Milli.sub(now, entry.opened) >= OFFSET_WINDOW) {
			entry.previous = entry.current;
			entry.current = floor;
			entry.opened = Time.Milli.add(entry.opened, OFFSET_WINDOW);
		} else {
			entry.current = Math.min(entry.current, floor);
		}

		const floors = new Map<"audio" | "video", number>();
		for (const [track, arrival] of this.#arrivals) {
			// A track that stopped delivering stops counting, so muting a tile or scrolling its
			// canvas away does not hold the other deep for the rest of the session.
			if (Time.Milli.sub(now, arrival.opened) >= 2 * OFFSET_WINDOW) {
				this.#arrivals.delete(track);
				continue;
			}
			const reading = Math.min(arrival.current, arrival.previous);
			if (Number.isFinite(reading)) floors.set(track, reading);
		}

		// Only video's excess over audio, never the other way round. Audio is the clock and video
		// is painted when the playhead reaches its timestamp, so a picture that arrives early is
		// already held for free and one that arrives late is the only thing needing a term. Sound
		// cannot be pulled forward either; the earlier track is the one that waits.
		const audio = floors.get("audio");
		const video = floors.get("video");
		if (audio === undefined || video === undefined) {
			this.#out.offset.set(Time.Milli.zero);
			return;
		}

		const behind = Math.max(0, video - audio);
		const bucket = Container.Jitter.BUCKET;
		const quantised = behind < bucket ? 0 : Math.ceil(behind / bucket) * bucket;
		this.#out.offset.set(Time.Milli(Math.min(JITTER_CEILING, quantised)));
	}

	// Fold a newly received frame into the reference. The reference anchors playback to the
	// wall clock; we lower it (skip ahead) only when keeping it would push the lookahead past `maxAge`.
	received(timestamp: Time.Milli, label = ""): void {
		this.#out.timestamp.update((current) => (current === undefined || timestamp > current ? timestamp : current));
		const now = Time.Milli.now();
		if (label === "audio" || label === "video") this.#observeArrival(label, timestamp, now);
		const playhead = this.#playhead(now);

		// First frame anchors the reference.
		if (playhead === undefined) {
			this.#setReference(Time.Milli.sub(now, timestamp));
			return;
		}

		// Check if `wait()` would not sleep at all.
		// NOTE: We check here instead of in `wait()` so we can identify when frames are received late.
		// Otherwise, chained `wait()` calls would cause a false-positive during CPU starvation.
		const sleep = Time.Milli.sub(timestamp, playhead);
		if (sleep < 0) {
			const entry = this.#late.get(label);
			if (entry) {
				entry.count++;
				entry.maxMs = Math.max(entry.maxMs, -sleep);
			} else {
				this.#late.set(label, { count: 1, maxMs: -sleep });
			}
		} else {
			const entry = this.#late.get(label);
			if (entry) {
				const prefix = label ? `sync[${label}]` : "sync";
				const behind = Sync.#formatDuration(entry.maxMs);
				console.debug(`${prefix}: ${entry.count} late frame(s), max ${behind} behind`);
				this.#late.delete(label);
			}
		}

		// A nominated playhead is the clock, so an arrival cannot move it: the buffer the frame
		// lands in decides when it plays, and that buffer is what the playhead reports.
		if (this.#clock) return;

		const ref = Time.Milli.sub(now, timestamp);
		const currentRef = this.#out.reference.peek();
		if (currentRef === undefined) return;

		// Frame isn't earlier than the anchor: it can't add lookahead, so keep the reference.
		if (ref >= currentRef) return;

		// Frame is earlier (more lookahead). `sleep` is how far ahead of the playhead keeping the
		// anchor would put it.
		const cap = this.#out.maxAge.peek();
		if (sleep <= cap) return; // within budget: let the buffer grow instead of skipping ahead

		// Over the cap: re-anchor down so the resulting lookahead is exactly the cap.
		this.#setReference(Time.Milli.add(ref, Time.Milli.sub(cap, this.#trail())));
	}

	#setReference(ref: Time.Milli): void {
		this.#out.reference.set(ref);
		this.#wake();
	}

	// Wake everything parked in `wait()` so it re-reads the clock.
	#wake(): void {
		this.#update.resolve();
		this.#update = Promise.withResolvers();
	}

	// Re-anchor playback to the next frame received. Call this at an utterance boundary
	// in buffered mode (typically alongside flushing the audio buffer) so the new content
	// plays from its own first frame instead of inheriting the previous reference.
	//
	// A nominated track re-anchors the clock on its next sample, which is how the flushed ring
	// reports where the new utterance starts.
	reset(): void {
		this.#out.reference.set(undefined);
		this.#out.clock.set(undefined);
		this.#clock = undefined;
		this.#late.clear();
		// A rewind moves the media axis, so every arrival floor describes a timeline that no longer
		// exists. The estimator drops its own reference on a discontinuity for the same reason.
		this.#arrivals.clear();
		this.#out.offset.set(Time.Milli.zero);
		this.#wake();
	}

	// The PTS that should be rendering right now, derived from the clock or the reference.
	// Returns undefined if no frames have been received yet.
	now(): Time.Milli | undefined {
		return this.#playhead(Time.Milli.now());
	}

	// Sleep until it's time to render this frame.
	async wait(timestamp: Time.Milli): Promise<void> {
		// A zero delay still sleeps: the sleep comes from the reference, which holds an early frame
		// until its timestamp comes up. "instant" is the only thing that skips the wait itself.
		if (this.in.delay.peek() === "instant") return;

		if (this.#playhead(Time.Milli.now()) === undefined) {
			throw new Error("reference not set; call received() first");
		}

		for (;;) {
			// Switching to "instant" resolves `#update`, so frames parked here wake and leave.
			if (this.in.delay.peek() === "instant") return;

			// Sleep until it's time to decode the next frame.
			// NOTE: This function runs in parallel for each frame.
			const playhead = this.#playhead(Time.Milli.now());
			if (playhead === undefined) return;

			const sleep = Time.Milli.sub(timestamp, playhead);
			if (sleep <= 0) return;

			// Skip setTimeout for small sleeps; the timer resolution (~4ms) would overshoot.
			if (sleep < 5) return;

			const wait = new Promise((resolve) => setTimeout(resolve, sleep)).then(() => true);

			const ok = await Promise.race([this.#update.promise, wait]);
			if (ok) return;
		}
	}

	static #formatDuration(ms: number): string {
		ms = Math.round(ms);
		if (ms < 1000) return `${ms}ms`;
		const s = ms / 1000;
		if (s < 60) return `${Math.round(s * 10) / 10}s`;
		const m = s / 60;
		return `${Math.round(m * 10) / 10}m`;
	}

	close() {
		this.#signals.close();
	}
}

import * as Container from "@moq/hang/container";
import { Time } from "@moq/net";
import { Effect, type Getter, getter, type Inputs, type Readonlys, readonlys, Signal } from "@moq/signals";

/**
 * How far playback trails the live edge.
 *
 * `"auto"` (the default) sizes the jitter buffer from how late frames actually arrive; a
 * `Time.Milli` fixes it.
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
 * Both inputs describe the same buffer from different sides: `advertised` is what the publisher
 * declares it flushes, `spread` is what the receiver measured arriving. See {@link Sync.track}.
 */
export class SyncTrack {
	/** Which track this is. */
	readonly name: "audio" | "video" | "text";

	/** The delay the selected rendition advertises, wired from the per-rendition source. */
	readonly advertised = new Signal<Time.Milli | undefined>(undefined);

	/**
	 * How late this track's frames arrive relative to the earliest one, from the container consumer.
	 *
	 * This is what `"auto"` sizes the jitter buffer from: it measures what the publisher and the
	 * network actually deliver, which the round trip does not describe.
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
	 * Stable for the life of the `Sync`: the decoders wire their advertised delay and measured
	 * spread into it, and the ones that render on a playhead nominate themselves as the clock.
	 */
	track(name: "audio" | "video"): SyncClockTrack;
	track(name: "text"): SyncTrack;
	track(name: "audio" | "video" | "text"): SyncTrack {
		return this.#tracks[name];
	}

	// Derive `buffered` / `maxAge` from the resolved delay and the configured lookahead.
	#runMaxAge(effect: Effect): void {
		const delay = effect.get(this.#out.delay);
		// "instant" holds nothing, so a configured lookahead doesn't apply.
		const buffer = effect.get(this.in.delay) === "instant" ? Time.Milli.zero : effect.get(this.in.buffer);

		this.#out.buffered.set(buffer > 0);
		this.#out.maxAge.set(Time.Milli.add(delay, buffer));
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

	// The advertised delay is a publisher-declared floor and the measured jitter is a measurement of
	// the network, so "auto" is the larger of the two rather than their sum: the receiver measures
	// the publisher's flush span itself, so adding them would double the buffer for exactly the
	// publishers that need it most. A fixed delay is what the viewer asked for on top of the floor,
	// so there the two do add. "instant" holds nothing.
	#runDelay(effect: Effect): void {
		const mode = effect.get(this.in.delay);
		const jitter = effect.get(this.#out.jitter);

		let advertised = Time.Milli.zero;
		for (const track of Object.values(this.#tracks)) {
			advertised = Time.Milli.max(advertised, effect.get(track.advertised) ?? Time.Milli.zero);
		}

		let delay: Time.Milli;
		if (mode === "instant") delay = Time.Milli.zero;
		else if (typeof mode === "number") delay = Time.Milli.add(advertised, jitter);
		else delay = Time.Milli.max(advertised, jitter);
		this.#out.delay.set(delay);

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
		// The reference is expressed relative to the delay, so a changed delay re-derives it.
		const delay = effect.get(this.#out.delay);

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
		return Time.Milli.sub(Time.Milli.sub(now, reference), this.#out.delay.peek());
	}

	// Fold a newly received frame into the reference. The reference anchors playback to the
	// wall clock; we lower it (skip ahead) only when keeping it would push the lookahead past `maxAge`.
	received(timestamp: Time.Milli, label = ""): void {
		this.#out.timestamp.update((current) => (current === undefined || timestamp > current ? timestamp : current));
		const now = Time.Milli.now();
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
		this.#setReference(Time.Milli.add(ref, Time.Milli.sub(cap, this.#out.delay.peek())));
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

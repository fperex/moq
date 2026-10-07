import type * as Moq from "@moq/net";
import { Time } from "@moq/net";
import {
	type Dispose,
	Effect,
	type Getter,
	getter,
	type Inputs,
	type Readonlys,
	readonlys,
	Signal,
} from "@moq/signals";

/**
 * How far playback trails the live edge.
 *
 * `"auto"` (the default) holds the largest playout target the registered decoders measure from how
 * late their frames arrive (see doc/concept/audio-jitter.md). A `Time.Milli` fixes the delay at
 * exactly that number and disables adaptation.
 *
 * `"instant"` drops the buffer and the pacing together: nothing is held, and {@link Sync.wait}
 * returns without sleeping, so a frame presents as soon as it exists. It also overrides
 * {@link SyncInput.buffer}, since holding a lookahead would contradict holding nothing. Audio is
 * off: a ring with no depth underruns, so the audio decoder unsubscribes and flushes its ring.
 */
export type Delay = "instant" | "auto" | Time.Milli;

// Submillisecond clock noise does not move waiting frames' display deadlines.
const REFERENCE_SLACK = Time.Milli(1);

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
 * A track that renders on a playhead of its own, so it can drive the clock.
 *
 * Set {@link SyncClockTrack.clock} while that playhead is moving and every other track is paced
 * against it; clear it when the track stops rendering. See {@link Sync.track}.
 */
export class SyncClockTrack {
	/** Which track this is. */
	readonly name: "audio" | "video";

	/**
	 * This track's playhead, or `undefined` while it is not rendering.
	 *
	 * Republish it as the playhead moves; {@link Sync} extrapolates between samples, so a slow
	 * cadence costs accuracy rather than motion.
	 */
	readonly clock = new Signal<Clock | undefined>(undefined);

	constructor(name: "audio" | "video") {
		this.name = name;
	}
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

	/** @internal */
	probe: Getter<Moq.Connection.Probe | undefined>;
};

type SyncOutput = {
	// Derived: whether the delay is "instant". Numeric and "auto" delays share `false`, so readers
	// that only care about the mode don't rerun when the number changes.
	instant: Signal<boolean>;

	// The earliest time we've received a frame, relative to its timestamp: the wall-clock anchor
	// playback runs on. This will keep being updated as we catch up to the live playhead then will be
	// relatively static. While a track drives the clock it is re-derived from that playhead instead,
	// so dropping the clock leaves playback exactly where the playhead left it.
	reference: Signal<Time.Milli | undefined>;

	// Which track's playhead the reference follows, or undefined while it follows the wall clock.
	clock: Signal<"audio" | "video" | undefined>;

	// The resolved delay from the live edge to the playhead: the configured number, or in "auto" the
	// largest registered playout target. Zero for "instant".
	delay: Signal<Time.Milli>;

	// The jitter buffer, always equal to `delay`.
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

	readonly #out: SyncOutput = {
		instant: new Signal<boolean>(false),
		reference: new Signal<Time.Milli | undefined>(undefined),
		clock: new Signal<"audio" | "video" | undefined>(undefined),
		delay: new Signal<Time.Milli>(Time.Milli.zero),
		jitter: new Signal<Time.Milli>(Time.Milli.zero),
		timestamp: new Signal<Time.Milli | undefined>(undefined),
		buffered: new Signal<boolean>(false),
		maxAge: new Signal<Time.Milli>(Time.Milli.zero),
	};
	readonly out = readonlys(this.#out);

	readonly #tracks = {
		audio: new SyncClockTrack("audio"),
		video: new SyncClockTrack("video"),
	};

	// The playhead sample playback is extrapolated from, or undefined while it runs on the wall
	// clock. Read on every `now()`/`wait()`, which is why it is a plain field: video paces against
	// main-thread memory rather than reaching across to the worklet per frame.
	#clock: Clock | undefined;

	// The delay the published reference was derived with, so a new delay always republishes it.
	#referenceDelay: Time.Milli | undefined;

	// Per-label late-frame tracking: accumulate count and max lateness, flush on recovery.
	#late = new Map<string, { count: number; maxMs: number }>();

	#media = new Signal<{ target: Getter<Time.Milli | undefined> }[]>([]);

	#signals = new Effect();

	constructor(props?: Inputs<SyncInput>) {
		this.in = {
			delay: getter(props?.delay ?? ("auto" as Delay)),
			buffer: getter(props?.buffer ?? Time.Milli.zero),
			probe: getter(props?.probe),
		};

		this.#signals.run(this.#runInstant.bind(this));
		this.#signals.run(this.#runDelay.bind(this));
		this.#signals.run(this.#runMaxAge.bind(this));
		this.#signals.run(this.#runClock.bind(this));
	}

	/**
	 * The handle for one of the tracks that can drive the clock.
	 *
	 * Stable for the life of the `Sync`. A track that renders on a playhead of its own (the audio
	 * ring's reader, whose consumption of media follows the sound card rather than the wall clock)
	 * nominates itself, and everything else is paced against it. Captions are not one of these: they
	 * render on {@link Sync.now}, so nominating one would leave the clock chasing itself.
	 */
	track(name: "audio" | "video"): SyncClockTrack {
		return this.#tracks[name];
	}

	/** Hold a decoder's "auto" playout target in the shared playback clock until disposed. */
	register(target: Getter<Time.Milli | undefined>): Dispose {
		const registered = { target };
		this.#media.update((media) => [...media, registered]);
		return () => this.#media.update((media) => media.filter((candidate) => candidate !== registered));
	}

	#runInstant(effect: Effect): void {
		this.#out.instant.set(effect.get(this.in.delay) === "instant");
	}

	// Derive `buffered` / `maxAge` from the resolved delay and the configured lookahead.
	#runMaxAge(effect: Effect): void {
		const delay = effect.get(this.#out.delay);
		// "instant" holds nothing, so a configured lookahead doesn't apply.
		const buffer = effect.get(this.#out.instant) ? Time.Milli.zero : effect.get(this.in.buffer);

		this.#out.buffered.set(buffer > 0);
		this.#out.maxAge.set(Time.Milli.add(delay, buffer));
	}

	// A fixed delay is taken literally and "auto" holds the deepest track's target, so every track
	// plays from one clock. See doc/concept/audio-jitter.md for how a target is measured.
	#runDelay(effect: Effect): void {
		const mode = effect.get(this.in.delay);

		let delay = Time.Milli.zero;
		if (typeof mode === "number") {
			delay = mode;
		} else if (mode === "auto") {
			for (const registered of effect.get(this.#media)) {
				delay = Time.Milli.max(delay, effect.get(registered.target) ?? Time.Milli.zero);
			}
		}

		this.#out.jitter.set(delay);
		this.#out.delay.set(delay);
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
		const delay = effect.get(this.#out.delay);

		const source = audio ? "audio" : video ? "video" : undefined;
		const clock = audio ?? video;
		const previous = this.#clock;
		const was = this.#out.clock.peek();
		this.#clock = clock;
		this.#out.clock.set(source);

		// Nothing nominated and nothing to hand over: the wall-clock anchor from `received` stands.
		const sample = clock ?? previous;
		if (!sample) return;

		const now = Time.Milli.now();
		const reference = Time.Milli.sub(Time.Milli.sub(now, delay), extrapolate(sample, now));
		// A new sample from the same clock, at the same rate and delay, that lands where the last one
		// already put playback is not news. Anything else (a handover, a park or resume, a new delay)
		// is always published.
		const current = this.#out.reference.peek();
		const same =
			current !== undefined &&
			clock !== undefined &&
			source === was &&
			previous !== undefined &&
			previous.rate === clock.rate &&
			delay === this.#referenceDelay &&
			Math.abs(reference - current) < REFERENCE_SLACK;
		this.#referenceDelay = delay;
		if (same) return;
		this.#out.reference.set(reference);
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
	//
	// `at` is when the frame arrived, on this thread's `Time.Milli.now()` clock, for a frame read on
	// another thread and reported here later: measured at the report instead, the hop would read as
	// the path delivering late.
	received(timestamp: Time.Milli, label = "", at?: Time.Milli): void {
		this.#out.timestamp.update((current) => (current === undefined || timestamp > current ? timestamp : current));
		const now = at ?? Time.Milli.now();
		const ref = Time.Milli.sub(now, timestamp);
		const playhead = this.#playhead(now);

		// First frame anchors the reference.
		if (playhead === undefined) {
			this.#out.reference.set(ref);
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

		const currentRef = this.#out.reference.peek();
		if (currentRef === undefined) return;

		// Frame isn't earlier than the anchor: it can't add lookahead, so keep the reference.
		if (ref >= currentRef) return;

		// Frame is earlier (more lookahead). `sleep` is how far ahead of the playhead keeping the
		// anchor would put it.
		const cap = this.#out.maxAge.peek();
		if (sleep <= cap) return; // within budget: let the buffer grow instead of skipping ahead

		// Over the cap: re-anchor down so the resulting lookahead is exactly the cap.
		this.#out.reference.set(Time.Milli.add(ref, Time.Milli.sub(cap, this.#out.delay.peek())));
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
		// Peek the input, not `out.instant`, which lags a same-turn change until effects flush.
		if (this.in.delay.peek() === "instant") return;

		if (this.#playhead(Time.Milli.now()) === undefined) {
			throw new Error("reference not set; call received() first");
		}

		for (;;) {
			// Switching to "instant" wakes the sleep below, so frames parked here leave.
			if (this.in.delay.peek() === "instant") return;

			// Sleep until it's time to decode the next frame.
			// NOTE: This function runs in parallel for each frame.
			const playhead = this.#playhead(Time.Milli.now());
			if (playhead === undefined) return;

			const remaining = Time.Milli.sub(timestamp, playhead);
			if (remaining <= 0) return;

			// A playhead that is not at full speed gets there later, and a parked one has no
			// deadline to sleep towards, only a change to wait for.
			const rate = this.#clock?.rate ?? 1;
			const sleep = rate > 0 ? remaining / rate : undefined;

			// Skip setTimeout for small sleeps; the timer resolution (~4ms) would overshoot.
			if (sleep !== undefined && sleep < 5) return;

			await this.#sleep(sleep);
		}
	}

	// Sleeps for `ms`, or until woken when it is undefined, returning early once anything the sleep
	// was computed from changes. The loop in `wait()` re-reads the playhead either way, so a
	// playhead that slowed down while a timer ran is not taken for one that arrived. Releases every
	// listener either way: frames sleep once each, so a listener left on a signal that never
	// changes would pile up for the life of the player.
	#sleep(ms: number | undefined): Promise<void> {
		return new Promise((resolve) => {
			const wake = () => {
				clearTimeout(timer);
				for (const dispose of disposes) dispose();
				resolve();
			};
			const timer = ms === undefined ? undefined : setTimeout(wake, ms);
			const disposes = [
				this.in.delay.changed(wake),
				this.#out.delay.changed(wake),
				// A nominated clock re-derives the reference from every sample that moves the playhead.
				this.#out.reference.changed(wake),
			];
		});
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
		// Frames parked on a playhead that will never move leave with it.
		this.reset();
	}
}

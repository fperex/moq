import type * as Moq from "@moq/net";
import { Time } from "@moq/net";
import { Derived, Effect, type Getter, getter, type Inputs, type Readonlys, readonlys, Signal } from "@moq/signals";

/**
 * How far playback trails the live edge.
 *
 * `"auto"` (the default) sizes the jitter buffer from the connection RTT; a `Time.Milli` fixes it.
 *
 * `"instant"` drops the buffer and the pacing together: nothing is held, and {@link Sync.wait}
 * returns without sleeping, so a frame presents as soon as it exists. It also overrides
 * {@link SyncInput.buffer}, since holding a lookahead would contradict holding nothing. Audio is
 * the owner's business: a ring with no depth underruns, so whoever wants this mode is expected to
 * turn audio off.
 */
export type Delay = "instant" | "auto" | Time.Milli;

/** A media position at a presentation time on the performance.now clock. */
export interface Clock {
	/** The media timestamp presented at reference. */
	timestamp: Time.Milli;
	/** The presentation time in performance.now milliseconds. */
	reference: Time.Milli;
	/** Media milliseconds per wall-clock millisecond, or zero while held. */
	rate: number;
}

const MIN_JITTER = Time.Milli(20);
const FALLBACK_JITTER = Time.Milli(100);

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

	/**
	 * The connection's PROBE estimates, whose RTT drives "auto" jitter. Usually wired
	 * from a `Connection`'s `probe`.
	 */
	probe: Getter<Moq.Connection.Probe | undefined>;

	/** Any additional delay required for audio (wired from the per-rendition source). */
	audio: Getter<Time.Milli | undefined>;

	/** Any additional delay required for video (wired from the per-rendition source). */
	video: Getter<Time.Milli | undefined>;

	/** The audio presentation clock, absent when audio is inactive. */
	clock: Getter<Clock | undefined>;

	/** The total measured audio playout requirement, used only in auto mode. */
	audioTarget: Getter<Time.Milli | undefined>;
};

type SyncOutput = {
	// The earliest time we've received a frame, relative to its timestamp.
	// This will keep being updated as we catch up to the live playhead then will be relatively static.
	reference: Signal<Time.Milli | undefined>;

	// The resolved delay from the live edge to the playhead: jitter + max(audio, video).
	delay: Signal<Time.Milli>;

	// The jitter component of `delay` (always numeric).
	// In "auto" mode this is updated automatically from RTT.
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

	readonly #out: SyncOutput = {
		reference: new Signal<Time.Milli | undefined>(undefined),
		delay: new Signal<Time.Milli>(Time.Milli.zero),
		jitter: new Signal<Time.Milli>(FALLBACK_JITTER),
		timestamp: new Signal<Time.Milli | undefined>(undefined),
		buffered: new Signal<boolean>(false),
		maxAge: new Signal<Time.Milli>(Time.Milli.zero),
	};
	readonly out = readonlys(this.#out);

	// A ghetto way to learn when the reference/buffer changes.
	// There's probably a way to use Effect, but lets keep it simple for now.
	#update: PromiseWithResolvers<void>;

	// Per-label late-frame tracking: accumulate count and max lateness, flush on recovery.
	#late = new Map<string, { count: number; maxMs: number }>();

	// Minimum RTT seen, used as the baseline for jitter calculation.
	// Avoids inflating jitter due to bufferbloat.
	#minRtt: number | undefined;
	#clock: Clock | undefined;
	#resetClock: Clock | undefined;
	readonly #delay: Getter<Time.Milli>;
	#closed = false;

	#signals = new Effect();

	constructor(props?: Inputs<SyncInput>) {
		this.in = {
			delay: getter(props?.delay ?? ("auto" as Delay)),
			buffer: getter(props?.buffer ?? Time.Milli.zero),
			probe: getter(props?.probe),
			audio: getter(props?.audio),
			video: getter(props?.video),
			clock: getter(props?.clock),
			audioTarget: getter(props?.audioTarget),
		};
		this.#delay = new Derived(
			[this.in.delay, this.#out.jitter, this.in.audio, this.in.video, this.in.audioTarget],
			(mode, jitter, audio, video, measured) => {
				if (mode === "instant") return Time.Milli.zero;
				const media = Time.Milli.max(audio ?? Time.Milli.zero, video ?? Time.Milli.zero);
				const floor = Time.Milli.add(media, typeof mode === "number" ? mode : jitter);
				return mode === "auto" ? Time.Milli.max(floor, measured ?? Time.Milli.zero) : floor;
			},
		);

		this.#update = Promise.withResolvers();

		this.#signals.run(this.#runJitter.bind(this));
		this.#signals.run(this.#runDelay.bind(this));
		this.#signals.run(this.#runMaxAge.bind(this));
		this.#signals.run(this.#runClock.bind(this));
	}

	#runClock(effect: Effect): void {
		const snapshot = effect.get(this.in.clock);
		const instant = effect.get(this.in.delay) === "instant";
		const clock = instant || snapshot === this.#resetClock ? undefined : snapshot;
		if (this.#clock && !clock && !instant) {
			const now = Time.Milli.now();
			const position = this.#clock.timestamp + (now - this.#clock.reference) * this.#clock.rate;
			this.#out.reference.set(Time.Milli(now - position - this.#delay.peek()));
		}
		this.#clock = clock;
		this.#update.resolve();
		this.#update = Promise.withResolvers();
	}

	// Derive `buffered` / `maxAge` from the resolved delay and the configured lookahead.
	#runMaxAge(effect: Effect): void {
		const delay = effect.get(this.#out.delay);
		// "instant" holds nothing, so a configured lookahead doesn't apply.
		const buffer = effect.get(this.in.delay) === "instant" ? Time.Milli.zero : effect.get(this.in.buffer);

		this.#out.buffered.set(buffer > 0);
		this.#out.maxAge.set(Time.Milli.add(delay, buffer));
	}

	#runJitter(effect: Effect): void {
		const delay = effect.get(this.in.delay);

		if (delay === "instant") {
			// Holds nothing at all.
			this.#minRtt = undefined;
			this.#out.jitter.set(Time.Milli.zero);
			return;
		}

		if (typeof delay === "number") {
			// Fixed mode: the configured delay is the jitter.
			this.#minRtt = undefined;
			this.#out.jitter.set(delay);
			return;
		}

		// "auto" mode: compute jitter from the connection's RTT estimate.
		const rtt = effect.get(this.in.probe)?.rtt;
		if (rtt !== undefined) {
			// Track minimum RTT as baseline, ignoring bufferbloat.
			this.#minRtt = this.#minRtt !== undefined ? Math.min(this.#minRtt, rtt) : rtt;

			// Buffer enough for a retransmit (1 RTT for ACK + retransmit).
			const jitter = Time.Milli(Math.max(MIN_JITTER, this.#minRtt * 1.25));
			this.#out.jitter.set(jitter);
			return;
		}

		// No RTT available: fall back to static default.
		this.#minRtt = undefined;
		this.#out.jitter.set(FALLBACK_JITTER);
	}

	#runDelay(effect: Effect): void {
		this.#out.delay.set(effect.get(this.#delay));

		this.#update.resolve();
		this.#update = Promise.withResolvers();
	}

	// Fold a newly received frame into the reference. The reference anchors playback to the
	// wall clock; we lower it (skip ahead) only when keeping it would push the lookahead past `maxAge`.
	received(timestamp: Time.Milli, label = ""): void {
		this.#out.timestamp.update((current) => (current === undefined || timestamp > current ? timestamp : current));
		const now = Time.Milli.now();
		const ref = Time.Milli.sub(now, timestamp);
		const currentRef = this.#out.reference.peek();

		// First frame anchors the reference.
		if (currentRef === undefined) {
			this.#setReference(ref);
			return;
		}

		// Check if `wait()` would not sleep at all.
		// NOTE: We check here instead of in `wait()` so we can identify when frames are received late.
		// Otherwise, chained `wait()` calls would cause a false-positive during CPU starvation.
		const delay = this.#out.delay.peek();
		const sleep = Time.Milli.add(Time.Milli.sub(currentRef, ref), delay);
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

		// Frame isn't earlier than the anchor: it can't add lookahead, so keep the reference.
		if (ref >= currentRef) return;

		// Frame is earlier (more lookahead). `sleep` is how far ahead of the playhead keeping the
		// anchor would put it.
		const cap = this.#out.maxAge.peek();
		if (sleep <= cap) return; // within budget: let the buffer grow instead of skipping ahead

		// Over the cap: re-anchor down so the resulting lookahead is exactly the cap.
		this.#setReference(Time.Milli.add(ref, Time.Milli.sub(cap, delay)));
	}

	#setReference(ref: Time.Milli): void {
		this.#out.reference.set(ref);
		this.#update.resolve();
		this.#update = Promise.withResolvers();
	}

	// Re-anchor playback to the next frame received. Call this at an utterance boundary
	// in buffered mode (typically alongside flushing the audio buffer) so the new content
	// plays from its own first frame instead of inheriting the previous reference.
	reset(): void {
		this.#clock = undefined;
		this.#resetClock = this.in.clock.peek();
		this.#out.reference.set(undefined);
		this.#late.clear();
		this.#update.resolve();
		this.#update = Promise.withResolvers();
	}

	// The PTS that should be rendering right now, derived from the reference + buffer.
	// Returns undefined if no frames have been received yet.
	now(): Time.Milli | undefined {
		if (this.in.delay.peek() !== "instant" && this.#clock) {
			return Time.Milli(this.#clock.timestamp + (Time.Milli.now() - this.#clock.reference) * this.#clock.rate);
		}
		const reference = this.#out.reference.peek();
		if (reference === undefined) return undefined;
		return Time.Milli.sub(Time.Milli.sub(Time.Milli.now(), reference), this.#delay.peek());
	}

	// Sleep until it's time to render this frame.
	async wait(timestamp: Time.Milli): Promise<void> {
		// A zero delay still sleeps: the sleep comes from the reference, which holds an early frame
		// until its timestamp comes up. "instant" is the only thing that skips the wait itself.
		if (this.#closed || this.in.delay.peek() === "instant") return;

		if (!this.#clock && this.#out.reference.peek() === undefined) {
			throw new Error("reference not set; call received() first");
		}

		for (;;) {
			// Switching to "instant" resolves `#update`, so frames parked here wake and leave.
			if (this.#closed || this.in.delay.peek() === "instant") return;

			const current = this.now();
			if (current === undefined || timestamp <= current) return;
			const rate = this.#clock?.rate ?? 1;
			const sleep = rate === 0 ? undefined : (timestamp - current) / rate;

			// Skip setTimeout for small sleeps; the timer resolution (~4ms) would overshoot.
			if (sleep !== undefined && sleep < 5) return;

			let timer: ReturnType<typeof setTimeout> | undefined;
			const wait = new Promise<boolean>((resolve) => {
				if (sleep !== undefined) timer = setTimeout(() => resolve(true), sleep);
			});
			try {
				const done = await Promise.race([this.#update.promise.then(() => false), wait]);
				if (done) return;
			} finally {
				if (timer !== undefined) clearTimeout(timer);
			}
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
		this.#closed = true;
		this.#update.resolve();
		this.#signals.close();
	}
}

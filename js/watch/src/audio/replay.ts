/**
 * Replay an arrival trace through the real estimator, the real rings, and the real playout engine.
 *
 * One simulated clock drives everything: frames are inserted at the wall time the trace recorded,
 * and one render quantum is pulled every quantum's worth of that same clock, which is what the
 * AudioWorklet does. Nothing here approximates a component. `Container.Jitter` resolves the target,
 * both rings are the ones a page runs, and `Stretcher` is the engine the worklet owns, so a change
 * that moves any of them moves these numbers.
 *
 * Shared by `replay.test.ts`, which grades it against fixed budgets, and by the audio quality
 * harness's replay lane (`test/audio-quality/clients/js/replay.ts`), which grades it against
 * `budgets.json`. One implementation, so the two can never drift into measuring different things.
 *
 * @internal Test support, not part of the player.
 */
import * as Container from "@moq/hang/container";
import { Time } from "@moq/net";
import { type RingReader, type Snapshot, Stretcher } from "./playout";
import { speech } from "./playout/fixture";
import { AudioRingBuffer } from "./ring-buffer";
import { allocSharedRingBuffer, SharedRingBuffer } from "./shared-ring-buffer";

/** An AudioWorklet render quantum, in frames. */
const QUANTUM = 128;

/** One Opus frame, which is the chunk a synthetic trace is built from. */
export const CHUNK_MS = 20;

/** One frame of a trace: when it was captured, and the wall time it reached us. */
export interface Arrival {
	/** Media timestamp, in ms. */
	media: number;
	/** Wall time the frame arrived, in ms from the start of the trace. */
	arrival: number;
	/** The recorder's own event loop was blocked before this frame was read. */
	stalled?: boolean;
	/**
	 * The publisher declared its timeline finished here rather than sending a frame.
	 *
	 * Carries no media, so it is neither inserted nor observed: a declared pause says nothing about
	 * how late the path is running. The ring is told, and what it holds plays out into silence.
	 */
	endpoint?: boolean;
}

/** A recorded trace, as trimmed into `./fixtures`. */
export interface Fixture {
	/** Where the recording came from. */
	source: string;
	/** What it is, and what makes it worth keeping. */
	description: string;
	/**
	 * Arrival timing only: no payload, no codec, nothing identifying.
	 *
	 * `stalled` is the recording's own answer to a question the timing cannot settle: whether the
	 * receiver was blocked before it read this frame, which the estimator discounts rather than
	 * measuring. A recording that never watched its loop simply omits it.
	 */
	arrivals: { timestamp_us: number; arrival_ms: number; stalled?: boolean; endpoint?: boolean }[];
}

/** A fixture's arrivals in the units this module works in. */
export function recorded(fixture: Fixture): Arrival[] {
	return fixture.arrivals.map(({ timestamp_us, arrival_ms, stalled, endpoint }) => ({
		media: timestamp_us / 1000,
		arrival: arrival_ms,
		stalled,
		endpoint,
	}));
}

/** Deterministic PRNG, so a synthetic trace is the same on every machine. */
function rng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * A sender emitting a frame every {@link CHUNK_MS}, holding `burst - 1` of them back and flushing
 * the run at once, plus `spread` ms of per-flush network jitter.
 *
 * `burst` of 1 is an evenly paced sender; anything above it is the PES packing an importer produces.
 */
export function trace(frames: number, burst: number, spread: number, seed = 7): Arrival[] {
	const rand = rng(seed);
	const out: Arrival[] = [];
	let held: number[] = [];
	for (let i = 0; i < frames; i++) {
		const media = i * CHUNK_MS;
		held.push(media);
		if (held.length < burst) continue;
		// Every frame keeps its own capture time; the whole run shares one arrival.
		const arrival = media + 50 + rand() * spread;
		for (const m of held) out.push({ media: m, arrival });
		held = [];
	}
	return out;
}

/**
 * The target the estimator settles on for a trace: the real `Jitter`, fed the same arrivals, held
 * above `floorMs`.
 *
 * Also the whole point of the exercise. Nothing here approximates the estimator, so a change that
 * moves it moves what these rings are sized to.
 */
export function target(t: Arrival[], floorMs: number): number {
	const jitter = new Container.Jitter();
	for (const { media, arrival, stalled } of t) {
		jitter.observe(Time.Micro.fromMilli(media as Time.Milli), arrival as Time.Milli, { stalled });
	}
	return Math.max(floorMs, jitter.value.peek());
}

/** The two rings behind one interface, since the harness drives them identically. */
export interface Ring {
	readonly reader: RingReader;
	insert(timestamp: Time.Micro, data: Float32Array[]): void;
	/** The publisher declared the timeline finished: play out what is held, then silence. */
	end(): void;
	setLatency(ms: number): void;
	debug(): Snapshot;
	readonly length: number;
}

/** Build a ring at `rate` already sized for a starting target of `latencyMs`. */
export type Build = (latencyMs: number) => Ring;

/**
 * The shared-memory ring, sized for the estimator's ceiling up front the way `SharedAudioBuffer`
 * does, so a rising target never reallocates.
 */
export function shared(rate: number): Build {
	return (latencyMs: number) => {
		const ceiling = Math.ceil((rate * Container.Jitter.CEILING) / 1000);
		const ring = new SharedRingBuffer(allocSharedRingBuffer(1, ceiling, rate));
		ring.setLatency(Math.ceil((rate * latencyMs) / 1000));
		return {
			reader: ring,
			insert: (timestamp, data) => ring.insert(timestamp, data),
			end: () => ring.end(),
			setLatency: (ms) => ring.setLatency(Math.ceil((rate * ms) / 1000)),
			debug: () => ring.debug(),
			get length() {
				return ring.length;
			},
		};
	};
}

/** The postMessage ring, which is the path every page without cross-origin isolation takes. */
export function post(rate: number): Build {
	return (latencyMs: number) => {
		const ring = new AudioRingBuffer({ rate, channels: 1, latency: latencyMs as Time.Milli });
		return {
			reader: ring,
			insert: (timestamp, data) => ring.write(timestamp, data),
			end: () => ring.end(),
			setLatency: (ms) => ring.resize(ms as Time.Milli),
			debug: () => ring.debug(),
			get length() {
				return ring.length;
			},
		};
	};
}

/** Both rings at `rate`, named, for a parametrised suite or a matrix row. */
export function rings(rate: number): Array<[string, Build]> {
	return [
		["shared", shared(rate)],
		["post", post(rate)],
	];
}

/** What a replay heard, counted after the warmup. */
export interface Result {
	/** Times the reader ran dry mid-playback. */
	underruns: number;
	/** Samples thrown away: the reader skipped them, or the writer dropped or trimmed them. */
	skipped: number;
	/** Quanta rendered, so `underruns` can be read as a rate. */
	quanta: number;
	/** Quanta that came back short of a full block. */
	short: number;
	/** Blocks the time stretch shortened and lengthened. */
	accelerates: number;
	expands: number;
	/** Samples synthesized to cover a gap, and the splices that ended them. */
	concealed: number;
	merges: number;
	/**
	 * Everything the engine emitted after the warmup, so silence can be looked for in it.
	 *
	 * Empty unless {@link Options.capture} asked for it, because a recording's worth of PCM is
	 * megabytes a run that only grades counters should not pay for.
	 */
	played: Float32Array;
	/** The target the estimator had resolved when the trace ended, in ms. */
	target: number;
	/** Wall time the replay covered, in ms, which is the trace's own span. */
	elapsedMs: number;
	/** The progress series, empty unless {@link Options.sampleMs} asked for one. */
	samples: Progress[];
}

/** The whole state of a replay at one instant, on the simulated clock. */
export interface Progress {
	/** Simulated wall time since the trace started, in ms. */
	at: number;
	/** The target the estimator had resolved by then, in ms. */
	target: number;
	/** Every ring and engine counter, cumulative. */
	debug: Snapshot;
}

/**
 * How many samples each frame carries, taken from the distance to the next frame on the media
 * timeline.
 *
 * A recorded AAC trace is 23.22ms per frame, not the 20ms a synthetic Opus trace uses, and inserting
 * the wrong count leaves the ring gap-filling silence between every pair of frames.
 */
function frameSamples(t: Arrival[], rate: number): number[] {
	const sorted = [...t].sort((a, b) => a.media - b.media);
	const spacing = new Map<number, number>();

	for (let i = 0; i < sorted.length - 1; i++) {
		const gap = sorted[i + 1].media - sorted[i].media;
		// A gap far past one frame is missing media, not a long frame: keep the frame its own size
		// and let the ring fill the hole.
		spacing.set(sorted[i].media, gap > 0 && gap < 100 ? gap : 0);
	}

	const nominal = Math.max(...spacing.values().filter((v) => v > 0));
	return t.map(({ media }) => Math.round((rate * (spacing.get(media) || nominal)) / 1000));
}

/** What one replay is asked to do. */
export interface Options {
	/** Sample rate the ring and the engine run at, in Hz. */
	rate: number;
	/** A floor under the measured target, in ms: the recording's own frame duration. */
	floorMs: number;
	/** Wall time to play before counting starts, in ms: the target is still converging before it. */
	warmupMs: number;
	/** A fixed target instead of the measured one, in ms. The control the estimator is graded against. */
	fixed?: number;
	/**
	 * Whether a gap is concealed with synthesized audio rather than played as a ramp into silence.
	 *
	 * On by default, which is what a page runs. Off is the control a concealment test grades against.
	 */
	conceal?: boolean;
	/** Keep everything rendered after the warmup in {@link Result.played}. Off by default. */
	capture?: boolean;
	/**
	 * Record a {@link Progress} every this many ms of simulated time.
	 *
	 * Off by default, because a suite that only grades totals should not pay for the series. The
	 * harness asks for one on the page's 250 ms grid, so a replay row and a browser row are reduced
	 * the same way.
	 */
	sampleMs?: number;
}

/**
 * Play `t` through `build` in simulated real time: insert every frame the moment it arrives, and
 * pull one render quantum every quantum's worth of wall time through the real playout engine.
 *
 * The estimator runs live, exactly as `Container.Consumer` drives it: observe at arrival, and let
 * the new target reach the ring the way `Sync` and `Decoder.#runLatency` push it there. A settled
 * number measured up front would hide the thing the design turns on, which is that the target rises
 * the moment an arrival proves the buffer too shallow.
 */
export function replay(build: Build, t: Arrival[], options: Options): Result {
	const { rate, floorMs, warmupMs, fixed, sampleMs, conceal = true, capture = false } = options;
	const step = (QUANTUM / rate) * 1000;
	const output = [new Float32Array(QUANTUM)];
	const end = t[t.length - 1].arrival;
	const samples = frameSamples(t, rate);

	const jitter = new Container.Jitter();
	const latency = () => fixed ?? Math.max(floorMs, jitter.value.peek());

	const ring = build(latency());
	const engine = new Stretcher(rate, 1, conceal);
	// The tone restarts with every replay, so a row is the same whether it ran alone or after five
	// others: the splice the correlation search picks depends on the phase it is handed.
	voiceAt = 0;

	let next = 0;
	let outputFrame = 0;
	let started = false;
	let quanta = 0;
	let short = 0;
	let mark: { quanta: number; short: number; debug: Snapshot } | undefined;
	const progress: Progress[] = [];
	let nextSample = 0;

	// Everything rendered after the warmup, so a gap can be looked for as silence rather than only
	// counted as a short quantum.
	const played = new Float32Array(capture ? Math.ceil(((end + step) * rate) / 1000) : 0);
	let length = 0;

	for (let now = 0; now < end; now += step) {
		while (next < t.length && t[next].arrival <= now) {
			if (t[next].endpoint) {
				// A declared pause carries no media: nothing to insert, and nothing to measure a
				// path against. The ring plays out what it holds and renders silence after it.
				ring.end();
				next++;
				continue;
			}

			const count = samples[next];
			jitter.observe(Time.Micro.fromMilli(t[next].media as Time.Milli), now as Time.Milli, {
				stalled: t[next].stalled,
			});
			ring.setLatency(latency());
			// A 200Hz tone rather than a constant: a splice on a constant is seamless whatever the
			// correlation search decides, which would hide a kernel that picked the wrong lag.
			ring.insert(Time.Micro.fromMilli(t[next].media as Time.Milli), [voice(rate, count)]);
			next++;
		}

		const count = engine.render(ring.reader, output, outputFrame);
		outputFrame += QUANTUM;
		quanta++;
		if (started && count < QUANTUM) short++;
		if (count > 0) started = true;
		if (mark && length + count <= played.length) {
			played.set(output[0].subarray(0, count), length);
			length += count;
		}

		if (now >= warmupMs && !mark) mark = { quanta, short, debug: ring.debug() };

		if (sampleMs !== undefined && now >= nextSample) {
			progress.push({ at: now, target: latency(), debug: ring.debug() });
			nextSample = now + sampleMs;
		}
	}

	const debug = ring.debug();
	const from = mark ?? { quanta, short, debug };
	return {
		underruns: debug.underruns - from.debug.underruns,
		skipped:
			debug.skipped -
			from.debug.skipped +
			(debug.discarded - from.debug.discarded) +
			(debug.trimmed - from.debug.trimmed),
		quanta: quanta - from.quanta,
		short: short - from.short,
		accelerates: debug.accelerates - from.debug.accelerates,
		expands: debug.expands - from.debug.expands,
		concealed: debug.concealed - from.debug.concealed,
		merges: debug.merges - from.debug.merges,
		played: played.subarray(0, length),
		target: latency(),
		elapsedMs: end,
		samples: progress,
	};
}

/**
 * A 200Hz tone the correlation search can find a period in, pausing over a quiet room so the
 * background estimate has something to learn from, two seconds of it per rate.
 *
 * A pure sine trains nothing, and concealment built on one fades into digital silence rather than
 * into the room.
 */
const TONES = new Map<number, Float32Array>();
let voiceAt = 0;

function voice(rate: number, count: number): Float32Array {
	let tone = TONES.get(rate);
	if (!tone) {
		tone = speech(rate, 2, 200, 0.5, 0.002)[0];
		TONES.set(rate, tone);
	}
	const start = voiceAt % (tone.length - count);
	voiceAt += count;
	return tone.slice(start, start + count);
}

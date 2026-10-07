/**
 * Replay a recorded arrival trace through the player's consumer and rings on a simulated clock.
 *
 * Every frame is written into its group at the instant the trace says it arrived, and the player's
 * real `Container.Consumer` decides what to deliver, wait for, and skip, at the max age the delay
 * sets. Delivered frames go into the real ring, and a discontinuity resets it, the way the decoder
 * does. One render quantum is rendered every quantum's worth of that same clock, through the playout
 * engine the AudioWorklet owns, which is what the AudioWorklet does. A real {@link Sync} resolves the
 * delay from the playout target the decoder registers, measured by that same consumer from the
 * recorded catalog config, and the ring follows it the way the decoder resizes it, so a change to any
 * of them moves what a replay hears. Decoding is taken as instant and sample exact.
 *
 * Deterministic, so the audio quality harness grades its output with no headroom, and a unit test
 * can assert exact counts.
 *
 * @internal Test support, not part of the player.
 */
import type * as Catalog from "@moq/hang/catalog";
import * as Container from "@moq/hang/container";
import { Group, Time, Track } from "@moq/net";
import { Effect } from "@moq/signals";
import { type Delay, Sync } from "../sync";
import { frameDuration } from "./config";
import { ringSamples, target } from "./latency";
import type { Playhead } from "./playhead";
import { type Counters, type RingReader, Stretcher } from "./playout";
import { AudioRingBuffer } from "./ring-buffer";
import { allocSharedRingBuffer, SharedRingBuffer } from "./shared-ring-buffer";
import { Terminal } from "./terminal";

/** An AudioWorklet render quantum, in frames. */
export const QUANTUM = 128;

/**
 * The replay's own subscription passes every recorded group through: the recorder's relay already
 * applied a wire max age, so only the consumer's decisions are made again.
 */
const WIRE_MAX_AGE = Time.Milli(Number.MAX_SAFE_INTEGER);

/** Any non-empty payload: an empty one is the legacy container's end marker. */
const PAYLOAD = new Uint8Array(1);

/** The empty payload that is the legacy container's end marker. */
const MARKER = new Uint8Array(0);

/** One frame reaching the container consumer. */
export interface Arrival {
	/** When it arrived, on the viewer's monotonic clock, in ms. */
	at: number;
	/** Its media timestamp, in ms. */
	timestamp: number;
	/** The group that carried it. */
	group: number;
	/**
	 * The publisher declared its timeline finished here rather than sending a frame: the endpoint a
	 * muting publisher writes, alone in its group.
	 *
	 * Carries no media, so it is neither inserted nor measured, but it is what raises the discontinuity
	 * that resets the ring.
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
	 * A frame to a group, as the publishers recorded publish them. `stalled` is the recording's own
	 * note that the receiver's event loop was blocked before it read the frame, which a replay does
	 * not act on. `endpoint` is a publisher declaring its timeline finished rather than sending a frame.
	 */
	arrivals: { timestamp_us: number; arrival_ms: number; stalled?: boolean; endpoint?: boolean }[];
}

/**
 * A fixture's arrivals in the units a replay takes, from the first one's moment.
 *
 * A frame is a group, numbered by its place in media order, which is what a publisher numbers them by:
 * a frame that arrives before an earlier one is a group that overtook another.
 */
export function recorded(fixture: Fixture): Arrival[] {
	const order = [...new Set(fixture.arrivals.map((a) => a.timestamp_us))].sort((a, b) => a - b);
	const groups = new Map(order.map((timestamp, group) => [timestamp, group]));
	const first = fixture.arrivals[0].arrival_ms;
	return fixture.arrivals.map(({ timestamp_us, arrival_ms, endpoint }) => ({
		at: arrival_ms - first,
		timestamp: timestamp_us / 1000,
		group: groups.get(timestamp_us) ?? 0,
		endpoint,
	}));
}

/** What a replay plays through. */
export interface Options {
	/** `shared` is the SharedArrayBuffer ring a cross-origin isolated page runs; `post` is the rest. */
	ring: "shared" | "post";
	/** The sample rate, in Hz. */
	rate: number;
	/** The configured delay, as the element takes it. "instant" plays no audio, so it has no replay. */
	delay: Exclude<Delay, "instant">;
	/**
	 * Whether a gap is concealed with synthesized audio rather than played as a ramp into silence. On
	 * by default, which is what a page runs. Off is the control a concealment test grades against.
	 */
	conceal?: boolean;
	/** The rendition as the catalog described it: its advertised jitter, delay, and codec. */
	config: Catalog.AudioConfig;
	/**
	 * How long the trace observed, from its first arrival, in ms. Rendering runs to here, so an
	 * outage after the last arrival is heard rather than cut off.
	 */
	duration: number;
}

/** One render quantum, as the worklet produced it. */
export interface Quantum {
	/** When it finished rendering, on the trace's clock, in ms. */
	at: number;
	/** The quantum: what the ring supplied at the front, zeros after it. Reused between yields. */
	output: Float32Array;
	/** Whether the ring was stalled after this quantum. */
	stalled: boolean;
	/** What the playout engine has done so far, cumulative. Reused between yields. */
	counters: Counters;
	/**
	 * Where the reader is and how fast it moves, as the page would sample it, or undefined before the
	 * ring anchors. Stateful: the rate is measured between calls, so ask at the cadence a page polls.
	 */
	playhead(): Playhead | undefined;
	/** The playhead after this quantum, on the media clock, in ms. */
	timestamp: number;
	/** The delay `Sync` resolved as of this quantum, in ms: what sizes the ring. */
	delay: number;
}

/** The two rings behind the calls the decoder and the worklet make on them. */
interface Ring {
	insert(timestamp: Time.Micro, data: Float32Array[]): void;
	/** What the playout engine reads. A resized shared ring is a new one, so this is read afresh. */
	readonly reader: RingReader;
	reset(): void;
	/** Move the target, and say whether that replaced the ring the worklet reads. */
	setLatency(samples: number): boolean;
	readonly stalled: boolean;
	readonly timestamp: Time.Micro;
	readonly playhead: Playhead | undefined;
}

/** The shared ring, sized and grown the way `SharedAudioBuffer` sizes and grows it. */
function shared(rate: number, latency: number): Ring {
	let ring = new SharedRingBuffer(allocSharedRingBuffer(1, Math.max(rate, latency * 2), rate));
	ring.setLatency(latency);
	return {
		insert: (timestamp, data) => ring.insert(timestamp, data),
		get reader() {
			return ring;
		},
		reset: () => ring.reset(),
		setLatency: (samples) => {
			ring.setLatency(samples);
			if (ring.capacity >= samples * 1.5) return false;
			ring = ring.resize(Math.max(rate, samples * 2));
			return true;
		},
		get stalled() {
			return ring.stalled;
		},
		get timestamp() {
			return ring.timestamp;
		},
		get playhead() {
			return ring.playhead;
		},
	};
}

/** Samples as the milliseconds `PostAudioBuffer` posts to the worklet. */
const millis = (rate: number, samples: number) => Time.Milli.fromSecond((samples / rate) as Time.Second);

/** The postMessage ring, sized the way `PostAudioBuffer` asks the worklet to size it. */
function post(rate: number, latency: number): Ring {
	const ring = new AudioRingBuffer({ rate, channels: 1, latency: millis(rate, latency) });
	return {
		insert: (timestamp, data) => ring.write(timestamp, data),
		reader: ring,
		reset: () => ring.reset(),
		setLatency: (samples) => {
			ring.resize(millis(rate, samples));
			return false;
		},
		get stalled() {
			return ring.stalled;
		},
		get timestamp() {
			return ring.timestamp;
		},
		get playhead() {
			// One object, refilled: copied, because a caller keeps it past the next read.
			const playhead = ring.playhead;
			return playhead && { ...playhead };
		},
	};
}

/** A trace's media timestamp as the container carries it. */
const micros = (ms: number) => Math.round(ms * 1000) as Time.Micro;

/**
 * Samples each frame carries, by its timestamp: the trace's typical frame, the median spacing.
 *
 * A frame within half a frame of that runs up to where the next one starts instead, so consecutive
 * frames tile the timeline exactly despite rounding. Any wider spacing is a frame that never
 * arrived, which stays missing audio rather than stretching the frame before it.
 */
function frameSamples(trace: Arrival[], rate: number): { spans: Map<Time.Micro, number>; typical: number } {
	const starts = [...new Set(trace.map((a) => a.timestamp))].sort((a, b) => a - b);
	const sample = (ms: number) => Math.round((ms * rate) / 1000);
	const gaps = starts.slice(1).map((next, i) => sample(next) - sample(starts[i]));
	const typical = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
	if (typical === undefined) throw new Error("a trace needs two frames");

	const spans = new Map<Time.Micro, number>();
	starts.forEach((start, i) => {
		const gap = gaps[i];
		const tiles = gap !== undefined && Math.abs(gap - typical) * 2 <= typical;
		spans.set(micros(start), tiles ? gap : typical);
	});
	return { spans, typical };
}

/**
 * Run every microtask already queued, and every one those queue, before returning.
 *
 * A macrotask starts only once the microtask queue is empty, and nothing between a group write and
 * the ring arms a timer, so this orders the replay behind the consumer rather than waiting on time.
 */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Play `trace` in simulated real time, yielding every render quantum from the first arrival to the
 * end of the observation.
 *
 * A group's stream finishes with its last recorded frame. The audio is a constant, never zero, so
 * what the ring did not supply is exactly the zeros at the end of a quantum, which is how the
 * harness's output tap reads a real page.
 */
export async function* replay(trace: Arrival[], options: Options): AsyncGenerator<Quantum> {
	const first = trace[0];
	const last = trace.at(-1);
	if (!first || !last) return;
	const end = first.at + options.duration;
	if (end < last.at) throw new Error(`an arrival at ${last.at} ms is past the ${options.duration} ms observed`);

	const { rate, config } = options;
	const { spans: samples, typical } = frameSamples(trace, rate);

	// Where each group's stream finishes.
	const ends = new Map<number, number>();
	trace.forEach((arrival, i) => {
		ends.set(arrival.group, i);
	});

	const sync = new Sync({ delay: options.delay });
	const track = new Track.Producer("audio");
	const consumer = new Container.Consumer(track.subscribe({ maxAge: WIRE_MAX_AGE }), {
		format: new Container.Legacy.Format("audio"),
		maxAge: sync.out.maxAge,
	});

	// The decoder's "auto" target. A recorded frame has no payload to read an Opus duration from,
	// so a codec without a constant one takes the trace's typical spacing.
	const signals = new Effect();
	const frame = frameDuration(config) ?? Time.Milli((typical * 1000) / rate);
	const playout = signals.computed((effect) =>
		target({
			measured: effect.get(consumer.spread),
			advertised: config.jitter !== undefined ? Time.Milli(config.jitter) : undefined,
			frame,
			delay: config.delay !== undefined ? Time.Milli(config.delay) : undefined,
		}),
	);
	signals.cleanup(sync.register(playout));
	await settle();

	let delay = sync.out.delay.peek();
	const ring = (options.ring === "shared" ? shared : post)(rate, ringSamples(rate, delay));
	// The engine the worklet owns: one per reader, kept across the ring being replaced under it.
	const engine = new Stretcher(rate, 1, options.conceal ?? true);
	let rendered = 0;

	// The decoder's read loop, with the codec taken out. A failure is rethrown at the next quantum.
	const terminal = new Terminal();
	let failure: { error: unknown } | undefined;
	const decode = (async () => {
		for (;;) {
			const next = await consumer.next();
			if (!next) return;
			if (terminal.update(next)) ring.reset();
			if (next.end !== undefined || !next.frame) continue;

			const { timestamp } = next.frame;
			const length = samples.get(timestamp);
			if (length === undefined) throw new Error(`the consumer delivered an unrecorded frame at ${timestamp} us`);
			ring.insert(timestamp, [new Float32Array(length).fill(0.5)]);
		}
	})().catch((error: unknown) => {
		failure = { error };
	});

	const groups = new Map<number, Group.Producer>();
	const step = (QUANTUM / rate) * 1000;
	const output = new Float32Array(QUANTUM);
	let next = 0;

	// The consumer stamps each arrival on the monotonic clock, which the estimator measures, so it
	// reads the trace's clock instead until the replay finishes.
	let clock = first.at;
	const monotonic = performance.now;
	performance.now = () => clock;

	try {
		for (let n = 1; first.at + (n - 1) * step <= end; n++) {
			// The quantum ending at `now` renders once everything that arrived by then is delivered.
			const now = first.at + n * step;
			let stamped = next;
			while (next < trace.length && trace[next].at <= now) {
				const arrival = trace[next];
				// The consumer stamps a frame as it reads it, so the clock moves on only once
				// everything that arrived at the previous instant has been read.
				if (arrival.at !== clock) {
					if (next > stamped) await settle();
					stamped = next;
					clock = arrival.at;
				}
				let group = groups.get(arrival.group);
				if (!group) {
					group = new Group.Producer(arrival.group);
					groups.set(arrival.group, group);
					track.writeGroup(group);
				}
				const timestamp = micros(arrival.timestamp);
				group.writeFrame({
					payload: Container.Legacy.encodeFrame(arrival.endpoint ? MARKER : PAYLOAD, timestamp),
					timestamp: Time.Timestamp.fromMicros(timestamp),
				});
				if (ends.get(arrival.group) === next) {
					group.close();
					groups.delete(arrival.group);
				}
				next++;
			}
			if (next > stamped) await settle();
			if (failure) throw failure.error;

			// The decoder resizes the ring as the resolved delay moves, which only an arrival does.
			const resolved = sync.out.delay.peek();
			if (resolved !== delay) {
				delay = resolved;
				// A replacement ring is the same timeline: the engine drops its block and keeps its counters.
				if (ring.setLatency(ringSamples(rate, delay))) engine.discontinuity();
			}

			// Everything that arrived by now has been read, so the clock moves on to the quantum for
			// whoever watches it from outside: a `Sync` paced against this replay.
			clock = now;
			output.fill(0);
			engine.render(ring.reader, [output], rendered);
			rendered += QUANTUM;
			yield {
				at: now,
				output,
				stalled: ring.stalled,
				counters: engine.counters(),
				playhead: () => ring.playhead,
				timestamp: Time.Milli.fromMicro(ring.timestamp),
				delay,
			};
		}
	} finally {
		consumer.close();
		track.close();
		await decode;
		signals.close();
		sync.close();
		performance.now = monotonic;
	}
}

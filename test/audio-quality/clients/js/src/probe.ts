/**
 * Samples what a `<moq-watch>` will tell anyone who asks, every 250 ms.
 *
 * Public signals only. Nothing here reaches past the element's `out` surface, patches a module, or
 * knows which ring is running, so the same probe reads a build from the npm package and a build from
 * this checkout, and a number it reports is one a consumer could have read too. Where a counter does
 * not exist yet the sample carries `undefined` and the analyzer reports null, rather than this file
 * growing a private hook to fill the gap.
 *
 * Two things are measured rather than read, because no signal carries them:
 *
 * - The silence share, from an `AnalyserNode` fanned out from `audio.out.root`. A counter says the
 *   ring was fed; only the PCM says the listener heard anything.
 * - `AudioContext.currentTime` against wall time, which is how a run that was throttled or never
 *   really rendered gets caught instead of being graded.
 *
 * Adapted from the black-box probe in `debug-findings/analysis/blackbox.js` on the reporter's fork
 * (`fperex/moq`, branch `debug/rt-audio`). See ../../README.md.
 *
 * @module
 */
import type MoqWatch from "@moq/watch/element";
import { type Environment, SAMPLE_INTERVAL_MS, type Sample } from "./schema.ts";

/** Anything with a `peek()`, which is every signal under an `out`. */
type Peekable<T> = { peek(): T };

/** Read a signal that may not exist on this build, as a plain number. */
function num<T>(signal: Peekable<T> | undefined): number | undefined {
	const value = signal?.peek();
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Read something that may not be there on the build under test, without taking the probe down.
 *
 * The point of reading only public signals is that the same page can measure an older build, and an
 * older build is exactly where a signal is missing. Optional chaining covers a missing leaf; this
 * covers a missing branch, where the parent object is undefined and reaching through it throws. One
 * absent counter must leave every other number in the sample intact.
 */
function maybe<T>(read: () => T): T | undefined {
	try {
		return read();
	} catch {
		return undefined;
	}
}

/**
 * Chromium's render capacity surface, which is not in lib.dom yet.
 *
 * `averageLoad` is the share of each render quantum's budget the graph used. Absent in Safari, which
 * is why `render_load` is a chromium-only metric in the schema.
 */
type RenderCapacity = {
	start(options: { updateInterval: number }): void;
	stop(): void;
	addEventListener(type: "update", listener: (event: RenderCapacityEvent) => void): void;
};
type RenderCapacityEvent = { averageLoad: number; peakLoad: number; underrunRatio: number };

/** What the probe collects, until someone drains it. */
export type Probe = {
	/** Samples taken since the last drain. */
	drain(): Sample[];
	/** What the page is, reported once it can be. Null until the session is up. */
	environment(): Environment | null;
	/** Console warnings and errors seen so far. */
	notes(): string[];
	/** Stop sampling. */
	stop(): void;
};

/**
 * Start sampling `watch`.
 *
 * Sampling begins immediately and keeps going through the element's own startup, so the run records
 * how long it took to produce audio at all rather than starting the clock once it already had.
 */
export function probe(watch: MoqWatch): Probe {
	const started = performance.now();
	const samples: Sample[] = [];
	const notes: string[] = [];

	// The analyser is fanned out from whatever `root` currently is, and re-attached when it changes:
	// the node is rebuilt when the ring is, and an analyser left on the old one reads silence forever
	// and would report a perfect run as a fully silent one.
	let analyser: AnalyserNode | undefined;
	let attachedTo: AudioNode | undefined;
	let pcm: Float32Array<ArrayBuffer> | undefined;

	// Render capacity arrives on its own event rather than on demand, so the latest reading is held
	// here and sampled with everything else.
	let renderLoad: number | undefined;
	let capacityStarted: AudioContext | undefined;

	const attach = () => {
		const root = maybe(() => watch.audio.out.root.peek());
		if (!root || root === attachedTo) return;
		try {
			const node = new AnalyserNode(root.context, { fftSize: 2048 });
			root.connect(node);
			analyser = node;
			pcm = new Float32Array(node.fftSize);
			attachedTo = root;
		} catch (err) {
			notes.push(`analyser: ${err instanceof Error ? err.message : String(err)}`);
		}

		const context = maybe(() => watch.audio.out.context.peek());
		if (context && capacityStarted !== context) {
			capacityStarted = context;
			const capacity = (context as unknown as { renderCapacity?: RenderCapacity }).renderCapacity;
			if (!capacity) {
				// Safari has no render capacity surface at all, and a Chromium without it is worth
				// knowing about rather than reading as a graph that never did any work.
				notes.push("renderCapacity: unavailable, render_load will be null");
			} else {
				try {
					capacity.addEventListener("update", (event) => {
						renderLoad = event.averageLoad;
					});
					// Seconds, and a full second rather than the sample interval: the shorter ones are
					// rejected outright by some builds, and the load is a smooth quantity anyway.
					capacity.start({ updateInterval: 1 });
				} catch (err) {
					notes.push(`renderCapacity: ${err instanceof Error ? err.message : String(err)}`);
				}
			}
		}
	};

	const rms = (): number | undefined => {
		if (!analyser || !pcm) return undefined;
		analyser.getFloatTimeDomainData(pcm);
		let sum = 0;
		for (const value of pcm) sum += value * value;
		return Math.sqrt(sum / pcm.length);
	};

	const sample = (): Sample => {
		attach();
		const audio = watch.audio.out;
		const sync = watch.sync.out;
		const context = maybe(() => audio.context.peek());

		// `buffered` is a list of ranges, not a depth. What the grader wants is how much audio is
		// ready to play, so the ranges are summed; a gap in the middle is not playable time.
		const ranges = maybe(() => audio.buffered.peek()) ?? [];
		const buffered = ranges.reduce((total, range) => total + (Number(range.end) - Number(range.start)), 0);

		return {
			at: performance.now() - started,

			timestamp: num(audio.timestamp),
			stalled: maybe(() => audio.stalled.peek()),
			underruns: num(audio.underruns),
			spread: num(audio.spread),
			buffered: ranges.length > 0 ? buffered : undefined,
			// TODO: `audio.out.skipped` does not exist on this build. Stage 3 adds
			// `Container.Consumer.skipped` and surfaces it as `Decoder.out.skipped`; until then
			// `skipped_groups` and `budget_aborts` are null in every summary. The same goes for
			// `audio.out.debug()` (short, silent, and discarded quanta), which stage 5 adds.
			stats: maybe(() => audio.stats.peek()) as Record<string, unknown> | undefined,

			delay: num(sync.delay),
			jitter: num(sync.jitter),
			maxAge: num(sync.maxAge),
			reference: num(sync.reference),
			syncTimestamp: num(sync.timestamp),

			rms: rms(),
			renderLoad,
			outputLatency: context ? context.outputLatency * 1000 : undefined,
			baseLatency: context ? context.baseLatency * 1000 : undefined,
			contextTime: context ? context.currentTime * 1000 : undefined,
		};
	};

	// Console output is part of the evidence: a censored group or a decoder reset shows up here long
	// before it shows up in a counter, and a run that filled the log is worth knowing about even when
	// every number passed.
	const original = { warn: console.warn, error: console.error };
	const capture = (level: string, fn: (...args: unknown[]) => void) => {
		return (...args: unknown[]) => {
			if (notes.length < 200) notes.push(`${level}: ${args.map(String).join(" ").slice(0, 200)}`);
			fn(...args);
		};
	};
	console.warn = capture("warn", original.warn);
	console.error = capture("error", original.error);

	const timer = setInterval(() => samples.push(sample()), SAMPLE_INTERVAL_MS);

	return {
		drain() {
			return samples.splice(0, samples.length);
		},
		environment() {
			const catalog = watch.broadcast.out.catalog.peek();
			// The catalog is what says the session got far enough to be measuring anything.
			if (!catalog) return null;
			const renditions = catalog.audio?.renditions ?? {};
			// `audio.source` is one of the signals an older build may not have, and the rendition it
			// names only picks between several. Falling back to the first one loses nothing on a
			// single-rendition broadcast, which is every broadcast this harness publishes.
			const track = maybe(() => watch.audio.source.out.track.peek());
			const config = (typeof track === "string" ? renditions[track] : undefined) ?? Object.values(renditions)[0];
			return {
				crossOriginIsolated: globalThis.crossOriginIsolated === true,
				transport: maybe(() => watch.connection.transport.peek()),
				rtt: rttOf(watch),
				catalogCodec: config?.codec,
				catalogRate: config?.sampleRate,
				catalogJitter: config?.jitter,
				timeOrigin: performance.timeOrigin,
			};
		},
		notes() {
			return notes.slice();
		},
		stop() {
			clearInterval(timer);
			console.warn = original.warn;
			console.error = original.error;
		},
	};
}

/** The connection's reported round-trip time, which is an object rather than a number. */
function rttOf(watch: MoqWatch): number | undefined {
	const rtt = watch.connection.probe.peek()?.rtt;
	return typeof rtt === "number" && Number.isFinite(rtt) ? rtt : undefined;
}

import * as Util from "@moq/hang/util";
import { Time } from "@moq/net";
import { Effect, type Getter, getter, type Inputs, type Readonlys, readonlys, Signal } from "@moq/signals";
import {
	ALL_FORMATS,
	type AudioSample,
	AudioSampleSink,
	BlobSource,
	Input,
	type InputAudioTrack,
	type InputVideoTrack,
	type VideoSample,
	VideoSampleSink,
} from "mediabunny";
import type * as Audio from "../audio";
import type * as Video from "../video";
import { fill } from "./audio";
import { Timeline } from "./timeline";

// Signals the file source reads.
export type FileInput = {
	// Whether to decode the file. Defaults to true. When false the decode stops and `out.source` clears.
	enabled: Getter<boolean>;
};

/** Constructor options: the wired inputs plus the file to decode. */
export interface FileProps extends Inputs<FileInput> {
	/** Seed the file; also live-editable via `file.file` and {@link File.prompt}. */
	file?: globalThis.File | Signal<globalThis.File | undefined>;
}

type FileOutput = {
	// The sources decoded from the file, empty while disabled or undecodable.
	source: Signal<{ video?: Video.Source; audio?: Audio.Source }>;
};

// Image, video, and audio files we know how to decode (see #decode).
const ACCEPT = "image/*,video/*,audio/*";

// A still image has no cadence of its own, so republish it at this rate. Delta coding makes the
// repeats nearly free, and a steady stream keeps the encoder's keyframe interval honest.
const IMAGE_FRAME_RATE = 30;

// How many packets to measure when estimating the file's frame rate.
const FRAME_RATE_SAMPLES = 100;

/**
 * Decodes a local file into looping publish sources.
 *
 * The file is demuxed and decoded directly rather than played through a `<video>` element, so the
 * frames carry the container's own timestamps, audio works on every browser, and nothing stops when
 * the window isn't composited.
 */
export class File {
	readonly in: Readonlys<FileInput>;

	/** The file to decode. Written by {@link prompt}, or set it directly. */
	file: Signal<globalThis.File | undefined>;

	readonly #out: FileOutput = {
		source: new Signal<{ video?: Video.Source; audio?: Audio.Source }>({}),
	};
	readonly out = readonlys(this.#out);

	#signals = new Effect();

	constructor(props?: FileProps) {
		this.in = {
			enabled: getter(props?.enabled ?? true),
		};
		this.file = Signal.from(props?.file);

		this.#signals.run((effect) => {
			const values = effect.getAll([this.file, this.in.enabled]);
			if (!values) return;
			const [file] = values;

			this.#decode(file, effect).catch((err) => {
				console.error("Failed to decode file:", err);
			});
		});
	}

	/**
	 * Open a native file picker and use the chosen file as the source.
	 * Must be called from within a user gesture (e.g. a click handler), otherwise the browser blocks the dialog.
	 */
	prompt() {
		const input = document.createElement("input");
		input.type = "file";
		input.accept = ACCEPT;
		input.addEventListener("change", () => {
			const file = input.files?.[0];
			if (file) this.file.set(file);
		});
		input.click();
	}

	async #decode(file: globalThis.File, effect: Effect) {
		// Only images are routed by MIME type. Everything else goes to the demuxer, which sniffs the
		// container itself and so still works for the files browsers report with an empty type.
		if (file.type.startsWith("image/")) {
			await this.#decodeImage(file, effect);
		} else {
			await this.#decodeMedia(file, effect);
		}
	}

	async #decodeImage(file: globalThis.File, effect: Effect) {
		const signal = effect.abort;

		const bitmap = await createImageBitmap(file);
		effect.cleanup(() => bitmap.close());
		if (signal.aborted) return;

		const zero = now();
		let index = 0;

		const frames = new ReadableStream<VideoFrame>({
			async pull(controller) {
				const offset = Time.Micro.fromSecond((index / IMAGE_FRAME_RATE) as Time.Second);
				const timestamp = (zero + offset) as Time.Micro;
				index++;

				await sleepUntil(timestamp, signal);

				// The bitmap is closed on teardown, so stop before building a frame from a dead one.
				if (signal.aborted) {
					controller.close();
					return;
				}

				controller.enqueue(new VideoFrame(bitmap, { timestamp }));
			},
		});

		effect.set(this.#out.source, { video: { frames, frameRate: IMAGE_FRAME_RATE } }, {});
	}

	async #decodeMedia(file: globalThis.File, effect: Effect) {
		const signal = effect.abort;

		const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
		effect.cleanup(() => input.dispose());

		if (!(await input.canRead())) {
			// Disposing the input mid-read is a teardown, not a broken file.
			if (signal.aborted) return;
			throw new Error(`Cannot publish "${file.name}": unrecognized container format.`);
		}

		const [video, audio] = await Promise.all([input.getPrimaryVideoTrack(), input.getPrimaryAudioTrack()]);

		// Install the WebCodecs polyfill before probing: canDecode() reports false when AudioDecoder
		// is missing rather than throwing, so probing first would drop the audio track on an engine
		// the polyfill could have covered. A no-op wherever WebCodecs is native.
		if (audio) await Util.Libav.polyfill();

		// A codec this browser can't decode drops just its own track: the other one is usually still
		// publishable, and a video-only publish beats failing outright.
		const [videoOk, audioOk] = await Promise.all([decodable(video, file), decodable(audio, file)]);
		if (!videoOk && !audioOk) {
			if (signal.aborted) return;
			throw new Error(`Cannot publish "${file.name}": no decodable audio or video track.`);
		}

		const duration = await input.computeDuration();

		// The encoder sizes its bitrate off this, and a file's real cadence beats assuming 30fps.
		const frameRate =
			video && videoOk ? (await video.computePacketStats(FRAME_RATE_SAMPLES)).averagePacketRate : undefined;

		// Pin the clock last. Probing the file takes a moment, and anchoring before that would leave
		// the first samples already overdue, so playback would open with a catch-up burst.
		//
		// One timeline for both tracks, so they restart together and stay in sync across loops.
		const timeline = new Timeline(now(), duration);

		const source = {
			video: video && videoOk ? videoSource(video, timeline, frameRate, signal) : undefined,
			audio: audio && audioOk ? audioSource(audio, timeline, signal) : undefined,
		};

		if (signal.aborted) return;
		effect.set(this.#out.source, source, {});
	}

	/** Stop decoding and release the file. */
	close() {
		this.#signals.close();
	}
}

// The bits of a mediabunny sample the pacing loop touches. Video and audio samples only differ in
// what they convert to, which the caller supplies.
interface Sample {
	readonly microsecondTimestamp: number;
	setTimestamp(seconds: number): void;
	close(): void;
}

interface Sink<S extends Sample> {
	samples(startTimestamp?: number): AsyncGenerator<S, void, unknown>;
}

/**
 * Reads decoded samples out of a sink, restarting the file when it ends.
 *
 * Restamps onto our wall clock, the same epoch live capture uses, so a publish that mixes sources
 * keeps one timeline. Runs ahead of the pacing so the audio gap filler sees a single continuous
 * presentation rather than one file pass at a time.
 */
async function* repeat<S extends Sample>(sink: Sink<S>, timeline: Timeline): AsyncGenerator<S, void, unknown> {
	for (let loop = 0; ; loop++) {
		// A fresh generator seeks back to the start; the offset keeps timestamps rising.
		const samples = sink.samples();
		let produced = false;
		try {
			for (let next = await samples.next(); !next.done; next = await samples.next()) {
				produced = true;
				const sample = next.value;
				try {
					sample.setTimestamp(
						Time.Second.fromMicro(timeline.at(sample.microsecondTimestamp as Time.Micro, loop)),
					);
					yield sample;
				} finally {
					sample.close();
				}
			}
		} finally {
			await samples.return();
		}

		// A pass that decoded nothing would otherwise spin forever.
		if (!timeline.loops || !produced) return;
	}
}

/**
 * Holds each sample until its presentation time, then hands it to the reader.
 *
 * Decoding runs far faster than realtime, so waiting here is what makes this publish at 1x instead
 * of blasting the whole file out at once. It also applies backpressure: the sink only decodes ahead
 * as far as the reader pulls. A sample that's already late goes out immediately, letting a stalled
 * reader catch up.
 */
function pace<S extends Sample, T>(
	samples: AsyncGenerator<S, void, unknown>,
	convert: (sample: S) => T,
	signal: AbortSignal,
): ReadableStream<T> {
	// Cancellation closes the samples still held by the generator chain, so nothing may be enqueued
	// after it: cancel() can land while a pull is waiting on the clock.
	let cancelled = false;

	return new ReadableStream<T>({
		async pull(controller) {
			if (signal.aborted) {
				await samples.return();
				controller.close();
				return;
			}

			let next: IteratorResult<S, void>;
			try {
				next = await samples.next();
			} catch (err) {
				// Teardown disposes the Input, which makes any decode still in flight throw.
				if (cancelled) return;
				if (!signal.aborted) throw err;
				controller.close();
				return;
			}

			if (cancelled) return;
			if (next.done) {
				controller.close();
				return;
			}

			const sample = next.value;
			try {
				await sleepUntil(sample.microsecondTimestamp as Time.Micro, signal);
				if (cancelled) return;
				if (signal.aborted) {
					await samples.return();
					controller.close();
					return;
				}
				controller.enqueue(convert(sample));
			} finally {
				sample.close();
			}
		},

		async cancel() {
			cancelled = true;
			await samples.return();
		},
	});
}

function videoSource(
	track: InputVideoTrack,
	timeline: Timeline,
	frameRate: number | undefined,
	signal: AbortSignal,
): Video.FrameSource {
	const sink = new VideoSampleSink(track);
	const convert = track.rotation === 0 ? (sample: VideoSample) => sample.toVideoFrame() : rotator(track);

	return {
		frames: pace(repeat(sink, timeline), convert, signal),
		frameRate,
	};
}

function audioSource(track: InputAudioTrack, timeline: Timeline, signal: AbortSignal): Audio.SampleSource {
	const sink = new AudioSampleSink(track);
	const presentation = {
		timestamp: timeline.at(Time.Micro.zero, 0),
		sampleRate: track.sampleRate,
		numberOfChannels: track.numberOfChannels,
	};

	return {
		samples: pace(
			fill(repeat(sink, timeline), presentation),
			(sample: AudioSample) => sample.toAudioData(),
			signal,
		),
		sampleRate: track.sampleRate,
		channelCount: track.numberOfChannels,
		// A file is whatever the user picked, so leave the Opus tuning to the encoder.
		kind: "auto",
	};
}

// Phone footage is usually stored sideways with rotation metadata, which toVideoFrame() ignores
// because a VideoFrame can't carry it. Drawing through a canvas is the only way to bake it in.
function rotator(track: InputVideoTrack): (sample: VideoSample) => VideoFrame {
	const canvas = new OffscreenCanvas(track.displayWidth, track.displayHeight);

	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("Failed to create 2D canvas context");

	return (sample) => {
		sample.draw(ctx, 0, 0, canvas.width, canvas.height);
		return new VideoFrame(canvas, { timestamp: sample.microsecondTimestamp });
	};
}

// Whether we can decode this track, warning (rather than throwing) when we can't so the file's other
// track still publishes.
async function decodable(track: InputVideoTrack | InputAudioTrack | null, file: globalThis.File): Promise<boolean> {
	if (!track) return false;
	if (await track.canDecode()) return true;

	console.warn(
		`Publishing "${file.name}" without its ${track.type} track: this browser can't decode ${track.codec}.`,
	);
	return false;
}

// Our wall clock in microseconds, the epoch capture stamps frames against (see video/processor.ts).
function now(): Time.Micro {
	return Time.Micro.fromMilli(performance.now() as Time.Milli);
}

// Wait until the given wall clock time, or until the effect tears down.
//
// A raw timeout rather than effect.timer because this runs once per sample: effect.timer registers a
// cleanup that only releases on teardown, which would pile up for as long as the file publishes.
function sleepUntil(timestamp: Time.Micro, signal: AbortSignal): Promise<void> {
	const delay = Time.Milli.fromMicro((timestamp - now()) as Time.Micro);
	if (delay <= 0 || signal.aborted) return Promise.resolve();

	return new Promise((resolve) => {
		const done = () => {
			clearTimeout(timeout);
			signal.removeEventListener("abort", done);
			resolve();
		};

		const timeout = setTimeout(done, delay);
		signal.addEventListener("abort", done, { once: true });
	});
}

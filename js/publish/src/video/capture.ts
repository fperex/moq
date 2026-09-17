import { Effect, type Getter, getter, type Inputs, type Readonlys, readonlys, Signal } from "@moq/signals";
import { Fanout } from "../fanout";
import { TrackProcessor } from "./processor";
import { normalizeSource, type Source } from "./types";

// The raw capture source to pump frames from.
export type CaptureInput = {
	source: Getter<Source | undefined>;
};

type CaptureOutput = {
	// The captured frames, replaced whenever the source changes. Subscribe for a stream of your own;
	// each reader owns the frames it receives and must close them.
	frames: Signal<Fanout<VideoFrame> | undefined>;
	// The captured dimensions and source scale, sampled together for each frame.
	display: Signal<{ width: number; height: number; scale?: number } | undefined>;
	// Why the capture stopped delivering frames, or undefined while it is delivering.
	stopped: Signal<Error | undefined>;
};

// How long to wait before rebuilding a pipeline that stopped on a track that is still live.
//
// Not zero: whatever made the processor give up is rarely over within the tick, and an immediate
// retry would spin. Short enough that a viewer sees a gap rather than a dead broadcast.
const REBUILD = 1_000;

/**
 * Pumps frames off a capture {@link Source} and distributes them to any number of readers.
 *
 * Split out of the encoders so one capture feeds every rendition, the preview, and the stats. Each
 * reader gets its own copy of every frame and closes what it receives; a reader that falls behind
 * loses its own oldest rather than stalling the capture.
 */
export class Capture {
	readonly in: Readonlys<CaptureInput>;

	readonly #out: CaptureOutput = {
		frames: new Signal<Fanout<VideoFrame> | undefined>(undefined),
		display: new Signal<{ width: number; height: number; scale?: number } | undefined>(undefined),
		stopped: new Signal<Error | undefined>(undefined),
	};
	readonly out = readonlys(this.#out);

	// Bumped to rebuild the pipeline on the same source, when the pipeline stopped but the source
	// did not. See `#runStopped`.
	#generation = new Signal(0);

	#signals = new Effect();

	constructor(props?: Inputs<CaptureInput>) {
		this.in = {
			source: getter(props?.source),
		};

		this.#signals.run(this.#runDisplay.bind(this));
		this.#signals.run(this.#run.bind(this));
	}

	// The dimensions describe the source, not the pipeline reading it. A pipeline rebuilt on the
	// same track still captures the same picture, and blanking them would blank the encoder's
	// resolved config and drop the rendition out of the catalog, which takes every viewer's
	// subscription with it. So they are cleared when the source changes, and only then.
	#runDisplay(effect: Effect) {
		effect.get(this.in.source);
		effect.cleanup(() => this.#out.display.set(undefined));
	}

	#run(effect: Effect) {
		// A bump rebuilds the pipeline even though the source has not changed. See `#runStopped`.
		effect.get(this.#generation);

		const source = effect.get(this.in.source);
		if (!source) return;

		this.#out.stopped.set(undefined);

		// A capture track goes through MediaStreamTrackProcessor, which rewrites timestamps onto our
		// wall clock so they stay consistent when the source changes or the encoder reloads. A
		// FrameSource already stamps against that clock, so take its frames as they are.
		const stream = "frames" in source ? source.frames : TrackProcessor(normalizeSource(source).track);

		const fanout = new Fanout(stream.pipeThrough(this.#measure(source)), {
			// A frame is a resource with an explicit lifetime, so every reader needs its own handle
			// and closes it. Sharing one would let the first reader close it under the others.
			clone: (frame) => frame.clone(),
			release: (frame) => frame.close(),
		});
		effect.cleanup(() => fanout.close());

		effect.set(this.#out.frames, fanout, undefined);

		effect.run((inner) => this.#runStopped(inner, fanout, source));
	}

	// React to the pipeline ending. Nothing used to: the fanout closed, every reader's stream ended,
	// and the signal kept pointing at the dead object, so the preview kept its last frame, the
	// capture rate went to zero and the encoders went quiet while the element still announced a live
	// broadcast. A track that is still live can be captured again, so rebuild on it; a track that
	// ended is the application's to re-acquire, so say so loudly and stop pretending.
	#runStopped(effect: Effect, fanout: Fanout<VideoFrame>, source: Source): void {
		const ended = effect.get(fanout.ended);
		if (ended === undefined) return;

		const track = "frames" in source ? undefined : normalizeSource(source).track;
		const live = track?.readyState === "live";
		const reason = ended ?? new Error(live ? "the capture pipeline ended" : "the capture source ended");

		console.error(`moq-publish: video capture stopped: ${reason.message}`);
		this.#out.stopped.set(reason);

		if (!live) return;
		effect.timer(() => this.#generation.update((generation) => generation + 1), REBUILD);
	}

	// Sample live source metadata even when the coded dimensions stay unchanged.
	#measure(source: Source): TransformStream<VideoFrame, VideoFrame> {
		return new TransformStream<VideoFrame, VideoFrame>({
			transform: (frame, controller) => {
				try {
					const scale = "frames" in source ? undefined : normalizeSource(source).scale;
					this.#out.display.set({ width: frame.codedWidth, height: frame.codedHeight, scale });
					controller.enqueue(frame);
				} catch (error) {
					frame.close();
					throw error;
				}
			},
		});
	}

	close() {
		this.#signals.close();
	}
}

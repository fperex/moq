import { expect, mock, test } from "bun:test";
import type { StreamTrack } from "./types";

mock.module("./capture-worker.ts?worker&inline", () => ({ default: class {} }));
const { Capture } = await import("./capture");

class Frame {
	codedWidth = 1920;
	codedHeight = 1080;
	timestamp: number;
	closed = false;

	constructor(source?: Frame, init?: { timestamp: number }) {
		this.timestamp = init?.timestamp ?? source?.timestamp ?? 0;
	}

	clone(): Frame {
		return new Frame(this);
	}

	close(): void {
		this.closed = true;
	}
}

test("capture resamples live scale when frame dimensions stay unchanged", async () => {
	const processor = Object.getOwnPropertyDescriptor(globalThis, "MediaStreamTrackProcessor");
	const videoFrame = Object.getOwnPropertyDescriptor(globalThis, "VideoFrame");
	let controller!: ReadableStreamDefaultController<VideoFrame>;
	const readable = new ReadableStream<VideoFrame>({
		start: (value) => {
			controller = value;
		},
	});
	Object.defineProperty(globalThis, "MediaStreamTrackProcessor", {
		configurable: true,
		value: class {
			readonly readable = readable;
		},
	});
	Object.defineProperty(globalThis, "VideoFrame", { configurable: true, value: Frame });
	let scale = 2;
	const capture = new Capture({
		source: {
			track: {} as StreamTrack,
			get scale() {
				return scale;
			},
		},
	});
	try {
		let changed = capture.out.display.changed();
		controller.enqueue(new Frame() as unknown as VideoFrame);
		expect(await changed).toMatchObject({ width: 1920, height: 1080, scale: 2 });
		scale = 1;
		changed = capture.out.display.changed();
		controller.enqueue(new Frame() as unknown as VideoFrame);
		expect(await changed).toMatchObject({ width: 1920, height: 1080, scale: 1 });
	} finally {
		capture.close();
		if (processor) Object.defineProperty(globalThis, "MediaStreamTrackProcessor", processor);
		else Reflect.deleteProperty(globalThis, "MediaStreamTrackProcessor");
		if (videoFrame) Object.defineProperty(globalThis, "VideoFrame", videoFrame);
		else Reflect.deleteProperty(globalThis, "VideoFrame");
	}
});

// A capture pipeline can stop while the camera track is still live: the processor's readable ends or
// errors and nothing above notices, because the fanout keeps handing out the object it already
// published. Downstream then just stops (the preview holds its last frame, the capture rate goes to
// zero, the encoders go quiet) while the element still announces a live broadcast.

const realSetTimeout = globalThis.setTimeout;
const flush = () => new Promise((resolve) => realSetTimeout(resolve, 0));

async function settle(rounds = 8): Promise<void> {
	for (let i = 0; i < rounds; i++) await flush();
}

/** Run the rebuild delay on a compressed clock rather than waiting a second out. */
function fastTimers(): () => void {
	globalThis.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) =>
		realSetTimeout(fn, ms !== undefined && ms > 20 ? 2 : ms, ...rest)) as typeof setTimeout;
	const error = console.error;
	// The stall is the subject here, so the noise it deliberately prints is not.
	console.error = () => {};
	return () => {
		globalThis.setTimeout = realSetTimeout;
		console.error = error;
	};
}

test("a pipeline that stops on a live track is reported and rebuilt on it", async () => {
	const restore = fastTimers();
	const processor = Object.getOwnPropertyDescriptor(globalThis, "MediaStreamTrackProcessor");
	const opened: ReadableStreamDefaultController<VideoFrame>[] = [];
	Object.defineProperty(globalThis, "MediaStreamTrackProcessor", {
		configurable: true,
		value: class {
			readonly readable = new ReadableStream<VideoFrame>({
				start: (controller) => {
					opened.push(controller);
				},
			});
		},
	});

	const videoFrame = Object.getOwnPropertyDescriptor(globalThis, "VideoFrame");
	Object.defineProperty(globalThis, "VideoFrame", { configurable: true, value: Frame });

	const track = { readyState: "live", kind: "video" } as unknown as StreamTrack;
	const capture = new Capture({ source: track });
	try {
		await settle();
		expect(capture.out.stopped.peek()).toBeUndefined();
		expect(opened).toHaveLength(1);

		const display = capture.out.display.changed();
		opened[0].enqueue(new Frame() as unknown as VideoFrame);
		expect(await display).toMatchObject({ width: 1920, height: 1080 });

		// The processor gives up while the camera keeps running.
		opened[0].close();
		for (let i = 0; i < 40 && capture.out.stopped.peek() === undefined; i++) await flush();
		expect(capture.out.stopped.peek()).toBeInstanceOf(Error);

		// The track still has frames to give, so the pipeline is rebuilt on it rather than left
		// pointing at a fanout that will never deliver again.
		for (let i = 0; i < 40 && opened.length < 2; i++) await flush();
		expect(opened.length).toBeGreaterThanOrEqual(2);
		expect(capture.out.stopped.peek()).toBeUndefined();

		// The dimensions belong to the source, so they survive the gap. Blanking them would blank
		// the encoder's resolved config and drop the rendition out of the catalog, which takes every
		// viewer's subscription with it and does not bring them back.
		expect(capture.out.display.peek()).toMatchObject({ width: 1920, height: 1080 });
	} finally {
		capture.close();
		if (processor) Object.defineProperty(globalThis, "MediaStreamTrackProcessor", processor);
		else Reflect.deleteProperty(globalThis, "MediaStreamTrackProcessor");
		if (videoFrame) Object.defineProperty(globalThis, "VideoFrame", videoFrame);
		else Reflect.deleteProperty(globalThis, "VideoFrame");
		restore();
	}
});

test("a frame source that ends is reported and not rebuilt", async () => {
	const restore = fastTimers();
	const opened: ReadableStreamDefaultController<VideoFrame>[] = [];
	// A `FrameSource` is the application's own stream. Reopening it is not ours to do, so this only
	// has to stop pretending the capture is still live.
	const capture = new Capture({
		source: {
			frames: new ReadableStream<VideoFrame>({
				start: (controller) => {
					opened.push(controller);
				},
			}),
		},
	});
	try {
		await settle();
		expect(opened).toHaveLength(1);

		opened[0].close();
		for (let i = 0; i < 40 && capture.out.stopped.peek() === undefined; i++) await flush();
		expect(capture.out.stopped.peek()).toBeInstanceOf(Error);
		await settle(20);
		expect(opened).toHaveLength(1);
	} finally {
		capture.close();
		restore();
	}
});

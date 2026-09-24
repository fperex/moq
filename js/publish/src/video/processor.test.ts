import { expect, mock, test } from "bun:test";
import type { FromWorker, ToWorker } from "./capture-worker.ts";

// Whether the fake worker claims a native MediaStreamTrackProcessor, how much its source clock
// advances per frame (WebKit's canvas tracks don't advance at all), and every worker spawned so far.
let supported = true;
let advance = 1000;
// Added to each frame's arrival time, so a test can space arrivals apart by more than the clock
// resolution rather than relying on performance.now() ticking between microtasks.
let arrivalStep = 0;
const spawned: FakeWorker[] = [];

// Stands in for the real capture worker: reports support on load, then answers each pull with a
// frame whose timestamp advances by 1000us.
class FakeWorker {
	onmessage: ((event: MessageEvent<FromWorker>) => void) | null = null;
	onerror: unknown = null;
	onmessageerror: unknown = null;

	terminated = false;
	started?: FakeTrack;
	// The cadence the <video> fallback asked for, and its ticks, which a test drives by hand rather
	// than waiting on a real timer.
	period?: number;

	#timestamp = 5_000_000; // the camera's own epoch, which the rewrite has to erase
	#frames = 0;
	#at = performance.now(); // frozen, so arrivals only move by arrivalStep

	constructor() {
		spawned.push(this);
		this.#emit({ type: "ready", supported });
	}

	/** One tick, as the real worker's interval would post it. */
	tick(): void {
		this.#emit({ type: "tick" });
	}

	postMessage(msg: ToWorker): void {
		if (msg.type === "start") {
			this.started = msg.track as unknown as FakeTrack;
			return;
		}

		if (msg.type === "tick") {
			this.period = msg.period;
			return;
		}

		this.#emit({
			type: "frame",
			frame: new FakeVideoFrame(this.#timestamp) as unknown as VideoFrame,
			at: performance.timeOrigin + this.#at + this.#frames * arrivalStep,
		});
		this.#timestamp += advance;
		this.#frames += 1;
	}

	terminate(): void {
		this.terminated = true;
	}

	#emit(msg: FromWorker): void {
		queueMicrotask(() => this.onmessage?.({ data: msg } as MessageEvent<FromWorker>));
	}
}

// Doubles as the global VideoFrame, whose (frame, init) overload is how the rewrite stage restamps
// a frame without copying its pixels.
class FakeVideoFrame {
	readonly timestamp: number;
	closed = false;

	constructor(source: number | FakeVideoFrame, init?: { timestamp: number }) {
		this.timestamp = init ? init.timestamp : (source as number);
	}

	close(): void {
		this.closed = true;
	}
}

class FakeTrack {
	stopped = false;
	clones = 0;

	clone(): FakeTrack {
		this.clones += 1;
		return new FakeTrack();
	}

	stop(): void {
		this.stopped = true;
	}

	getSettings(): { frameRate: number } {
		return { frameRate: RATE };
	}
}

// The camera's rate, picked so the fallback's grace (two frame periods) is short enough to wait out
// in a test without making it a timing race.
const RATE = 200;

/**
 * Stands in for the detached <video> the polyfill captures from.
 *
 * `advance` is one camera frame reaching the element: its media clock moves on, and the frame
 * callback fires unless it has been suspended, which is what Firefox does to a hidden document.
 */
class FakeVideo {
	currentTime = 0;
	srcObject: unknown = null;
	suspended = false;

	#callbacks = new Map<number, (now: number, metadata: { captureTime?: number }) => void>();
	#next = 1;

	play(): Promise<void> {
		return Promise.resolve();
	}

	set onloadedmetadata(resolve: () => void) {
		queueMicrotask(resolve);
	}

	requestVideoFrameCallback(callback: (now: number, metadata: { captureTime?: number }) => void): number {
		const handle = this.#next++;
		this.#callbacks.set(handle, callback);
		return handle;
	}

	cancelVideoFrameCallback(handle: number): void {
		this.#callbacks.delete(handle);
	}

	/** A new picture arrives. Returns the instant it was reported at, which is what stamps it. */
	advance(metadata: { captureTime?: number } = {}): number {
		this.currentTime += 1 / RATE;

		const now = performance.now();
		if (this.suspended) return now;

		// The real callback re-registers itself, so hand out the pending ones and start empty.
		const pending = [...this.#callbacks.values()];
		this.#callbacks.clear();
		for (const callback of pending) callback(now, metadata);
		return now;
	}
}

// The polyfill needs a document to create its element and a MediaStream to wrap the track, neither
// of which bun has. Restores whatever was there, because the test above it asserts their absence.
function install(): { video: () => FakeVideo; restore: () => void } {
	let video: FakeVideo | undefined;
	const had = Object.getOwnPropertyDescriptor(globalThis, "document");

	Object.defineProperty(globalThis, "document", {
		configurable: true,
		writable: true,
		value: {
			createElement(tag: string) {
				if (tag !== "video") throw new Error(`unexpected element: ${tag}`);
				video = new FakeVideo();
				return video;
			},
		},
	});
	Object.defineProperty(globalThis, "MediaStream", {
		configurable: true,
		writable: true,
		value: class {
			readonly tracks: unknown[];
			constructor(tracks: unknown[]) {
				this.tracks = tracks;
			}
		},
	});

	return {
		video: () => {
			if (!video) throw new Error("the polyfill never created a <video>");
			return video;
		},
		restore: () => {
			if (had) Object.defineProperty(globalThis, "document", had);
			else Reflect.deleteProperty(globalThis, "document");
			Reflect.deleteProperty(globalThis, "MediaStream");
		},
	};
}

// Let every pending microtask settle, so the stream has asked for its next frame before the test
// produces one. The polyfill only captures while a read is outstanding.
const drain = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

// Whether a read is still waiting, rather than hanging the test on one that never resolves.
async function pending<T>(read: Promise<T>): Promise<T | "pending"> {
	return await Promise.race([read, new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 25))]);
}

// The capture worker is imported as an inlined blob URL, which the bun test loader can't resolve.
mock.module("./capture-worker.ts?worker&inline", () => ({ default: FakeWorker }));

Object.defineProperty(globalThis, "VideoFrame", { configurable: true, writable: true, value: FakeVideoFrame });

const { TrackProcessor } = await import("./processor.ts");

test("captures through the worker, transferring a clone", async () => {
	supported = true;
	advance = 1000;
	arrivalStep = 0;
	spawned.length = 0;

	// The worker is constructed synchronously inside TrackProcessor, so bracket the whole call.
	const before = performance.now() * 1000;

	const track = new FakeTrack();
	const stream = TrackProcessor(track as unknown as Parameters<typeof TrackProcessor>[0]);
	const reader = stream.getReader();

	const first = await reader.read();
	const second = await reader.read();
	const after = performance.now() * 1000;

	expect(spawned).toHaveLength(1);
	const worker = spawned[0];

	// The caller keeps its own track (for the preview, settings and stop), so the worker gets a clone.
	expect(track.clones).toBe(1);
	expect(track.stopped).toBe(false);
	expect(worker.started).toBeDefined();
	expect(worker.started).not.toBe(track);

	// The camera's epoch is dropped: the first frame lands on the wall clock reading the worker took
	// when it read the frame, which is bounded by our own two readings.
	expect(first.value?.timestamp).toBeGreaterThanOrEqual(before);
	expect(first.value?.timestamp).toBeLessThanOrEqual(after);

	// Everything after the first keeps its original spacing.
	expect((second.value?.timestamp ?? 0) - (first.value?.timestamp ?? 0)).toBe(1000);

	await reader.cancel();
	expect(worker.terminated).toBe(true);
});

test("falls back when the worker has no MediaStreamTrackProcessor", async () => {
	supported = false;
	advance = 1000;
	arrivalStep = 0;
	spawned.length = 0;

	const track = new FakeTrack();
	const stream = TrackProcessor(track as unknown as Parameters<typeof TrackProcessor>[0]);
	const reader = stream.getReader();

	// The fallback needs a <video> element, which bun doesn't have: it fails rather than hanging,
	// which is enough to show we didn't take the worker path.
	await expect(reader.read()).rejects.toThrow();

	expect(spawned).toHaveLength(1);
	expect(spawned[0].terminated).toBe(true);

	// Nothing was handed over, so the caller's track is untouched.
	expect(track.clones).toBe(0);
	expect(track.stopped).toBe(false);
});

test("falls back to arrival time when the source clock is stuck", async () => {
	supported = true;
	// WebKit reports 0 for every frame off a canvas capture track, which the file source uses there.
	advance = 0;
	arrivalStep = 10;
	spawned.length = 0;

	const track = new FakeTrack();
	const stream = TrackProcessor(track as unknown as Parameters<typeof TrackProcessor>[0]);
	const reader = stream.getReader();

	const first = await reader.read();
	const second = await reader.read();
	const third = await reader.read();

	// Without the fallback all three would land on the same instant, and the encoder would see a
	// stream of frames that never advances. Arrivals are 10ms apart, so the deltas are exact.
	expect((second.value?.timestamp ?? 0) - (first.value?.timestamp ?? 0)).toBe(10_000);
	expect((third.value?.timestamp ?? 0) - (second.value?.timestamp ?? 0)).toBe(10_000);

	await reader.cancel();
});

test("keeps capturing when the frame callback is suspended", async () => {
	supported = false;
	advance = 1000;
	arrivalStep = 0;
	spawned.length = 0;

	const dom = install();
	try {
		const track = new FakeTrack();
		const stream = TrackProcessor(track as unknown as Parameters<typeof TrackProcessor>[0]);
		const reader = stream.getReader();

		await drain();
		const video = dom.video();

		// While the callback fires, every picture comes through it, stamped with the instant it
		// reported, in microseconds.
		for (let i = 0; i < 3; i++) {
			const read = reader.read();
			await drain();
			const now = video.advance();
			expect((await read).value?.timestamp).toBe(now * 1000);
		}

		// Firefox suspends requestVideoFrameCallback in a hidden document while the camera keeps
		// filling the element. Everything below this line has to come from the fallback.
		video.suspended = true;

		const ticker = spawned.at(-1) as FakeWorker;
		// Twice the camera's rate: over-sampling is dropped by the media clock check, while
		// under-sampling would cost frames.
		expect(ticker.period).toBeCloseTo(500 / RATE, 6);

		// A tick inside the grace is normal jitter, not a suspended callback.
		const early = reader.read();
		await drain();
		video.advance();
		ticker.tick();
		expect(await pending(early)).toBe("pending");

		// Past the grace the tick drives capture: one frame per picture, none of them repeats.
		const stamps: number[] = [];
		ticker.tick();
		stamps.push((await early).value?.timestamp ?? 0);

		for (let i = 0; i < 9; i++) {
			const read = reader.read();
			await drain();
			video.advance();
			ticker.tick();
			const frame = await read;
			expect(frame.done).toBe(false);
			stamps.push(frame.value?.timestamp ?? 0);
		}

		expect(stamps).toHaveLength(10);
		// One timeline, still going forwards: both clocks read performance.now(), because Firefox
		// supplies no captureTime.
		for (let i = 1; i < stamps.length; i++) expect(stamps[i]).toBeGreaterThan(stamps[i - 1]);

		await reader.cancel();
		expect(ticker.terminated).toBe(true);
	} finally {
		dom.restore();
	}
});

test("never captures the same picture twice", async () => {
	supported = false;
	advance = 1000;
	arrivalStep = 0;
	spawned.length = 0;

	const dom = install();
	try {
		const track = new FakeTrack();
		const stream = TrackProcessor(track as unknown as Parameters<typeof TrackProcessor>[0]);
		const reader = stream.getReader();

		await drain();
		const video = dom.video();
		video.suspended = true;

		const ticker = spawned.at(-1) as FakeWorker;

		// Out of the grace, and one picture through the fallback, so the pipeline is running.
		const first = reader.read();
		await drain();
		video.advance();
		expect(await pending(first)).toBe("pending");
		ticker.tick();
		expect((await first).value).toBeDefined();

		// The camera has delivered nothing since. A tick that captured anyway would hand the
		// encoder the same picture again, under a new timestamp.
		const read = reader.read();
		await drain();
		for (let i = 0; i < 10; i++) ticker.tick();
		expect(await pending(read)).toBe("pending");

		// And it picks up again the moment the camera does.
		video.advance();
		ticker.tick();
		expect((await read).value).toBeDefined();

		await reader.cancel();
	} finally {
		dom.restore();
	}
});

test("stops rather than hand the encoder a timeline that goes backwards", async () => {
	supported = false;
	advance = 1000;
	arrivalStep = 0;
	spawned.length = 0;

	const dom = install();
	try {
		const track = new FakeTrack();
		const stream = TrackProcessor(track as unknown as Parameters<typeof TrackProcessor>[0]);
		const reader = stream.getReader();

		await drain();
		const video = dom.video();

		const read = reader.read();
		await drain();
		const now = video.advance();
		expect((await read).value?.timestamp).toBe(now * 1000);

		// An engine that does supply captureTime could report one from before the frame we already
		// stamped. That is not something to paper over: the encoder's timeline is the contract.
		const next = reader.read();
		await drain();
		video.advance({ captureTime: now - 100 });
		await expect(next).rejects.toThrow(/backwards/);

		// A stream that errors is never cancelled, so it has to let go of both clocks itself.
		expect((spawned.at(-1) as FakeWorker).terminated).toBe(true);
	} finally {
		dom.restore();
	}
});

// The video capture worker, doing whichever of two jobs the main thread has for it. Compiled and
// inlined as a blob URL by Vite (`?worker&inline`).
//
// It reads camera frames off a native MediaStreamTrackProcessor, which Safari (18+) and Firefox
// expose only inside a dedicated worker. Frames are transferred back one at a time, each in response
// to a `pull`, so a busy main thread drops frames at the capture source instead of queueing them
// (and their GPU memory) in the message port. Timestamps are rewritten by the main thread: a
// worker's performance.now() has its own time origin, and audio and video have to share one epoch.
//
// Failing that, it keeps time for the <video> fallback. A worker is the only clock a browser does
// not throttle to 1 Hz in a hidden document, and the fallback needs one to keep capturing.

/** A message from the main thread to the worker. */
export type ToWorker =
	// Hand over the track. It is transferred, so the worker owns it from here.
	| { type: "start"; track: MediaStreamTrack }
	// Ask for the next frame. Exactly one is in flight at a time.
	| { type: "pull" }
	// Keep time instead, posting a `tick` every `period` milliseconds until termination.
	| { type: "tick"; period: number };

/** A message from the worker back to the main thread. */
export type FromWorker =
	// Sent on load, before the track arrives, so the main thread can fall back without losing it.
	| { type: "ready"; supported: boolean }
	// The next captured frame, transferred. The main thread owns and closes it. `at` is when we read
	// it, as absolute milliseconds (timeOrigin + now) so the main thread can shift it onto its own
	// timebase: our performance.now() has a different time origin.
	| { type: "frame"; frame: VideoFrame; at: number }
	// The clock the <video> fallback samples on. It carries no time: the main thread reads its own,
	// which is the timebase the frames are stamped against.
	| { type: "tick" }
	// The track ended; no more frames are coming.
	| { type: "done" }
	| { type: "error"; message: string };

// The slice of DedicatedWorkerGlobalScope we use; the DOM lib only types the window globals.
const scope = self as unknown as {
	postMessage(message: FromWorker, transfer?: Transferable[]): void;
	addEventListener(type: "message", listener: (event: MessageEvent<ToWorker>) => void): void;
};

let reader: ReadableStreamDefaultReader<VideoFrame> | undefined;
let source: MediaStreamTrack | undefined;
let ticker: ReturnType<typeof setInterval> | undefined;

scope.addEventListener("message", (event) => {
	void handle(event.data);
});

// Transferring the track detaches the main thread's copy, so report support before it sends one.
scope.postMessage({ type: "ready", supported: "MediaStreamTrackProcessor" in globalThis });

async function handle(msg: ToWorker): Promise<void> {
	try {
		switch (msg.type) {
			case "start":
				start(msg.track);
				return;
			case "pull":
				await pull();
				return;
			case "tick":
				tick(msg.period);
				return;
		}
	} catch (err) {
		stop();
		scope.postMessage({ type: "error", message: `${err}` });
	}
}

function start(track: MediaStreamTrack): void {
	source = track;

	// @ts-expect-error No typescript types yet.
	const processor = new MediaStreamTrackProcessor({ track });
	reader = (processor.readable as ReadableStream<VideoFrame>).getReader();
}

async function pull(): Promise<void> {
	if (!reader) throw new Error("not started");

	const { value } = await reader.read();
	const at = performance.timeOrigin + performance.now();

	if (!value) {
		stop();
		scope.postMessage({ type: "done" });
		return;
	}

	// Transferring detaches our handle, so the frame is the main thread's to close.
	scope.postMessage({ type: "frame", frame: value, at }, [value]);
}

function tick(period: number): void {
	if (!(period > 0)) throw new Error(`tick period must be positive: ${period}`);
	if (ticker !== undefined) throw new Error("already ticking");

	ticker = setInterval(() => scope.postMessage({ type: "tick" }), period);
}

function stop(): void {
	void reader?.cancel();
	reader = undefined;

	clearInterval(ticker);
	ticker = undefined;

	// We own the transferred clone, so release it rather than waiting on termination.
	source?.stop();
	source = undefined;
}

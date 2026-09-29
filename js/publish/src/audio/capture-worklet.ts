// The AudioWorklet globals this file runs against. Declared here rather than left to the tsconfig
// because `capture.ts` imports the message type below, which pulls this file into the type graph of
// every package that builds against the publish sources.
/// <reference types="audioworklet" />

/** One render quantum, positioned on the audio context's own sample clock. */
export interface Quantum {
	/** The context sample frame the quantum starts at, counted from the context's creation. */
	frame: number;

	/** One buffer per channel, all the same length. */
	channels: Float32Array[];
}

/** Stops a retired capture processor, which answers with {@link Stopped} once it has. */
export interface Close {
	type: "close";
}

/**
 * The processor has stopped, said in the quantum that ends it.
 *
 * Chromium keeps a closed context, and every node in it, for as long as a processor in it has not
 * stopped, and a processor only stops in a quantum it renders. So the page closes the context once
 * every processor in it has said this.
 */
export interface Stopped {
	type: "stopped";
}

class Capture extends AudioWorkletProcessor {
	#closed = false;

	constructor() {
		super();
		this.port.onmessage = (event: MessageEvent<Close>) => {
			if (event.data.type !== "close") return;
			this.#closed = true;
			this.port.onmessage = null;
		};
	}

	process(input: Float32Array[][]) {
		if (this.#closed) {
			// Chromium ends a processor that returned false at the first quantum its input is cut, without
			// calling it again, so it runs on until then to be the one that says it stopped.
			if (input[0]?.length) return true;
			const stopped: Stopped = { type: "stopped" };
			this.port.postMessage(stopped);
			this.port.close();
			return false;
		}
		if (input.length > 1) throw new Error("only one input is supported.");

		const channels = input[0];
		if (channels.length === 0) return true; // TODO: No input hooked up?

		// Report where the quantum sits on the context clock and let the main thread put it on the
		// wall clock; only it can pair the two (see capture.ts). Counting quanta here instead would
		// mean a timeline that starts whenever the first one happens to arrive.
		const msg: Quantum = {
			frame: currentFrame,
			channels,
		};

		this.port.postMessage(msg);
		return true;
	}
}

registerProcessor("capture", Capture);

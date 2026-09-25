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

class Capture extends AudioWorkletProcessor {
	process(input: Float32Array[][]) {
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

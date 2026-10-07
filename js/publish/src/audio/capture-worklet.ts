import { Time } from "@moq/net";
import type { AudioFrame } from "./capture";

/** Retires a capture processor, which answers with {@link Stopped} once it has stopped. */
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
	#sampleCount = 0;
	#zero: Time.Micro;
	#closed = false;

	constructor(options?: AudioWorkletNodeOptions) {
		super();
		this.#zero = (options?.processorOptions?.zero ?? 0) as Time.Micro;
		this.port.onmessage = (event: MessageEvent<Close>) => {
			if (event.data.type !== "close") return;
			this.#closed = true;
			this.port.onmessage = null;
		};
	}

	process(input: Float32Array[][]) {
		if (this.#closed) {
			// Chromium ends a processor that returned false at the first quantum its input is cut,
			// without calling it again, so it runs on until then to be the one that says it stopped.
			if (input[0]?.length) return true;
			const stopped: Stopped = { type: "stopped" };
			this.port.postMessage(stopped);
			this.port.close();
			return false;
		}
		if (input.length > 1) throw new Error("only one input is supported.");

		const channels = input[0];
		if (channels.length === 0) return true; // TODO: No input hooked up?

		// Convert sample count to microseconds, offset onto the shared wall clock.
		const timestamp = (Time.Micro.fromSecond((this.#sampleCount / sampleRate) as Time.Second) +
			this.#zero) as Time.Micro;

		const msg: AudioFrame = {
			timestamp,
			channels,
		};

		this.port.postMessage(msg);

		this.#sampleCount += channels[0].length;
		return true;
	}
}

registerProcessor("capture", Capture);

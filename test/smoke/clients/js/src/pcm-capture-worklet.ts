class Capture extends AudioWorkletProcessor {
	readonly #planes: Float32Array[];
	#offset = 0;
	#previousFrame: number | undefined;
	#staleFrames = 0;

	constructor(options: AudioWorkletNodeOptions) {
		super();
		const frames: number = options.processorOptions.frames;
		this.#planes = [new Float32Array(frames), new Float32Array(frames)];
	}

	process(inputs: Float32Array[][]): boolean {
		const input = inputs[0];
		const quantum = input[0]?.length ?? 128;
		if (this.#previousFrame !== undefined && currentFrame < this.#previousFrame + quantum) this.#staleFrames++;
		this.#previousFrame = currentFrame;
		const count = Math.min(quantum, this.#planes[0].length - this.#offset);
		for (let channel = 0; channel < this.#planes.length; channel++) {
			if (input[channel]) this.#planes[channel].set(input[channel].subarray(0, count), this.#offset);
		}
		this.#offset += count;
		if (this.#offset < this.#planes[0].length) return true;
		this.port.postMessage(
			{ planes: this.#planes, staleFrames: this.#staleFrames },
			this.#planes.map((plane) => plane.buffer),
		);
		return false;
	}
}

registerProcessor("pcm-capture", Capture);

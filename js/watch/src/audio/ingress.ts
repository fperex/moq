/** An ordered change to the worklet-owned audio timeline. */
export type Command =
	| { kind: "pcm"; timestamp: number; arrival: number; planes: Float32Array[] }
	| { kind: "reset" }
	| { kind: "truncate"; timestamp: number; end?: number }
	| { kind: "end"; timestamp: number }
	| { kind: "target"; mode: "auto" | "fixed" | "buffered" | "instant"; milliseconds: number };

const MODES: Array<Extract<Command, { kind: "target" }>["mode"]> = ["auto", "fixed", "buffered", "instant"];

const COMMAND_WRITE = 0;
const COMMAND_READ = 1;
const FRAME_WRITE = 2;
const FRAME_READ = 3;
const FIELDS = 4;

/** Shared storage passed to one producer and one consumer. */
export interface Init {
	channels: number;
	frameCapacity: number;
	commandCapacity: number;
	control: SharedArrayBuffer;
	descriptors: SharedArrayBuffer;
	samples: SharedArrayBuffer;
}

function capacity(value: number): number {
	if (!Number.isInteger(value) || value < 1 || value > 2 ** 30) throw new Error("invalid capacity");
	return 2 ** Math.ceil(Math.log2(value));
}

/** Allocate bounded descriptor and planar PCM queues. */
export function allocate(props: { channels: number; frameCapacity: number; commandCapacity: number }): Init {
	if (!Number.isInteger(props.channels) || props.channels < 1 || props.channels > 32) {
		throw new Error("invalid channels");
	}
	const frameCapacity = capacity(props.frameCapacity);
	const commandCapacity = capacity(props.commandCapacity);
	return {
		channels: props.channels,
		frameCapacity,
		commandCapacity,
		control: new SharedArrayBuffer(4 * Int32Array.BYTES_PER_ELEMENT),
		descriptors: new SharedArrayBuffer(commandCapacity * FIELDS * Float64Array.BYTES_PER_ELEMENT),
		samples: new SharedArrayBuffer(props.channels * frameCapacity * Float32Array.BYTES_PER_ELEMENT),
	};
}

function views(init: Init) {
	return {
		control: new Int32Array(init.control),
		descriptors: new Float64Array(init.descriptors),
		planes: Array.from(
			{ length: init.channels },
			(_, channel) =>
				new Float32Array(
					init.samples,
					channel * init.frameCapacity * Float32Array.BYTES_PER_ELEMENT,
					init.frameCapacity,
				),
		),
	};
}

/** Publish commands without overwriting unread data. Exactly one producer owns this queue. */
export class Producer {
	readonly #init: Init;
	readonly #views: ReturnType<typeof views>;

	constructor(init: Init) {
		this.#init = init;
		this.#views = views(init);
	}

	/** Free queue capacity observed by the sole producer; concurrent reads can only increase it. */
	get available(): { commands: number; frames: number } {
		const control = this.#views.control;
		return {
			commands:
				this.#init.commandCapacity -
				((Atomics.load(control, COMMAND_WRITE) - Atomics.load(control, COMMAND_READ)) >>> 0),
			frames:
				this.#init.frameCapacity -
				((Atomics.load(control, FRAME_WRITE) - Atomics.load(control, FRAME_READ)) >>> 0),
		};
	}

	/** Return false without changing storage when either queue is full. */
	push(command: Command): boolean {
		let kind: number;
		let timestamp = 0;
		let metadata = 0;
		let frames = 0;
		switch (command.kind) {
			case "pcm":
				kind = 0;
				timestamp = command.timestamp;
				metadata = command.arrival;
				if (!Number.isFinite(metadata)) throw new Error("invalid arrival");
				if (command.planes.length !== this.#init.channels) throw new Error("wrong channel count");
				frames = command.planes[0].length;
				if (frames > this.#init.frameCapacity) throw new Error("PCM frame exceeds ingress capacity");
				if (frames === 0 || command.planes.some((plane) => plane.length !== frames)) {
					throw new Error("invalid PCM plane lengths");
				}
				break;
			case "reset":
				kind = 1;
				break;
			case "truncate":
				kind = 2;
				timestamp = command.timestamp;
				if (command.end !== undefined && !Number.isFinite(command.end)) throw new Error("invalid endpoint");
				metadata = command.end ?? NaN;
				break;
			case "end":
				kind = 3;
				timestamp = command.timestamp;
				break;
			case "target":
				kind = 4;
				timestamp = command.milliseconds;
				metadata = MODES.indexOf(command.mode);
				if (metadata < 0) throw new Error("invalid mode");
				if (timestamp < 0) throw new Error("invalid target");
				break;
		}
		if (!Number.isFinite(timestamp)) throw new Error("invalid timestamp");

		const { control, descriptors, planes } = this.#views;
		const write = Atomics.load(control, COMMAND_WRITE);
		const read = Atomics.load(control, COMMAND_READ);
		const frameWrite = Atomics.load(control, FRAME_WRITE);
		const frameRead = Atomics.load(control, FRAME_READ);
		if ((write - read) >>> 0 >= this.#init.commandCapacity) return false;
		if (((frameWrite - frameRead) >>> 0) + frames > this.#init.frameCapacity) return false;

		if (command.kind === "pcm") {
			const start = frameWrite & (this.#init.frameCapacity - 1);
			const first = Math.min(frames, this.#init.frameCapacity - start);
			for (let channel = 0; channel < planes.length; channel++) {
				const source = command.planes[channel];
				planes[channel].set(first === frames ? source : source.subarray(0, first), start);
				if (first < frames) planes[channel].set(source.subarray(first), 0);
			}
		}
		const slot = (write & (this.#init.commandCapacity - 1)) * FIELDS;
		descriptors[slot] = kind;
		descriptors[slot + 1] = timestamp;
		descriptors[slot + 2] = frames;
		descriptors[slot + 3] = metadata;
		Atomics.store(control, FRAME_WRITE, frameWrite + frames);
		// This publication makes both the descriptor and its PCM visible to the consumer.
		Atomics.store(control, COMMAND_WRITE, write + 1);
		return true;
	}
}

/** Drain commands into local memory. Exactly one consumer owns this queue. */
export class Consumer {
	readonly #init: Init;
	readonly #views: ReturnType<typeof views>;

	constructor(init: Init) {
		this.#init = init;
		this.#views = views(init);
	}

	/** Count the commands published before this snapshot without releasing storage. */
	get length(): number {
		const control = this.#views.control;
		return (Atomics.load(control, COMMAND_WRITE) - Atomics.load(control, COMMAND_READ)) >>> 0;
	}

	/** Copy the next command and release its shared storage. */
	shift(): Command | undefined {
		const { control, descriptors, planes } = this.#views;
		const read = Atomics.load(control, COMMAND_READ);
		if (read === Atomics.load(control, COMMAND_WRITE)) return;
		const slot = (read & (this.#init.commandCapacity - 1)) * FIELDS;
		const timestamp = descriptors[slot + 1];
		let command: Command;
		switch (descriptors[slot]) {
			case 0: {
				const frames = descriptors[slot + 2];
				const frameRead = Atomics.load(control, FRAME_READ);
				const start = frameRead & (this.#init.frameCapacity - 1);
				const first = Math.min(frames, this.#init.frameCapacity - start);
				const copied = planes.map((plane) => {
					const output = new Float32Array(frames);
					output.set(plane.subarray(start, start + first));
					if (first < frames) output.set(plane.subarray(0, frames - first), first);
					return output;
				});
				command = { kind: "pcm", timestamp, arrival: descriptors[slot + 3], planes: copied };
				Atomics.store(control, FRAME_READ, frameRead + frames);
				break;
			}
			case 1:
				command = { kind: "reset" };
				break;
			case 2:
				command = Number.isNaN(descriptors[slot + 3])
					? { kind: "truncate", timestamp }
					: { kind: "truncate", timestamp, end: descriptors[slot + 3] };
				break;
			case 3:
				command = { kind: "end", timestamp };
				break;
			case 4: {
				const mode = MODES[descriptors[slot + 3]];
				if (mode === undefined) throw new Error("invalid ingress mode");
				command = { kind: "target", mode, milliseconds: timestamp };
				break;
			}
			default:
				throw new Error("invalid ingress command");
		}
		Atomics.store(control, COMMAND_READ, read + 1);
		return command;
	}
}

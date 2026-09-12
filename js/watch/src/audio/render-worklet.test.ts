import { describe, expect, test } from "bun:test";
import { allocate, type Command, Producer } from "./ingress";
import type { Message, ToMain } from "./render";

class Port {
	onmessage?: (event: { data: Message }) => void;
	readonly messages: ToMain[] = [];
	postMessage(message: ToMain) {
		this.messages.push(message);
	}
}

class Processor {
	readonly port = new Port();
}

type Worklet = Processor & { process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean };
let Render: (new () => Worklet) | undefined;
const globals = ["AudioWorkletProcessor", "registerProcessor"];
const descriptors = globals.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
Object.assign(globalThis, {
	AudioWorkletProcessor: Processor,
	registerProcessor(_name: string, processor: new () => Worklet) {
		Render = processor;
	},
});
try {
	await import("./render-worklet");
} finally {
	for (const [index, key] of globals.entries()) {
		const descriptor = descriptors[index];
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
}

function create(rate: number, shared: boolean, quantum = 128) {
	if (!Render) throw new Error("render processor was not registered");
	const worklet = new Render();
	const init = shared ? allocate({ channels: 1, commandCapacity: 256, frameCapacity: rate * 2 }) : undefined;
	const producer = init ? new Producer(init) : undefined;
	worklet.port.onmessage?.({
		data: {
			type: "init",
			rate,
			channels: 1,
			policy: { kind: "target", mode: "buffered", milliseconds: 0 },
			shared: init,
		},
	});
	let frame = 0;
	return {
		worklet,
		push(command: Command) {
			if (producer) expect(producer.push(command)).toBe(true);
			else worklet.port.onmessage?.({ data: { type: "command", command } });
		},
		render() {
			const rateDescriptor = Object.getOwnPropertyDescriptor(globalThis, "sampleRate");
			const frameDescriptor = Object.getOwnPropertyDescriptor(globalThis, "currentFrame");
			Object.assign(globalThis, { sampleRate: rate, currentFrame: frame });
			const output = new Float32Array(quantum);
			try {
				expect(worklet.process([], [[output]])).toBe(true);
				frame += quantum;
				return output;
			} finally {
				if (rateDescriptor) Object.defineProperty(globalThis, "sampleRate", rateDescriptor);
				else Reflect.deleteProperty(globalThis, "sampleRate");
				if (frameDescriptor) Object.defineProperty(globalThis, "currentFrame", frameDescriptor);
				else Reflect.deleteProperty(globalThis, "currentFrame");
			}
		},
		get remaining() {
			if (init && producer) return init.frameCapacity - producer.available.frames;
			return undefined;
		},
	};
}

for (const shared of [false, true])
	for (const rate of [44100, 48000, 96000])
		describe(`${shared ? "shared" : "posted"} ${rate} Hz command scheduling`, () => {
			test("plays a fully queued quantum split into one-sample packets before its endpoint", () => {
				const player = create(rate, shared);
				for (let i = 0; i < 128; i++)
					player.push({
						kind: "pcm",
						timestamp: (i * 1e6) / rate,
						arrival: 0,
						planes: [new Float32Array([0.25])],
					});
				player.push({ kind: "end", timestamp: 128e6 / rate });
				expect(Array.from(player.render())).toEqual(Array(128).fill(0.25));
				for (let i = 0; i < 4; i++) expect(Array.from(player.render())).toEqual(Array(128).fill(0));
				const state = player.worklet.port.messages.findLast((message) => message.type === "state");
				expect(state?.stats.consumed).toBe(128);
				expect(state?.stats.concealed).toBe(0);
				expect(state?.stats.late).toBe(0);
			});

			test("drains all descriptor slots without losing small PCM before the following endpoint", () => {
				const player = create(rate, shared);
				for (let i = 0; i < 256; i++)
					player.push({
						kind: "pcm",
						timestamp: (i * 1e6) / rate,
						arrival: 0,
						planes: [new Float32Array([0.5])],
					});
				expect(Array.from(player.render())).toEqual(Array(128).fill(0.5));
				player.push({ kind: "end", timestamp: 256e6 / rate });
				expect(Array.from(player.render())).toEqual(Array(128).fill(0.5));
				expect(Array.from(player.render())).toEqual(Array(128).fill(0));
			});

			test("applies queued endpoint and reset before rendering the next utterance", () => {
				const player = create(rate, shared);
				const count = Math.ceil(rate * 0.02);
				player.push({ kind: "pcm", timestamp: 0, arrival: 0, planes: [new Float32Array(count).fill(0.25)] });
				player.push({ kind: "end", timestamp: (count * 1e6) / rate });
				player.push({ kind: "reset" });
				player.push({ kind: "pcm", timestamp: 0, arrival: 0, planes: [new Float32Array(count).fill(0.75)] });
				player.push({ kind: "end", timestamp: (count * 1e6) / rate });
				expect(Array.from(player.render())).toEqual(Array(128).fill(0.75));
				if (shared) expect(player.remaining).toBe(0);
				expect(Array.from(player.render())).toEqual(Array(128).fill(0.75));
			});

			for (const boundary of ["reset", "truncate"] as const)
				test(`applies ${boundary} after a fragmented 120ms utterance before any obsolete samples play`, () => {
					const player = create(rate, shared);
					const length = Math.floor(rate * 0.04);
					for (let i = 0; i < 3; i++)
						player.push({
							kind: "pcm",
							timestamp: i * 40000,
							arrival: 0,
							planes: [new Float32Array(length).fill(-0.5)],
						});
					player.push(boundary === "reset" ? { kind: "reset" } : { kind: "truncate", timestamp: 0 });
					for (let i = 0; i < 3; i++)
						player.push({
							kind: "pcm",
							timestamp: i * 40000,
							arrival: 1,
							planes: [new Float32Array(length).fill(0.5)],
						});
					expect(Array.from(player.render())).toEqual(Array(128).fill(0.5));
					if (shared) expect(player.remaining).toBe(0);
				});

			test("observes an endpoint behind fragmented PCM before rendering", () => {
				const player = create(rate, shared);
				const length = Math.floor(rate * 0.04);
				for (let i = 0; i < 3; i++)
					player.push({
						kind: "pcm",
						timestamp: i * 40000,
						arrival: 0,
						planes: [new Float32Array(length).fill(-0.5)],
					});
				player.push({ kind: "end", timestamp: 0 });
				expect(Array.from(player.render())).toEqual(Array(128).fill(0));
			});

			test("admits already queued nearby PCM behind a far-future packet before its playout time", () => {
				const player = create(rate, shared);
				player.push({ kind: "pcm", timestamp: 0, arrival: 0, planes: [new Float32Array(128).fill(0.25)] });
				player.push({
					kind: "pcm",
					timestamp: 5e6,
					arrival: 1,
					planes: [new Float32Array(Math.floor(rate * 0.04)).fill(0.5)],
				});
				player.push({
					kind: "pcm",
					timestamp: 128e6 / rate,
					arrival: 2,
					planes: [new Float32Array(128).fill(0.75)],
				});
				expect(Array.from(player.render())).toEqual(Array(128).fill(0.25));
				expect(Array.from(player.render())).toEqual(Array(128).fill(0.75));
			});

			test("renders both queued halves of a variable output quantum", () => {
				const quantum = Math.ceil(rate * 0.04);
				const player = create(rate, shared, quantum);
				const half = Math.floor(quantum / 2);
				player.push({ kind: "pcm", timestamp: 0, arrival: 0, planes: [new Float32Array(half).fill(0.125)] });
				player.push({
					kind: "pcm",
					timestamp: (half * 1e6) / rate,
					arrival: 0,
					planes: [new Float32Array(quantum - half).fill(0.125)],
				});
				player.push({ kind: "end", timestamp: (quantum * 1e6) / rate });
				expect(Array.from(player.render())).toEqual(Array(quantum).fill(0.125));
			});
		});

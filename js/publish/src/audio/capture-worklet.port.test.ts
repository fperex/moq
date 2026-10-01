import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Quantum } from "./capture-worklet";

const QUANTUM = 128;

interface Processor {
	process(inputs: Float32Array[][]): boolean;
}

type ProcessorClass = new () => Processor;

const scope = globalThis as unknown as Record<string, unknown>;
const saved = new Map<string, unknown>();
let Capture: ProcessorClass | undefined;
let nextPort: MessagePort | undefined;

beforeAll(async () => {
	for (const name of ["AudioWorkletProcessor", "registerProcessor", "currentFrame"]) {
		saved.set(name, scope[name]);
	}
	scope.AudioWorkletProcessor = class {
		readonly port = nextPort;
	};
	scope.registerProcessor = (name: string, processor: ProcessorClass) => {
		if (name === "capture") Capture = processor;
	};
	scope.currentFrame = 0;
	const worklet = "./capture-worklet.ts?ports";
	await import(worklet);
});

afterAll(() => {
	for (const [name, value] of saved) {
		if (value === undefined) delete scope[name];
		else scope[name] = value;
	}
});

// Chromium keeps a closed context, and every node in it, for as long as one of its processors has not
// stopped, so the page closes the context only once the processor says it has. A processor with a
// connected input is not stopped by returning false: Chromium ends it at the next quantum after the
// input is cut, without calling it again, so a processor that stopped while still fed would never
// get to say so.
test("ends its processor once the capture node is closed and cut from its input, and says so", async () => {
	if (!Capture) throw new Error("capture-worklet.ts registered no 'capture' processor");

	const node = new MessageChannel();
	nextPort = node.port1;
	const capture = new Capture();
	try {
		const quantum = new Promise<Quantum>((resolve) => {
			node.port2.onmessage = (event: MessageEvent<Quantum>) => resolve(event.data);
		});
		expect(capture.process([[new Float32Array(QUANTUM)]])).toBe(true);
		expect(await quantum).toEqual({ frame: 0, channels: [new Float32Array(QUANTUM)] });

		const receive = node.port1.onmessage;
		if (!receive) throw new Error("capture registered no message handler");
		const closed = new Promise<void>((resolve) => {
			node.port1.onmessage = (event) => {
				receive.call(node.port1, event);
				resolve();
			};
		});
		node.port2.postMessage({ type: "close" });
		await closed;

		// Closed but still fed: it runs on, capturing nothing.
		const next = new Promise<unknown>((resolve) => {
			node.port2.onmessage = (event: MessageEvent<unknown>) => resolve(event.data);
		});
		scope.currentFrame = QUANTUM;
		expect(capture.process([[new Float32Array(QUANTUM)]])).toBe(true);

		// Cut from its input: it stops, and says so in the same quantum.
		scope.currentFrame = 2 * QUANTUM;
		expect(capture.process([[]])).toBe(false);
		expect(await next).toEqual({ type: "stopped" });
	} finally {
		node.port1.close();
		node.port2.close();
	}
});

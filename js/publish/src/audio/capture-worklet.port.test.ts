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

function settle(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 20));
}

test("lets its processor end once the capture node is closed", async () => {
	if (!Capture) throw new Error("capture-worklet.ts registered no 'capture' processor");

	const node = new MessageChannel();
	nextPort = node.port1;
	const capture = new Capture();
	const messages: Quantum[] = [];
	node.port2.onmessage = (event: MessageEvent<Quantum>) => messages.push(event.data);

	expect(capture.process([[new Float32Array(QUANTUM)]])).toBe(true);
	await settle();
	expect(messages).toHaveLength(1);

	node.port2.postMessage({ type: "close" });
	await settle();
	scope.currentFrame = QUANTUM;
	expect(capture.process([[new Float32Array(QUANTUM)]])).toBe(false);
	await settle();
	expect(messages).toHaveLength(1);

	node.port2.close();
});

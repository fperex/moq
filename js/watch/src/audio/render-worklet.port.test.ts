import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { Time } from "@moq/net";
import type { Data, InitPost, Message, Port, State, ToMain } from "./render";

// The render worklet itself, loaded into a stand-in for its global scope: `AudioWorkletProcessor`
// hands each processor the port the test gives it, `registerProcessor` captures the class, and
// `currentFrame` advances a quantum per `process` call. Everything past that is the real module.

const RATE = 48000;
const QUANTUM = 128;

interface Processor {
	process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean;
}

type ProcessorClass = new () => Processor;

const scope = globalThis as unknown as Record<string, unknown>;
const saved = new Map<string, unknown>();
let Render: ProcessorClass | undefined;
let nextPort: MessagePort | undefined;

beforeAll(async () => {
	for (const name of ["AudioWorkletProcessor", "registerProcessor", "currentFrame", "sampleRate"]) {
		saved.set(name, scope[name]);
	}
	scope.AudioWorkletProcessor = class {
		readonly port = nextPort;
	};
	scope.registerProcessor = (name: string, processor: ProcessorClass) => {
		if (name === "render") Render = processor;
	};
	scope.currentFrame = 0;
	scope.sampleRate = RATE;
	// A module instance of our own: the test runner shares its registry across files, and another file
	// may already have loaded the worklet against its own stand-ins. The query makes Bun evaluate it
	// again; a variable specifier keeps the type checker from resolving the query as a path.
	const worklet = "./render-worklet.ts?ports";
	await import(worklet);
});

afterAll(() => {
	for (const [name, value] of saved) {
		if (value === undefined) delete scope[name];
		else scope[name] = value;
	}
});

/** Let every message already posted land. */
function settle(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 20));
}

/** Pull `quanta` render quanta and return everything they output, mono. */
function pull(render: Processor, quanta: number): Float32Array {
	const out = new Float32Array(quanta * QUANTUM);
	for (let i = 0; i < quanta; i++) {
		const block = new Float32Array(QUANTUM);
		render.process([], [[block]], {});
		out.set(block, i * QUANTUM);
		scope.currentFrame = (scope.currentFrame as number) + QUANTUM;
	}
	return out;
}

describe("render worklet ports", () => {
	it("takes ring writes from a port handed to it, and reports state on both", async () => {
		if (!Render) throw new Error("render-worklet.ts registered no 'render' processor");

		// The node's own port: the page's end and the worklet's end.
		const node = new MessageChannel();
		nextPort = node.port1;
		const render = new Render();

		// A second channel, as the page builds for a worker: one end to the worklet through the node's
		// port, the other to the writer.
		const extra = new MessageChannel();
		const handoff: Port = { type: "port", port: extra.port1 };
		node.port2.postMessage(handoff, [extra.port1]);
		await settle();

		const page: State[] = [];
		const writer: State[] = [];
		node.port2.onmessage = (event: MessageEvent<State>) => page.push(event.data);
		extra.port2.onmessage = (event: MessageEvent<State>) => writer.push(event.data);

		// Everything from here on arrives over the writer's port only.
		const init: InitPost = {
			type: "init-post",
			channels: 1,
			rate: RATE,
			latency: Time.Milli(20),
			buffered: false,
			conceal: false,
		};
		extra.port2.postMessage(init);
		const chunk = (RATE * 20) / 1000;
		for (let i = 0; i < 10; i++) {
			const samples = new Float32Array(chunk).fill(0.25);
			const data: Data = {
				type: "data",
				data: [samples],
				timestamp: Time.Micro.fromMilli(Time.Milli(i * 20)),
			};
			extra.port2.postMessage(data, [samples.buffer]);
		}
		await settle();

		// 40 quanta is about 107 ms: past the fill, well inside the 200 ms written.
		const played = pull(render, 40);
		const loudest = played.reduce((max, v) => Math.max(max, Math.abs(v)), 0);
		expect(loudest).toBeGreaterThan(0.2);

		await settle();
		// A state message every five quanta, to the node's port as always and to the writer's.
		expect(page.length).toBeGreaterThanOrEqual(7);
		expect(writer.length).toBe(page.length);
		const last = writer[writer.length - 1];
		expect(last.type).toBe("state");
		expect(last.debug.output).toBeGreaterThan(0);
		expect(page[page.length - 1]).toEqual(last);

		node.port2.close();
		extra.port2.close();
	});

	it("says once, on every port it holds, that a message could not be deserialized", async () => {
		if (!Render) throw new Error("render-worklet.ts registered no 'render' processor");

		const node = new MessageChannel();
		nextPort = node.port1;
		new Render();

		// The worklet's own end of the port it is handed, as its listener receives it.
		const received: MessagePort[] = [];
		node.port1.addEventListener("message", (event: MessageEvent<Message>) => {
			if (event.data.type === "port") received.push(event.data.port);
		});
		const extra = new MessageChannel();
		const handoff: Port = { type: "port", port: extra.port1 };
		node.port2.postMessage(handoff, [extra.port1]);
		await settle();
		const [handed] = received;
		if (!handed) throw new Error("the worklet was handed no port");

		const page: ToMain[] = [];
		const writer: ToMain[] = [];
		node.port2.onmessage = (event: MessageEvent<ToMain>) => page.push(event.data);
		extra.port2.onmessage = (event: MessageEvent<ToMain>) => writer.push(event.data);

		// What a browser fires in place of a message it could not deserialize: on the port a worker
		// writes the ring over, then on the node's own.
		const errors: unknown[][] = [];
		const error = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
			errors.push(args);
		});
		try {
			handed.dispatchEvent(new MessageEvent("messageerror"));
			node.port1.dispatchEvent(new MessageEvent("messageerror"));
			await settle();
		} finally {
			error.mockRestore();
		}

		expect(page).toEqual([{ type: "unreadable" }]);
		expect(writer).toEqual([{ type: "unreadable" }]);
		expect(errors).toEqual([["[audio] the render worklet could not deserialize a message sent to it"]]);

		node.port2.close();
		extra.port2.close();
	});
});

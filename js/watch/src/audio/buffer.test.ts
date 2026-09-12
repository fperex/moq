import { expect, test } from "bun:test";
import { Worker } from "node:worker_threads";

const runner = `
const { parentPort, workerData, MessageChannel } = require("node:worker_threads");
(async () => {
  const { rate, shared, boundary } = workerData;
  class Context extends EventTarget {
    state = "suspended";
    currentTime = 0;
    baseLatency = 0;
    outputLatency = 0;
  }
  const { port1: main, port2: render } = new MessageChannel();
  let Processor;
  Object.assign(globalThis, {
    AudioContext: Context,
    AudioWorkletProcessor: class { port = render; },
    registerProcessor(_name, processor) { Processor = processor; },
    sampleRate: rate, currentFrame: 0, crossOriginIsolated: shared,
  });
  await import(workerData.render);
  const { AudioBuffer } = await import(workerData.buffer);
  const processor = new Processor(), context = new Context();
  const states = [], errors = [];
  main.addEventListener("message", event => {
    if (event.data.type === "state") states.push(event.data);
    if (event.data.type === "error") errors.push(event.data.message);
  });
  const buffer = new AudioBuffer({ worklet: { port: main, context }, rate, channels: 1,
    policy: { kind: "target", mode: "buffered", milliseconds: 0 } });
  buffer.insert(0, [new Float32Array(rate * 3).fill(-0.5)]);
  let expectedNegative = rate * 3, expectedPositive = 0;
  if (boundary === "reset" || boundary === "twice" || boundary === "truncate") {
    if (boundary === "truncate") buffer.truncate(0);
    else buffer.reset();
    if (boundary === "twice") {
      buffer.configure({ kind: "target", mode: "fixed", milliseconds: 50 });
      buffer.insert(0, [new Float32Array(Math.round(rate * 0.12)).fill(-0.25)]);
      buffer.reset();
      buffer.configure({ kind: "target", mode: "buffered", milliseconds: 0 });
    }
    buffer.insert(0, [new Float32Array(Math.round(rate * 0.12)).fill(0.5)]);
    buffer.end(120000);
    expectedNegative = 0; expectedPositive = Math.round(rate * 0.12);
  } else if (boundary === "end-zero") {
    buffer.end(0); expectedNegative = 0;
  } else if (boundary === "end-partial") {
    buffer.end(2500000); expectedNegative = Math.round(rate * 2.5);
  } else buffer.end(3000000);
  context.state = "running";
  context.dispatchEvent(new Event("statechange"));
  let negative = 0, positive = 0, unexpected = 0;
  try {
    for (let frame = 0; frame < rate * 4; frame += 128) {
      await new Promise(resolve => setImmediate(resolve));
      Reflect.set(globalThis, "currentFrame", frame);
      context.currentTime = frame / rate;
      const output = new Float32Array(128);
      processor.process([], [[output]]);
      for (const sample of output) {
        if (sample === -0.5) negative++;
        else if (sample === 0.5) positive++;
        else if (sample !== 0) unexpected++;
      }
    }
    await new Promise(resolve => setImmediate(resolve));
    const monotonic = states.every((state, index) => Number.isSafeInteger(state.acceptedFrames) &&
      (index === 0 || state.acceptedFrames >= states[index - 1].acceptedFrames));
    parentPort.postMessage({ negative, positive, unexpected, expectedNegative, expectedPositive,
      errors, monotonic, maximumHeld: Math.max(...states.map(state => state.stats.queueSamples)),
      finalEpoch: states.at(-1)?.epoch, finalQueue: states.at(-1)?.stats.queueSamples,
      concealed: states.at(-1)?.stats.concealed });
  } finally { buffer.close(); main.close(); render.close(); }
})().catch(error => { throw error; });
`;

for (const rate of [44100, 48000, 96000])
	for (const shared of [false, true])
		for (const boundary of ["finite", "reset", "twice", "truncate", "end-zero", "end-partial"])
			test(`${shared ? "shared" : "posted"} ${rate} Hz large decoded frame: ${boundary}`, async () => {
				const worker = new Worker(runner, {
					eval: true,
					workerData: {
						rate,
						shared,
						boundary,
						buffer: new URL("./buffer.ts", import.meta.url).href,
						render: new URL("./render-worklet.ts", import.meta.url).href,
					},
				});
				try {
					const result = await new Promise<{
						negative: number;
						positive: number;
						unexpected: number;
						expectedNegative: number;
						expectedPositive: number;
						errors: string[];
						monotonic: boolean;
						maximumHeld: number;
						finalEpoch: number;
						finalQueue: number;
						concealed: number;
					}>((resolve, reject) => {
						worker.on("message", resolve);
						worker.on("error", reject);
						worker.on("exit", (code) => {
							if (code !== 0) reject(new Error(`audio worker exited ${code}`));
						});
					});
					expect(result.negative).toBe(result.expectedNegative);
					expect(result.positive).toBe(result.expectedPositive);
					expect(result.unexpected).toBe(0);
					expect(result.errors).toEqual([]);
					expect(result.monotonic).toBe(true);
					expect(result.maximumHeld).toBeLessThanOrEqual(rate * 2);
					expect(result.finalEpoch).toBe(boundary === "twice" ? 2 : boundary === "reset" ? 1 : 0);
					expect(result.finalQueue).toBe(0);
					expect(result.concealed).toBe(0);
				} finally {
					await worker.terminate();
				}
			}, 15000);

import { describe, expect, it } from "bun:test";
import { Worker } from "node:worker_threads";
import { allocate, type Command, Consumer, Producer } from "./ingress";

function queue(frameCapacity = 4, commandCapacity = 4) {
	const init = allocate({ channels: 2, frameCapacity, commandCapacity });
	return { init, producer: new Producer(init), consumer: new Consumer(init) };
}

function pcm(timestamp: number, left: number[], right: number[]): Command {
	return { kind: "pcm", timestamp, arrival: 12.75, planes: [new Float32Array(left), new Float32Array(right)] };
}

describe("ordered shared ingress", () => {
	it("counts a published batch without releasing or changing queued samples", () => {
		const { init, producer, consumer } = queue(4, 2);
		expect(consumer.length).toBe(0);
		expect(producer.push(pcm(123, [1, 2, 3], [4, 5, 6]))).toBe(true);
		expect(producer.push({ kind: "end", timestamp: 999 })).toBe(true);
		const before = [init.control, init.descriptors, init.samples].map((buffer) =>
			Array.from(new Uint8Array(buffer)),
		);
		expect(consumer.length).toBe(2);
		expect(consumer.length).toBe(2);
		expect(producer.available).toEqual({ commands: 0, frames: 1 });
		expect(
			[init.control, init.descriptors, init.samples].map((buffer) => Array.from(new Uint8Array(buffer))),
		).toEqual(before);
		expect(consumer.shift()).toEqual(pcm(123, [1, 2, 3], [4, 5, 6]));
		expect(consumer.length).toBe(1);
		expect(consumer.shift()).toEqual({ kind: "end", timestamp: 999 });
		expect(consumer.length).toBe(0);
	});

	it("keeps reset and every control between their surrounding PCM", () => {
		const { producer, consumer } = queue(8, 8);
		expect(consumer.shift()).toBeUndefined();
		expect(producer.push(pcm(1000, [1, 2], [3, 4]))).toBe(true);
		expect(producer.push({ kind: "reset" })).toBe(true);
		expect(producer.push({ kind: "truncate", timestamp: 250 })).toBe(true);
		expect(producer.push({ kind: "target", mode: "auto", milliseconds: 35 })).toBe(true);
		expect(producer.push(pcm(250, [5, 6], [7, 8]))).toBe(true);
		expect(producer.push({ kind: "end", timestamp: 300 })).toBe(true);
		expect(consumer.shift()).toEqual(pcm(1000, [1, 2], [3, 4]));
		expect(consumer.shift()).toEqual({ kind: "reset" });
		expect(consumer.shift()).toEqual({ kind: "truncate", timestamp: 250 });
		expect(consumer.shift()).toEqual({ kind: "target", mode: "auto", milliseconds: 35 });
		expect(consumer.shift()).toEqual(pcm(250, [5, 6], [7, 8]));
		expect(consumer.shift()).toEqual({ kind: "end", timestamp: 300 });
		expect(consumer.shift()).toBeUndefined();
	});

	it("refuses PCM overflow without changing any shared storage", () => {
		const { init, producer, consumer } = queue();
		expect(producer.push(pcm(0, [1, 2, 3], [4, 5, 6]))).toBe(true);
		const before = [init.control, init.descriptors, init.samples].map((buffer) =>
			Array.from(new Uint8Array(buffer)),
		);
		expect(producer.push(pcm(3, [9, 10], [11, 12]))).toBe(false);
		const after = [init.control, init.descriptors, init.samples].map((buffer) =>
			Array.from(new Uint8Array(buffer)),
		);
		expect(after).toEqual(before);
		expect(producer.push({ kind: "reset" })).toBe(true);
		expect(consumer.shift()).toEqual(pcm(0, [1, 2, 3], [4, 5, 6]));
		expect(consumer.shift()).toEqual({ kind: "reset" });
		expect(producer.push(pcm(3, [9, 10], [11, 12]))).toBe(true);
		expect(consumer.shift()).toEqual(pcm(3, [9, 10], [11, 12]));
	});

	it("rejects a frame that can never fit instead of reporting temporary backpressure", () => {
		const { init, producer, consumer } = queue(4, 4);
		const before = [init.control, init.descriptors, init.samples].map((buffer) =>
			Array.from(new Uint8Array(buffer)),
		);
		expect(() => producer.push(pcm(0, [1, 2, 3, 4, 5], [6, 7, 8, 9, 10]))).toThrow(
			"PCM frame exceeds ingress capacity",
		);
		expect(
			[init.control, init.descriptors, init.samples].map((buffer) => Array.from(new Uint8Array(buffer))),
		).toEqual(before);
		expect(producer.available).toEqual({ commands: 4, frames: 4 });
		expect(consumer.shift()).toBeUndefined();
	});

	it("refuses descriptor overflow even when PCM space is available", () => {
		const { init, producer, consumer } = queue(4, 1);
		expect(producer.push({ kind: "target", mode: "fixed", milliseconds: 20 })).toBe(true);
		const before = [init.control, init.descriptors, init.samples].map((buffer) =>
			Array.from(new Uint8Array(buffer)),
		);
		expect(producer.push(pcm(0, [1], [2]))).toBe(false);
		expect(
			[init.control, init.descriptors, init.samples].map((buffer) => Array.from(new Uint8Array(buffer))),
		).toEqual(before);
		expect(consumer.shift()).toEqual({ kind: "target", mode: "fixed", milliseconds: 20 });
		expect(producer.push(pcm(0, [1], [2]))).toBe(true);
		expect(consumer.shift()).toEqual(pcm(0, [1], [2]));
	});

	for (const cursor of [0, 0x7ffffffe, -2]) {
		it(`preserves planar PCM across slot and counter wrap starting at ${cursor}`, () => {
			const { init, producer, consumer } = queue();
			// Seed an empty queue near each counter boundary without billions of operations.
			new Int32Array(init.control).fill(cursor);
			for (let iteration = 0; iteration < 8; iteration++) {
				expect(producer.push(pcm(iteration, [1, 2, 3], [4, 5, 6]))).toBe(true);
				expect(producer.push({ kind: "reset" })).toBe(true);
				expect(producer.push(pcm(iteration + 1, [7], [8]))).toBe(true);
				expect(producer.push(pcm(999, [9], [10]))).toBe(false);
				expect(consumer.shift()).toEqual(pcm(iteration, [1, 2, 3], [4, 5, 6]));
				expect(consumer.shift()).toEqual({ kind: "reset" });
				expect(consumer.shift()).toEqual(pcm(iteration + 1, [7], [8]));
				expect(consumer.shift()).toBeUndefined();
			}
		});
	}

	it("copies at both boundaries so reused buffers cannot alter delivered PCM", () => {
		const { producer, consumer } = queue();
		const planes = [new Float32Array([1, 2, 3, 4]), new Float32Array([5, 6, 7, 8])];
		expect(producer.push({ kind: "pcm", timestamp: 0, arrival: 12.75, planes })).toBe(true);
		planes[0].fill(99);
		const output = consumer.shift();
		expect(output).toEqual(pcm(0, [1, 2, 3, 4], [5, 6, 7, 8]));
		expect(producer.push(pcm(4, [9, 10, 11, 12], [13, 14, 15, 16]))).toBe(true);
		expect(output).toEqual(pcm(0, [1, 2, 3, 4], [5, 6, 7, 8]));
		expect(consumer.shift()).toEqual(pcm(4, [9, 10, 11, 12], [13, 14, 15, 16]));
	});

	it("rejects invalid input and accepts rounded capacities", () => {
		expect(() => allocate({ channels: 0, frameCapacity: 4, commandCapacity: 4 })).toThrow("invalid channels");
		expect(() => allocate({ channels: 1, frameCapacity: 0, commandCapacity: 4 })).toThrow("invalid capacity");
		const { init, producer, consumer } = queue(3, 3);
		expect(init.frameCapacity).toBe(4);
		expect(init.commandCapacity).toBe(4);
		expect(() => producer.push(pcm(0, [1, 2], [3]))).toThrow("invalid PCM plane lengths");
		expect(() => producer.push(pcm(Number.NaN, [1], [2]))).toThrow("invalid timestamp");
		expect(() => producer.push({ kind: "target", mode: "fixed", milliseconds: -1 })).toThrow("invalid target");
		expect(consumer.shift()).toBeUndefined();
		expect(producer.push(pcm(0, [1], [2]))).toBe(true);
		expect(consumer.shift()).toEqual(pcm(0, [1], [2]));
	});

	it("orders buffered and instant mode changes without resetting the queue", () => {
		const { producer, consumer } = queue();
		expect(producer.push({ kind: "target", mode: "buffered", milliseconds: 100 })).toBe(true);
		expect(producer.push(pcm(500, [1], [2]))).toBe(true);
		expect(producer.push({ kind: "target", mode: "instant", milliseconds: 0 })).toBe(true);
		expect(consumer.shift()).toEqual({ kind: "target", mode: "buffered", milliseconds: 100 });
		expect(consumer.shift()).toEqual(pcm(500, [1], [2]));
		expect(consumer.shift()).toEqual({ kind: "target", mode: "instant", milliseconds: 0 });
	});

	it("reports descriptor and PCM capacity independently as the consumer releases them", () => {
		const { producer, consumer } = queue(4, 2);
		expect(producer.available).toEqual({ commands: 2, frames: 4 });
		expect(producer.push(pcm(0, [1, 2, 3], [4, 5, 6]))).toBe(true);
		expect(producer.available).toEqual({ commands: 1, frames: 1 });
		expect(producer.push({ kind: "reset" })).toBe(true);
		expect(producer.available).toEqual({ commands: 0, frames: 1 });
		expect(consumer.shift()).toEqual(pcm(0, [1, 2, 3], [4, 5, 6]));
		expect(producer.available).toEqual({ commands: 1, frames: 4 });
		expect(consumer.shift()).toEqual({ kind: "reset" });
		expect(producer.available).toEqual({ commands: 2, frames: 4 });
	});

	it("preserves PCM and control order while a real worker drains across counter rollover", async () => {
		const { init, producer } = queue(8, 8);
		new Int32Array(init.control).set([-5, -5, 0x7ffffffd, 0x7ffffffd]);
		const commands: Command[] = [];
		for (let cycle = 0; cycle < 4096; cycle++) {
			commands.push(
				{
					kind: "pcm",
					timestamp: cycle * 10 + 0.5,
					arrival: cycle + 0.125,
					planes: [new Float32Array([cycle + 0.25, -cycle - 0.5, 0]), new Float32Array([10, 20, 30])],
				},
				{ kind: "reset" },
				{ kind: "truncate", timestamp: cycle * 10 + 2 },
				{ kind: "target", mode: cycle % 2 ? "auto" : "fixed", milliseconds: cycle % 100 },
				{
					kind: "pcm",
					timestamp: cycle * 10 + 3.5,
					arrival: cycle + 0.875,
					planes: [new Float32Array([42]), new Float32Array([-42])],
				},
				{ kind: "end", timestamp: cycle * 10 + 4.5 },
			);
		}
		let sent = 0;
		while (producer.push(commands[sent])) sent++;
		expect(sent).toBe(8);
		expect(producer.available.commands).toBe(0);

		const worker = new Worker(
			`
			const { parentPort, workerData } = require("node:worker_threads");
			const { deepStrictEqual, strictEqual } = require("node:assert");
			(async () => {
				const { Consumer } = await import(workerData.module);
				const consumer = new Consumer(workerData.init);
				let received = 0;
				function drain() {
					let command;
					while ((command = consumer.shift()) !== undefined) {
						const cycle = Math.floor(received / 6);
						switch (received % 6) {
							case 0:
								deepStrictEqual(command, {
									kind: "pcm", timestamp: cycle * 10 + 0.5, arrival: cycle + 0.125,
									planes: [new Float32Array([cycle + 0.25, -cycle - 0.5, 0]), new Float32Array([10, 20, 30])],
								});
								break;
							case 1: deepStrictEqual(command, { kind: "reset" }); break;
							case 2: deepStrictEqual(command, { kind: "truncate", timestamp: cycle * 10 + 2 }); break;
							case 3:
								deepStrictEqual(command, { kind: "target", mode: cycle % 2 ? "auto" : "fixed", milliseconds: cycle % 100 });
								break;
							case 4:
								deepStrictEqual(command, {
									kind: "pcm", timestamp: cycle * 10 + 3.5, arrival: cycle + 0.875,
									planes: [new Float32Array([42]), new Float32Array([-42])],
								});
								break;
							case 5: deepStrictEqual(command, { kind: "end", timestamp: cycle * 10 + 4.5 }); break;
						}
						received++;
					}
					if (received === workerData.count) {
						strictEqual(consumer.shift(), undefined);
						parentPort.postMessage({ kind: "done", count: received });
					} else {
						parentPort.postMessage({ kind: "credit" });
						setImmediate(drain);
					}
				}
				drain();
			})().catch(error => { throw error; });
			`,
			{
				eval: true,
				workerData: { init, count: commands.length, module: new URL("./ingress.ts", import.meta.url).href },
			},
		);
		let credit = Promise.withResolvers<void>();
		const finished = new Promise<number>((resolve, reject) => {
			worker.on("message", (message: { kind: "credit" } | { kind: "done"; count: number }) => {
				credit.resolve();
				credit = Promise.withResolvers<void>();
				if (message.kind === "done") resolve(message.count);
			});
			worker.on("error", reject);
			worker.on("exit", (code) => {
				if (code !== 0) reject(new Error(`ingress worker exited with ${code}`));
			});
		});
		let refusals = 1;
		try {
			while (sent < commands.length) {
				if (producer.push(commands[sent])) sent++;
				else {
					refusals++;
					await Promise.race([credit.promise, finished]);
				}
			}
			expect(await finished).toBe(24576);
			expect(refusals).toBeGreaterThan(1);
			expect(producer.available).toEqual({ commands: 8, frames: 8 });
		} finally {
			await worker.terminate();
		}
	});
});

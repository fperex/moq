import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { allocate, type Command, Producer } from "../../js/watch/src/audio/ingress";
import type { Message, ToMain } from "../../js/watch/src/audio/render";

class Port {
	onmessage?: (event: { data: Message }) => void;
	postMessage(_message: ToMain): void {}
}

class Processor {
	port = new Port();
}

type Worklet = Processor & { process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean };
let registered: (new () => Worklet) | undefined;
Object.assign(globalThis, {
	AudioWorkletProcessor: Processor,
	registerProcessor(_name: string, constructor: new () => Worklet) {
		registered = constructor;
	},
	sampleRate: 48000,
	currentFrame: 0,
});
await import("../../js/watch/src/audio/render-worklet");
const Constructor = registered;
if (!Constructor) throw new Error("audio worklet did not register");

const hashes = Object.fromEntries(
	["playout.ts", "ingress.ts", "render.ts", "render-worklet.ts"].map((file) => [
		file,
		createHash("sha256")
			.update(readFileSync(new URL(`../../js/watch/src/audio/${file}`, import.meta.url)))
			.digest("hex"),
	]),
);
console.log(JSON.stringify({ runtime: `Bun ${Bun.version}`, platform: process.platform, arch: process.arch, hashes }));

for (const rate of [44100, 48000, 96000]) {
	for (const transport of ["post", "shared"]) {
		for (const channels of [2, 8]) {
			for (const milliseconds of [40, 2000]) {
				const times: number[] = [];
				for (let trial = 0; trial < 32; trial++) {
					Reflect.set(globalThis, "sampleRate", rate);
					const engine = new Constructor();
					const shared =
						transport === "shared"
							? allocate({ channels, frameCapacity: rate * 2, commandCapacity: 256 })
							: undefined;
					const producer = shared ? new Producer(shared) : undefined;
					engine.port.onmessage?.({
						data: {
							type: "init",
							rate,
							channels,
							shared,
							policy: { kind: "target", mode: "buffered", milliseconds: 0 },
						},
					});
					const total = Math.floor((rate * milliseconds) / 1000);
					const chunk = Math.floor(rate * 0.04);
					for (let offset = 0; offset < total; offset += chunk) {
						const length = Math.min(chunk, total - offset);
						const command: Command = {
							kind: "pcm",
							timestamp: (offset * 1e6) / rate,
							arrival: 0,
							planes: Array.from({ length: channels }, () => new Float32Array(length).fill(0.25)),
						};
						if (producer) {
							if (!producer.push(command)) throw new Error("benchmark exceeded ingress capacity");
						} else engine.port.onmessage?.({ data: { type: "command", command } });
					}
					const output = Array.from({ length: channels }, () => new Float32Array(128));
					const start = performance.now();
					engine.process([], [output]);
					times.push(performance.now() - start);
					if (output.some((plane) => plane.some((sample) => sample !== 0.25)))
						throw new Error("benchmark did not render its input");
				}
				times.sort((a, b) => a - b);
				console.log(
					JSON.stringify({
						rate,
						transport,
						channels,
						milliseconds,
						trials: times.length,
						medianMs: times[16],
						p95Ms: times[30],
						maxMs: times.at(-1),
						deadlineMs: 128000 / rate,
						overDeadline: times.filter((value) => value > 128000 / rate).length,
					}),
				);
			}
		}
	}
}

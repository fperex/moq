import { Time } from "@moq/net";
import { type Command, Consumer } from "./ingress";
import { Playout } from "./playout";
import type { Message, Policy, State } from "./render";

class Render extends AudioWorkletProcessor {
	#playout?: Playout;
	#shared?: Consumer;
	#commands: Command[] = [];
	#stateCounter = 0;
	#epoch = 0;
	#acceptedFrames = 0;
	#lastTimestamp?: number;
	#lastFrame = 0;
	#nextFrame = 0;

	constructor() {
		super();
		this.port.onmessage = (event: MessageEvent<Message>) => {
			try {
				const message = event.data;
				if (message.type === "init") {
					this.#playout = new Playout({
						rate: message.rate,
						channels: message.channels,
						...this.#policy(message.policy),
					});
					this.#shared = message.shared ? new Consumer(message.shared) : undefined;
				} else {
					this.#commands.push(message.command);
				}
			} catch (error) {
				this.#failed(error);
			}
		};
	}

	#policy(policy: Policy) {
		return {
			target:
				policy.mode === "auto"
					? {
							kind: "auto" as const,
							initialMilliseconds: policy.milliseconds,
							minMilliseconds: policy.milliseconds,
							maxMilliseconds: Math.max(1000, policy.milliseconds),
						}
					: { kind: "fixed" as const, milliseconds: policy.milliseconds },
			buffered: policy.mode === "buffered",
		};
	}

	#accept(command: Command): void {
		const playout = this.#playout;
		if (!playout) throw new Error("audio worklet is not initialized");
		switch (command.kind) {
			case "pcm":
				playout.insert(command.timestamp, command.planes, command.arrival);
				this.#acceptedFrames += command.planes[0].length;
				break;
			case "target":
				playout.configure(this.#policy(command));
				break;
			case "truncate":
				playout.truncate(command.timestamp, command.end);
				break;
			case "end":
				playout.end(command.timestamp);
				break;
			case "reset":
				playout.reset();
				this.#epoch++;
				this.#lastTimestamp = undefined;
				break;
			default: {
				const exhaustive: never = command;
				throw new Error(`unknown audio command: ${exhaustive}`);
			}
		}
	}

	#failed(error: unknown): never {
		this.port.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) });
		throw error;
	}

	process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
		try {
			const output = outputs[0];
			// Apply the published batch before rendering, including resets and overlapping replacements.
			const commands = this.#shared ? this.#shared.length : this.#commands.length;
			for (let i = 0; i < commands; i++) {
				const command = this.#shared ? this.#shared.shift() : this.#commands.shift();
				if (!command) break;
				this.#accept(command);
				if (!this.#shared)
					this.port.postMessage({
						type: "consumed",
						frames: command.kind === "pcm" ? command.planes[0].length : 0,
					});
			}
			const playout = this.#playout;
			if (!playout) return true;
			// Chromium can expose a stale currentFrame when its graph try-lock fails.
			// Every process call still requests fresh audio, so count the samples pulled.
			const start = Math.max(currentFrame, this.#nextFrame);
			playout.render(output, start);
			this.#nextFrame = start + output[0].length;
			if (++this.#stateCounter >= 5) {
				this.#stateCounter = 0;
				const frame = this.#nextFrame;
				const timestamp = playout.timestamp;
				const slope =
					timestamp === undefined || this.#lastTimestamp === undefined
						? 1
						: ((timestamp - this.#lastTimestamp) * sampleRate) / ((frame - this.#lastFrame) * 1e6);
				const state: State = {
					type: "state",
					epoch: this.#epoch,
					acceptedFrames: this.#acceptedFrames,
					frame,
					timestamp: timestamp === undefined ? undefined : Time.Micro(timestamp),
					rate: playout.playing ? slope : 0,
					stalled: !playout.playing,
					stats: playout.stats,
				};
				this.port.postMessage(state);
				this.#lastTimestamp = timestamp;
				this.#lastFrame = frame;
			}
			return true;
		} catch (error) {
			return this.#failed(error);
		}
	}
}

registerProcessor("render", Render);

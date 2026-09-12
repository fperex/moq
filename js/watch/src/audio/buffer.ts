import { Time } from "@moq/net";
import { Effect, type Getter, Signal } from "@moq/signals";
import type { Clock } from "../sync";
import { allocate, type Command, Producer } from "./ingress";
import type { Stats } from "./playout";
import type { Message, Policy, ToMain } from "./render";

/** Whether this page supports shared worklet input. */
export function supportsSharedArrayBuffer(): boolean {
	return (
		typeof SharedArrayBuffer !== "undefined" && (typeof crossOriginIsolated === "undefined" || crossOriginIsolated)
	);
}

/** The decoded input queue and observed audio presentation clock. */
export class AudioBuffer {
	readonly rate: number;
	readonly channels: number;
	readonly #worklet: AudioWorkletNode;
	readonly #producer?: Producer;
	readonly #ingressCapacity: number;
	readonly #signals = new Effect();
	readonly #timestamp = new Signal(Time.Micro.zero);
	readonly timestamp: Getter<Time.Micro> = this.#timestamp;
	readonly #stalled = new Signal(true);
	readonly stalled: Getter<boolean> = this.#stalled;
	readonly #clock = new Signal<Clock | undefined>(undefined);
	readonly clock: Getter<Clock | undefined> = this.#clock;
	readonly #target = new Signal<Time.Milli | undefined>(undefined);
	readonly target: Getter<Time.Milli | undefined> = this.#target;
	readonly #stats = new Signal<Stats | undefined>(undefined);
	readonly stats: Getter<Stats | undefined> = this.#stats;
	#policy: Policy;
	#epoch = 0;
	#pending = 0;
	#pendingCommands = 0;
	#sentFrames = 0;
	#acceptedFrames = 0;
	#retainedFrames = 0;
	#epochFrames = 0;
	#capacity: number;
	#queue: Command[] = [];
	#queuedFrames = 0;
	#closed = false;
	#waiters: Array<{ timestamp: Time.Micro; resolve: () => void }> = [];

	constructor(props: { worklet: AudioWorkletNode; channels: number; rate: number; policy: Policy }) {
		this.rate = props.rate;
		this.channels = props.channels;
		this.#worklet = props.worklet;
		this.#policy = props.policy;
		this.#capacity = Math.ceil((this.rate * Math.max(2000, props.policy.milliseconds * 2)) / 1000);
		const shared = supportsSharedArrayBuffer()
			? allocate({ channels: this.channels, frameCapacity: this.rate * 2, commandCapacity: 256 })
			: undefined;
		if (shared) this.#producer = new Producer(shared);
		this.#ingressCapacity = shared?.frameCapacity ?? this.rate * 2;
		const message: Message = {
			type: "init",
			rate: this.rate,
			channels: this.channels,
			policy: this.#policy,
			shared,
		};
		props.worklet.port.postMessage(message);
		this.#signals.event(props.worklet.port, "message", (event) => {
			const data = (event as MessageEvent<ToMain>).data;
			if (data.type === "error") {
				console.error("audio worklet error:", data.message);
				return;
			}
			if (data.type === "consumed") {
				this.#pending -= data.frames;
				this.#pendingCommands--;
				this.#advance();
				return;
			}
			this.#acceptedFrames = data.acceptedFrames;
			if (data.epoch !== this.#epoch) {
				this.#advance();
				return;
			}
			this.#retainedFrames = data.stats.queueSamples;
			this.#stalled.set(data.stalled);
			this.#stats.set(data.stats);
			this.#target.set(this.#policy.mode === "auto" ? Time.Milli(data.stats.targetMilliseconds) : undefined);
			if (data.timestamp !== undefined) {
				this.#timestamp.set(data.timestamp);
				const context = props.worklet.context;
				if (context instanceof AudioContext && context.state === "running") {
					const output = context.getOutputTimestamp?.();
					const reference =
						output?.performanceTime && output.contextTime !== undefined
							? output.performanceTime + (data.frame / this.rate - output.contextTime) * 1000
							: performance.now() +
								(data.frame / this.rate -
									context.currentTime +
									context.baseLatency +
									(context.outputLatency ?? 0)) *
									1000;
					this.#clock.set({
						timestamp: Time.Milli.fromMicro(data.timestamp),
						reference: Time.Milli(reference),
						rate: data.rate,
					});
				}
			}
			this.#advance();
		});
		props.worklet.port.start();
		this.#signals.event(props.worklet.context, "statechange", () => {
			if (props.worklet.context.state !== "running") this.#clock.set(undefined);
			this.#advance();
		});
	}

	#send(command: Command): void {
		if (this.#closed) return;
		this.#queue.push(command);
		if (command.kind === "pcm") this.#queuedFrames += command.planes[0].length;
		this.#drain();
	}

	#drain(): void {
		while (this.#queue.length) {
			const command = this.#queue[0];
			const frames = command.kind === "pcm" ? command.planes[0].length : 0;
			const charged = this.#sentFrames - Math.max(this.#acceptedFrames, this.#epochFrames) + this.#retainedFrames;
			if (frames > 0 && charged + frames > this.#capacity) return;
			if (this.#producer) {
				if (!this.#producer.push(command)) return;
			} else {
				if (this.#pendingCommands >= 256 || this.#pending + frames > this.rate * 2) return;
				this.#pendingCommands++;
				this.#pending += frames;
				const message: Message = { type: "command", command };
				this.#worklet.port.postMessage(
					message,
					command.kind === "pcm" ? command.planes.map((plane) => plane.buffer) : [],
				);
			}
			this.#sentFrames += frames;
			if (command.kind === "target")
				this.#capacity = Math.max(
					this.#capacity,
					Math.ceil((this.rate * Math.max(2000, command.milliseconds * 2)) / 1000),
				);
			this.#queuedFrames -= frames;
			this.#queue.shift();
		}
	}

	insert(timestamp: Time.Micro, planes: Float32Array[]): void {
		const arrival = performance.now();
		// Bound one worklet copy while keeping ordinary Opus and AAC frames intact.
		const chunk = Math.floor(this.rate * 0.04);
		for (let offset = 0; offset < planes[0].length; offset += chunk) {
			this.#send({
				kind: "pcm",
				timestamp: timestamp + (offset * 1e6) / this.rate,
				arrival,
				planes:
					offset === 0 && planes[0].length <= chunk
						? planes
						: planes.map((plane) => plane.slice(offset, offset + chunk)),
			});
		}
	}

	configure(policy: Policy): void {
		if (policy.mode === this.#policy.mode && policy.milliseconds === this.#policy.milliseconds) return;
		this.#policy = policy;
		this.#send(policy);
		this.#advance();
	}

	truncate(timestamp: Time.Micro, end?: Time.Micro): void {
		this.#trim(timestamp);
		this.#send({ kind: "truncate", timestamp, end });
	}
	end(timestamp: Time.Micro): void {
		this.#trim(timestamp);
		this.#send({ kind: "end", timestamp });
	}

	#trim(timestamp: Time.Micro): void {
		const end = Math.round((timestamp * this.rate) / 1e6);
		this.#queue = this.#queue.filter((command) => {
			if (command.kind !== "pcm") return true;
			const start = Math.round((command.timestamp * this.rate) / 1e6);
			const length = Math.max(0, Math.min(command.planes[0].length, end - start));
			this.#queuedFrames -= command.planes[0].length - length;
			if (length === 0) return false;
			if (length < command.planes[0].length)
				command.planes = command.planes.map((plane) => plane.slice(0, length));
			return true;
		});
	}

	reset(): void {
		this.#epoch++;
		this.#epochFrames = this.#sentFrames;
		this.#retainedFrames = 0;
		this.#queue = this.#queue.filter((command) => command.kind !== "pcm");
		this.#queuedFrames = 0;
		this.#clock.set(undefined);
		this.#target.set(undefined);
		this.#timestamp.set(Time.Micro.zero);
		this.#stalled.set(true);
		this.#send({ kind: "reset" });
		this.#advance();
	}

	wait(timestamp: Time.Micro, signal: AbortSignal): Promise<void> {
		if (signal.aborted || !this.#blocked(timestamp)) return Promise.resolve();
		return new Promise((resolve) => {
			const waiter = {
				timestamp,
				resolve: () => {
					signal.removeEventListener("abort", cancel);
					resolve();
				},
			};
			const cancel = () => {
				this.#waiters = this.#waiters.filter((current) => current !== waiter);
				resolve();
			};
			signal.addEventListener("abort", cancel, { once: true });
			this.#waiters.push(waiter);
		});
	}

	#blocked(timestamp: Time.Micro): boolean {
		if (this.#closed) return false;
		const outstanding =
			this.#queuedFrames +
			(this.#producer ? this.#ingressCapacity - this.#producer.available.frames : this.#pending);
		if (outstanding >= this.rate * 0.04 || this.#worklet.context.state !== "running") return true;
		if (this.#stalled.peek()) return false;
		const ahead =
			this.#policy.mode === "buffered" ? this.#policy.milliseconds : Math.max(1000, this.#policy.milliseconds);
		return timestamp > this.#timestamp.peek() + ahead * 1000;
	}

	#advance(): void {
		this.#drain();
		this.#waiters = this.#waiters.filter((waiter) => {
			if (this.#blocked(waiter.timestamp)) return true;
			waiter.resolve();
			return false;
		});
	}

	close(): void {
		this.#closed = true;
		this.#queue = [];
		for (const waiter of this.#waiters) waiter.resolve();
		this.#waiters = [];
		this.#clock.set(undefined);
		this.#signals.close();
	}
}

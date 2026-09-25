import { Time } from "@moq/net";
import { Stretcher } from "./playout";
import type { Message, State, Unreadable } from "./render";
import { AudioRingBuffer } from "./ring-buffer";
import { SharedRingBuffer } from "./shared-ring-buffer";

// Samples to fade over when playback stops or resumes short of a full quantum. A shortfall
// otherwise steps straight to silence and back, which is an audible click on every underrun.
const RAMP = 64;

class Render extends AudioWorkletProcessor {
	// Set after init, depending on which path the main thread chose.
	#backend?: SharedRingBuffer | AudioRingBuffer;
	// The playout engine that decides what to do with the media the ring hands over. Outlives a
	// shared-ring handover, because the counters it publishes describe the reader, not the ring.
	#engine?: Stretcher;
	#underflow = 0;
	#stateCounter = 0;
	// The timeline the last applied flush started, echoed back so the main thread can drop a state
	// message that was already in flight when it flushed. See `State.timeline`.
	#timeline = 0;
	// Whether the previous quantum ended short, so the next one fades back in.
	#short = false;
	// The state message, refilled for every post: `postMessage` copies it on the way out, so one
	// object serves, rather than a fresh one for this thread's collector every few quanta.
	#state?: State;
	// Every port the ring is fed from: the node's own, plus any a writer off the main thread handed
	// over. State reports go to all of them.
	#ports: MessagePort[] = [];
	// Whether a message has already failed to deserialize, which is said once. See #unreadable.
	#unread = false;

	constructor() {
		super();
		this.#listen(this.port);
	}

	#listen(port: MessagePort): void {
		this.#ports.push(port);
		port.onmessageerror = () => this.#unreadable();
		port.onmessage = (event: MessageEvent<Message>) => {
			const msg = event.data;
			if (msg.type === "port") {
				this.#listen(msg.port);
			} else if (msg.type === "init-shared") {
				const previous = this.#backend instanceof SharedRingBuffer ? this.#backend : undefined;
				this.#backend = new SharedRingBuffer(msg, previous);
				this.#reset(msg.rate, msg.channels, msg.conceal);
			} else if (msg.type === "init-post") {
				this.#backend = new AudioRingBuffer(msg);
				this.#reset(msg.rate, msg.channels, msg.conceal);
			} else if (msg.type === "data") {
				// Only meaningful in post mode.
				if (this.#backend instanceof AudioRingBuffer) this.#backend.write(msg.timestamp, msg.data);
			} else if (msg.type === "latency") {
				// Only meaningful in post mode.
				if (this.#backend instanceof AudioRingBuffer) this.#backend.resize(msg.latency);
			} else if (msg.type === "truncate") {
				// Only meaningful in post mode; shared mode truncates via the control array.
				if (this.#backend instanceof AudioRingBuffer) this.#backend.truncate(msg.timestamp);
			} else if (msg.type === "reset") {
				// Only meaningful in post mode; shared mode resets via the control array.
				this.#timeline = msg.timeline;
				if (this.#backend instanceof AudioRingBuffer) this.#backend.reset();
			} else if (msg.type === "stall") {
				// Only meaningful in post mode; shared mode stalls via the control array.
				if (this.#backend instanceof AudioRingBuffer) this.#backend.stall();
			} else if (msg.type === "end") {
				// Only meaningful in post mode; shared mode ends via the control array.
				if (this.#backend instanceof AudioRingBuffer) this.#backend.end();
			}
		};
	}

	/**
	 * Say once, on every port and in the console, that a message could not be deserialized (see
	 * `Unreadable`). A page whose worker writes the ring takes the audio back on it; a page writing
	 * the ring itself has nowhere else to play it, so the console is where it shows.
	 */
	#unreadable(): void {
		if (this.#unread) return;
		this.#unread = true;
		console.error("[audio] the render worklet could not deserialize a message sent to it");
		const msg: Unreadable = { type: "unreadable" };
		for (const port of this.#ports) port.postMessage(msg);
	}

	/**
	 * Point the engine at a replacement ring.
	 *
	 * A resize hands over a ring on the same timeline, so the engine keeps its counters and only
	 * drops the block it was holding; a different rate, channel count, or concealment setting is a
	 * different reader and needs a different engine.
	 */
	#reset(rate: number, channels: number, conceal: boolean): void {
		if (this.#engine?.rate !== rate || this.#engine.channels !== channels || this.#engine.conceal !== conceal) {
			this.#engine = new Stretcher(rate, channels, conceal);
		} else {
			this.#engine.discontinuity();
		}
		this.#underflow = 0;
		this.#short = false;
	}

	process(_inputs: Float32Array[][], outputs: Float32Array[][], _parameters: Record<string, Float32Array>) {
		const output = outputs[0];
		const backend = this.#backend;
		const engine = this.#engine;
		// `currentFrame` is the output clock the cooldown and the measured rate are counted in.
		const samplesRead = backend && engine ? engine.render(backend, output, currentFrame) : 0;

		if (samplesRead < output[0].length) {
			// Fade the tail of what we did read down to the silence that follows it.
			for (const channel of output) {
				const ramp = Math.min(RAMP, samplesRead);
				for (let i = 0; i < ramp; i++) {
					channel[samplesRead - ramp + i] *= 1 - (i + 1) / ramp;
				}
			}
			this.#underflow += output[0].length - samplesRead;
			this.#short = true;
		} else {
			if (this.#short) {
				// Fade back in from the silence the shortfall left behind.
				for (const channel of output) {
					for (let i = 0; i < Math.min(RAMP, samplesRead); i++) {
						channel[i] *= (i + 1) / RAMP;
					}
				}
				this.#short = false;
			}
			if (this.#underflow > 0 && backend) {
				console.debug(`audio underflow: ${Math.round((1000 * this.#underflow) / backend.rate)}ms`);
				this.#underflow = 0;
			}
		}

		// In post mode the main thread can't read worklet state directly, so we
		// periodically ship it across via postMessage. In shared mode the main
		// thread reads the shared control array directly.
		if (backend instanceof AudioRingBuffer) {
			this.#stateCounter++;
			if (this.#stateCounter >= 5) {
				this.#stateCounter = 0;
				const contextTime = Time.Second((currentFrame + output[0].length) / sampleRate);
				const playhead = backend.playhead;
				const debug = backend.debug();
				if (this.#state === undefined) {
					this.#state = { type: "state", contextTime, timeline: this.#timeline, playhead, debug };
				} else {
					this.#state.contextTime = contextTime;
					this.#state.timeline = this.#timeline;
					this.#state.playhead = playhead;
					this.#state.debug = debug;
				}
				for (const port of this.#ports) port.postMessage(this.#state);
			}
		}

		return true;
	}
}

registerProcessor("render", Render);

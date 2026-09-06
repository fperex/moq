import type { InitPost, InitShared, Message, State } from "./render";
import { AudioRingBuffer } from "./ring-buffer";
import { SharedRingBuffer } from "./shared-ring-buffer";

class Render extends AudioWorkletProcessor {
	// Set after init, depending on which path the main thread chose.
	#backend?: SharedRingBuffer | AudioRingBuffer;
	#underflow = 0;
	#stateCounter = 0;
	// rtprobe (throwaway)
	#rtQuanta = 0;
	#rtUnder = 0;
	#rtUnderQ = 0;
	#rtStalledQ = 0;
	#rtEp = 0;
	#rtInUnder = false;
	#rtLastSkips = 0;
	#rtLastCall = 0;
	#rtMaxGap = 0;
	#rtBurst = 0;
	#rtBurstMax = 0;
	#rtBurstCur = 0;

	constructor() {
		super();

		this.port.onmessage = (event: MessageEvent<Message>) => this.#handle(event.data);
	}

	#handle(msg: Message): void {
		if (msg.type === "init-shared") {
			this.#initShared(msg);
			return;
		}
		if (msg.type === "init-post") {
			this.#initPost(msg);
			return;
		}
		// The rest is only meaningful in post mode; shared mode drives the ring through Atomics.
		const post = this.#backend instanceof AudioRingBuffer ? this.#backend : undefined;
		if (!post) return;
		if (msg.type === "data") post.write(msg.timestamp, msg.data);
		else if (msg.type === "latency") post.resize(msg.latency);
		else if (msg.type === "truncate") post.truncate(msg.timestamp);
		else if (msg.type === "reset") post.reset();
	}

	#initShared(msg: InitShared): void {
		console.log("[audio-worklet] init-shared: using SharedArrayBuffer path");
		const previous = this.#backend instanceof SharedRingBuffer ? this.#backend : undefined;
		this.#backend = new SharedRingBuffer(msg, previous);
		this.#underflow = 0;
	}

	#initPost(msg: InitPost): void {
		console.log("[audio-worklet] init-post: using postMessage path");
		this.#backend = new AudioRingBuffer(msg);
		this.#underflow = 0;
	}
	#rtPost(k: string, o: Record<string, unknown>) {
		this.port.postMessage({ type: "rt", k, cf: currentFrame, ct: currentTime, ...o });
	}

	#rtProbe(backend: SharedRingBuffer | AudioRingBuffer | undefined, want: number, got: number) {
		const shared = backend instanceof SharedRingBuffer ? backend : undefined;
		const buffered = shared?.length ?? -1;
		const stalled = backend?.stalled ?? true;
		this.#rtQuanta++;
		this.#rtCadence();
		if (stalled) this.#rtStalledQ++;
		this.#rtUnderrun(want - got, buffered, stalled);
		if (shared && shared.skips !== this.#rtLastSkips) {
			this.#rtLastSkips = shared.skips;
			this.#rtPost("skip", { ...shared.lastSkip, stalled });
		}
		if (this.#rtQuanta % 100 !== 0) return;
		this.#rtPost("wstat", {
			quanta: 100,
			maxGapMs: this.#rtMaxGap,
			burstQuanta: this.#rtBurst,
			burstMax: this.#rtBurstMax,
			under: this.#rtUnder,
			underQ: this.#rtUnderQ,
			stalledQ: this.#rtStalledQ,
			buffered,
			latency: backend?.latency ?? -1,
			skipped: backend?.skipped ?? -1,
			post: backend instanceof AudioRingBuffer,
		});
		this.#rtUnder = 0;
		this.#rtUnderQ = 0;
		this.#rtStalledQ = 0;
		this.#rtMaxGap = 0;
		this.#rtBurst = 0;
		this.#rtBurstMax = 0;
	}

	// Wall-clock cadence of process(): a device with a coarse buffer pulls several quanta back to
	// back (gap < 1 ms) and then idles, which reads the ring in bursts.
	#rtCadence() {
		const now = Date.now();
		const gap = this.#rtLastCall ? now - this.#rtLastCall : 0;
		this.#rtLastCall = now;
		if (gap > this.#rtMaxGap) this.#rtMaxGap = gap;
		if (gap < 1) {
			this.#rtBurst++;
			this.#rtBurstCur++;
			if (this.#rtBurstCur > this.#rtBurstMax) this.#rtBurstMax = this.#rtBurstCur;
		} else this.#rtBurstCur = 0;
	}

	#rtUnderrun(short: number, buffered: number, stalled: boolean) {
		if (short > 0) {
			this.#rtUnder += short;
			this.#rtUnderQ++;
			this.#rtEp += short;
			if (!this.#rtInUnder) {
				this.#rtInUnder = true;
				this.#rtPost("under.start", { buffered, stalled });
			}
			return;
		}
		if (!this.#rtInUnder) return;
		this.#rtInUnder = false;
		this.#rtPost("under.end", { samples: this.#rtEp, buffered, stalled });
		this.#rtEp = 0;
	}
	process(_inputs: Float32Array[][], outputs: Float32Array[][], _parameters: Record<string, Float32Array>) {
		const output = outputs[0];
		const backend = this.#backend;
		const samplesRead = backend?.read(output) ?? 0;
		this.#rtProbe(backend, output[0].length, samplesRead);

		if (samplesRead < output[0].length) {
			this.#underflow += output[0].length - samplesRead;
		} else if (this.#underflow > 0 && backend) {
			console.debug(`audio underflow: ${Math.round((1000 * this.#underflow) / backend.rate)}ms`);
			this.#underflow = 0;
		}

		// In post mode the main thread can't read worklet state directly, so we
		// periodically ship it across via postMessage. In shared mode the main
		// thread reads the shared control array directly.
		if (backend instanceof AudioRingBuffer) {
			this.#stateCounter++;
			if (this.#stateCounter >= 5) {
				this.#stateCounter = 0;
				const state: State = {
					type: "state",
					timestamp: backend.timestamp,
					stalled: backend.stalled,
				};
				this.port.postMessage(state);
			}
		}

		return true;
	}
}

registerProcessor("render", Render);

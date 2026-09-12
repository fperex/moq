import { Time } from "@moq/net";
import { AudioBuffer, supportsSharedArrayBuffer } from "../../../../../js/watch/src/audio/buffer";
import Render from "../../../../../js/watch/src/audio/render-worklet.ts?worklet";
import { decode } from "./decode";
import Capture from "./pcm-capture-worklet.ts?worklet";

const cases = [
	"finite",
	"reset",
	"truncate",
	"pressure",
	"takeover",
	"takeover-gap",
	"graph",
	"large",
	"large-reset",
	"large-truncate",
	"large-end",
];
const params = new URLSearchParams(location.search);
const kind = params.get("case");
const rate = Number(params.get("rate"));
if (!kind || !cases.includes(kind) || (rate !== 44100 && rate !== 48000)) throw new Error("invalid PCM case");
const selected = kind;

function source(length: number, start = 0, sign = 1): Float32Array[] {
	const left = Float32Array.from({ length }, (_, i) => (sign * (((start + i) % 8191) + 1)) / 32768);
	return [left, Float32Array.from(left, (value) => -value)];
}

async function run() {
	const codecs = await decode();
	const context = new AudioContext({ sampleRate: rate });
	await context.suspend();
	try {
		if (context.sampleRate !== rate) throw new Error(`requested ${rate} Hz, got ${context.sampleRate} Hz`);
		await Promise.all([context.audioWorklet.addModule(Render), context.audioWorklet.addModule(Capture)]);
		const render = new AudioWorkletNode(context, "render", {
			outputChannelCount: [2],
			channelCount: 2,
			channelCountMode: "explicit",
		});
		const capture = new AudioWorkletNode(context, "pcm-capture", {
			outputChannelCount: [2],
			channelCount: 2,
			channelCountMode: "explicit",
			processorOptions: {
				frames: rate * (selected === "pressure" || selected === "large" ? 5 : selected === "graph" ? 3 : 1),
			},
		});
		const recorded = new Promise<{ planes: Float32Array[]; staleFrames: number }>((resolve, reject) => {
			capture.port.onmessage = (event: MessageEvent<{ planes: Float32Array[]; staleFrames: number }>) =>
				resolve(event.data);
			capture.onprocessorerror = () => reject(new Error("capture worklet failed"));
			render.onprocessorerror = (event) =>
				reject(new Error(event instanceof ErrorEvent ? event.message : "render worklet failed"));
		});
		render.connect(capture);
		capture.connect(context.destination);
		const buffer = new AudioBuffer({
			worklet: render,
			rate,
			channels: 2,
			policy: { kind: "target", mode: "buffered", milliseconds: selected === "pressure" ? 4000 : 40 },
		});
		let graphTimer: ReturnType<typeof setInterval> | undefined;
		let graphMutations = 0;
		try {
			const count = Math.round(rate * (selected === "large" ? 3 : selected === "graph" ? 2 : 0.12));
			let expected = source(count);
			if (selected === "finite" || selected === "graph" || selected === "large") {
				buffer.insert(
					Time.Micro.zero,
					expected.map((plane) => plane.slice()),
				);
			} else if (selected === "large-reset" || selected === "large-truncate" || selected === "large-end") {
				buffer.insert(Time.Micro.zero, source(rate * 3, 0, -1));
				if (selected === "large-reset") buffer.reset();
				else if (selected === "large-truncate") buffer.truncate(Time.Micro.zero);
				if (selected === "large-end") expected = [new Float32Array(0), new Float32Array(0)];
				else
					buffer.insert(
						Time.Micro.zero,
						expected.map((plane) => plane.slice()),
					);
			} else if (selected === "reset") {
				buffer.insert(Time.Micro(3000000), source(count, 0, -1));
				buffer.reset();
				buffer.insert(
					Time.Micro.zero,
					expected.map((plane) => plane.slice()),
				);
			} else if (selected === "truncate") {
				const split = Math.floor(count / 2);
				buffer.insert(Time.Micro.zero, source(count * 2));
				buffer.truncate(Time.Micro((split * 1e6) / rate));
				const tail = source(count - split, split, -1);
				buffer.insert(
					Time.Micro((split * 1e6) / rate),
					tail.map((plane) => plane.slice()),
				);
				for (let channel = 0; channel < 2; channel++) expected[channel].set(tail[channel], split);
			} else if (selected === "takeover" || selected === "takeover-gap") {
				const previous = Math.round(rate * 0.01);
				const split = Math.round(rate * (selected === "takeover" ? 0.005 : 0.1));
				const old =
					selected === "takeover"
						? source(previous)
						: [new Float32Array(previous), new Float32Array(previous)];
				buffer.insert(
					Time.Micro.zero,
					old.map((plane) => plane.slice()),
				);
				buffer.end(Time.Micro((previous * 1e6) / rate));
				const tail = source(count, split, -1);
				if (selected === "takeover-gap") for (const plane of tail) plane.fill(0, 0, Math.round(rate * 0.015));
				expected = [new Float32Array(split + count), new Float32Array(split + count)];
				for (let channel = 0; channel < 2; channel++) {
					expected[channel].set(old[channel].subarray(0, split));
					expected[channel].set(tail[channel], split);
				}
				const endpoint = Time.Micro((expected[0].length * 1e6) / rate);
				buffer.end(endpoint);
				buffer.truncate(Time.Micro((split * 1e6) / rate), endpoint);
				buffer.insert(Time.Micro((split * 1e6) / rate), tail);
			} else {
				const chunk = Math.round(rate * 0.0075);
				const total = chunk * 400;
				expected = source(total);
				for (let i = 0; i < 400; i++)
					buffer.insert(Time.Micro((i * chunk * 1e6) / rate), source(chunk, i * chunk));
				const split = chunk * 200;
				buffer.truncate(Time.Micro((split * 1e6) / rate));
				const tail = source(total - split, split, -1);
				buffer.insert(
					Time.Micro((split * 1e6) / rate),
					tail.map((plane) => plane.slice()),
				);
				for (let channel = 0; channel < 2; channel++) expected[channel].set(tail[channel], split);
			}
			if (selected !== "takeover" && selected !== "takeover-gap")
				buffer.end(Time.Micro((expected[0].length * 1e6) / rate));
			if (selected === "graph") {
				graphTimer = setInterval(() => {
					for (let i = 0; i < 100; i++) {
						const gain = context.createGain();
						gain.gain.value = 0;
						render.connect(gain);
						gain.connect(context.destination);
						render.disconnect(gain);
						gain.disconnect();
						graphMutations++;
					}
				}, 4);
			}
			await context.resume();
			const { planes: actual, staleFrames } = await recorded;
			const firstNonzero = actual[0].findIndex((value) => value !== 0);
			if (firstNonzero < 0 && expected[0].length > 0) throw new Error("rendered only silence");
			const first = expected[0].length === 0 ? 0 : firstNonzero - expected[0].findIndex((value) => value !== 0);
			if (first < 0) throw new Error("audio played before its buffered timeline");
			if (first + expected[0].length + 256 > actual[0].length)
				throw new Error("capture ended before endpoint tail");
			for (let channel = 0; channel < 2; channel++) {
				for (let sample = 0; sample < expected[channel].length; sample++) {
					if (actual[channel][first + sample] !== expected[channel][sample]) {
						throw new Error(
							`PCM mismatch channel=${channel} sample=${sample}: ${actual[channel][first + sample]} != ${expected[channel][sample]}`,
						);
					}
				}
				for (let sample = first + expected[channel].length; sample < actual[channel].length; sample++) {
					if (actual[channel][sample] !== 0)
						throw new Error(`audio after endpoint at channel=${channel} sample=${sample}`);
				}
			}
			return {
				case: selected,
				rate,
				shared: supportsSharedArrayBuffer(),
				codecs,
				samples: expected[0].length,
				startupFrames: first,
				staleFrames,
				graphMutations,
			};
		} finally {
			clearInterval(graphTimer);
			buffer.close();
			render.disconnect();
			capture.disconnect();
		}
	} finally {
		await context.close();
	}
}

document.querySelector("button")?.addEventListener(
	"click",
	() => {
		run()
			.then((result) => {
				document.body.dataset.pcm = JSON.stringify({ ok: true, ...result });
			})
			.catch((error: unknown) => {
				document.body.dataset.pcm = JSON.stringify({ ok: false, error: String(error) });
			});
	},
	{ once: true },
);
document.body.dataset.ready = "true";

import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { Time } from "../../js/net/src/index.ts";
import { AudioRingBuffer } from "./baseline/ring-buffer.ts";
import { allocSharedRingBuffer, SharedRingBuffer } from "./baseline/shared-ring-buffer.ts";
import { Playout, type Stats } from "../../js/watch/src/audio/playout.ts";

const rate = 48_000;
const seconds = 45;
const warmup = 5;
const frames = rate * seconds;
const chunk = 960;
const target = 43;
const { values } = parseArgs({
	args: process.argv.slice(2),
	options: { input: { type: "string" }, output: { type: "string" } },
});
const outputRoot = values.output ? pathToFileURL(resolve(values.output) + "/") : new URL("./", import.meta.url);
const artifactDirectoryName = "waveforms/";
const artifactDirectory = new URL(artifactDirectoryName, outputRoot);
const manifestUrl = new URL("comparison.json", outputRoot);
await mkdir(artifactDirectory, { recursive: true });

const recordingBytes = values.input ? new Uint8Array(await Bun.file(values.input).arrayBuffer()) : undefined;
if (
	recordingBytes &&
	(recordingBytes.byteLength === 0 || recordingBytes.byteLength % (2 * Float32Array.BYTES_PER_ELEMENT) !== 0)
) {
	throw new Error("input must contain nonempty 48 kHz interleaved stereo float32 PCM");
}
const recording = recordingBytes
	? new Float32Array(
			recordingBytes.buffer,
			recordingBytes.byteOffset,
			recordingBytes.byteLength / Float32Array.BYTES_PER_ELEMENT,
		)
	: undefined;
if (recording && !recording.every(Number.isFinite)) throw new Error("input contains nonfinite PCM");

function sourceSample(sample: number, channel: number): number {
	if (recording) return recording[(sample * 2 + channel) % recording.length];
	const left = 0.4 * Math.sin((2 * Math.PI * 997 * sample) / rate);
	return channel === 0 ? left : -left;
}

function sha256(data: ArrayBuffer | ArrayBufferView | string): string {
	const hash = createHash("sha256");
	if (typeof data === "string") hash.update(data);
	else if (ArrayBuffer.isView(data)) hash.update(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
	else hash.update(new Uint8Array(data));
	return hash.digest("hex");
}

function encodeStereoWav(channels: readonly [Float32Array, Float32Array]): ArrayBuffer {
	if (channels[0].length !== channels[1].length) throw new Error("WAV channels have different lengths");
	const channelCount = channels.length;
	const blockAlign = channelCount * Int16Array.BYTES_PER_ELEMENT;
	const payloadBytes = channels[0].length * blockAlign;
	const wav = new ArrayBuffer(44 + payloadBytes);
	const view = new DataView(wav);
	const writeString = (offset: number, value: string) => {
		for (let index = 0; index < value.length; index++) view.setUint8(offset + index, value.charCodeAt(index));
	};
	writeString(0, "RIFF");
	view.setUint32(4, 36 + payloadBytes, true);
	writeString(8, "WAVE");
	writeString(12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, channelCount, true);
	view.setUint32(24, rate, true);
	view.setUint32(28, rate * blockAlign, true);
	view.setUint16(32, blockAlign, true);
	view.setUint16(34, 16, true);
	writeString(36, "data");
	view.setUint32(40, payloadBytes, true);
	let offset = 44;
	for (let frame = 0; frame < channels[0].length; frame++) {
		for (const channel of channels) {
			const sample = Math.max(-1, Math.min(1, channel[frame]));
			view.setInt16(offset, Math.round(sample * 32_767), true);
			offset += Int16Array.BYTES_PER_ELEMENT;
		}
	}
	return wav;
}

async function gitRevision(): Promise<string> {
	const process = Bun.spawn(["git", "rev-parse", "HEAD"], {
		cwd: fileURLToPath(new URL("../..", import.meta.url)),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		process.exited,
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
	]);
	if (exitCode !== 0) throw new Error("git rev-parse failed: " + stderr.trim());
	return stdout.trim();
}

const sourceChannels: [Float32Array, Float32Array] = [
	Float32Array.from({ length: frames }, (_, sample) => sourceSample(sample, 0)),
	Float32Array.from({ length: frames }, (_, sample) => sourceSample(sample, 1)),
];
const sourceWav = encodeStereoWav(sourceChannels);
const sourceFile = new URL("source.wav", artifactDirectory);
await Bun.write(sourceFile, sourceWav);

const scenarios = [
	{ name: "steady", burst: 1, jitter: 0, drift: 0 },
	{ name: "two-frame-burst", burst: 2, jitter: 12, drift: 0 },
	{ name: "seven-frame-burst", burst: 7, jitter: 20, drift: 0 },
	{ name: "fast-clock", burst: 1, jitter: 0, drift: 0.002 },
	{ name: "slow-clock", burst: 1, jitter: 0, drift: -0.002 },
] as const;
const modes = ["post", "shared", "fixed", "auto"] as const;
const results = [];
const artifacts = [{ file: artifactDirectoryName + "source.wav", sha256: sha256(sourceWav) }];

for (const scenario of scenarios) {
	for (const mode of modes) {
		const ring =
			mode === "post"
				? new AudioRingBuffer({ rate, channels: 2, latency: Time.Milli(target) })
				: mode === "shared"
					? new SharedRingBuffer(allocSharedRingBuffer(2, rate, rate))
					: new Playout({
							rate,
							channels: 2,
							target:
								mode === "auto"
									? { kind: "auto", initialMilliseconds: target, maxMilliseconds: 500 }
									: { kind: "fixed", milliseconds: target },
						});
		if (ring instanceof SharedRingBuffer) ring.setLatency(Math.ceil((rate * target) / 1000));

		const output: [Float32Array, Float32Array] = [new Float32Array(128), new Float32Array(128)];
		const waveform: [Float32Array, Float32Array] = [new Float32Array(frames), new Float32Array(frames)];
		let inserted = 0;
		let zeroOutputFrames = 0;
		let toneLargeSteps = 0;
		let toneCrossings = 0;
		let peak = 0;
		let previous = 0;
		let toneAntiphaseError = 0;
		const queueDepths: number[] = [];
		const started = performance.now();
		let warmupStats: Stats | undefined;

		for (let position = 0; position < frames; position += output[0].length) {
			if (position === warmup * rate && ring instanceof Playout) warmupStats = ring.stats;
			const now = (position * 1000) / rate;
			for (;;) {
				const frame = inserted / chunk;
				const group = Math.floor(frame / scenario.burst);
				const arrival =
					((group * scenario.burst + scenario.burst - 1) * chunk * 1000) / rate / (1 + scenario.drift) +
					(group % 2 ? scenario.jitter : 0);
				if (arrival > now) break;
				const data: [Float32Array, Float32Array] = [
					Float32Array.from({ length: chunk }, (_, index) => sourceSample(inserted + index, 0)),
					Float32Array.from({ length: chunk }, (_, index) => sourceSample(inserted + index, 1)),
				];
				const timestamp = Time.Micro(Math.round((inserted * 1e6) / rate));
				if (ring instanceof SharedRingBuffer) ring.insert(timestamp, data);
				else if (ring instanceof AudioRingBuffer) ring.write(timestamp, data);
				else ring.insert(timestamp, data, arrival);
				inserted += chunk;
			}

			for (const channel of output) channel.fill(0);
			if (ring instanceof Playout) ring.render(output, position);
			else ring.read(output);
			for (let index = 0; index < output[0].length && position + index < frames; index++) {
				const left = output[0][index];
				const right = output[1][index];
				if (!Number.isFinite(left) || !Number.isFinite(right)) throw new Error("Nonfinite PCM output");
				waveform[0][position + index] = left;
				waveform[1][position + index] = right;
				if (position >= warmup * rate) {
					if (left === 0 && right === 0) zeroOutputFrames++;
					if (!recording && Math.abs(left - previous) > 0.12) toneLargeSteps++;
					if (!recording && previous < 0 && left >= 0) toneCrossings++;
					peak = Math.max(peak, Math.abs(left), Math.abs(right));
					if (!recording) toneAntiphaseError = Math.max(toneAntiphaseError, Math.abs(left + right));
				}
				previous = left;
			}
			if (position >= warmup * rate && position % 6144 === 0 && ring.timestamp !== undefined) {
				queueDepths.push((inserted * 1000) / rate - ring.timestamp / 1000);
			}
		}

		const elapsed = performance.now() - started;
		queueDepths.sort((a, b) => a - b);
		const result = {
			scenario: scenario.name,
			mode,
			zeroOutputMilliseconds: (zeroOutputFrames * 1000) / rate,
			toneLargeSteps: recording ? null : toneLargeSteps,
			toneFrequencyHz: recording ? null : toneCrossings / (seconds - warmup),
			peak,
			toneAntiphaseError: recording ? null : toneAntiphaseError,
			queueP50Milliseconds: queueDepths[Math.floor(queueDepths.length / 2)] ?? null,
			queueP99Milliseconds: queueDepths[Math.floor(queueDepths.length * 0.99)] ?? null,
			computeMilliseconds: elapsed,
			stats: ring instanceof Playout ? ring.stats : undefined,
			afterWarmup:
				ring instanceof Playout && warmupStats
					? {
							concealed: ring.stats.concealed - warmupStats.concealed,
							silent: ring.stats.silent - warmupStats.silent,
							late: ring.stats.late - warmupStats.late,
						}
					: undefined,
		};
		results.push(result);

		const wav = encodeStereoWav(waveform);
		const file = scenario.name + "-" + mode + ".wav";
		await Bun.write(new URL(file, artifactDirectory), wav);
		artifacts.push({ file: artifactDirectoryName + file, sha256: sha256(wav) });
	}
}

const sourceDescriptor = recordingBytes
	? { kind: "f32-stereo", inputSha256: sha256(recordingBytes), renderedSha256: sha256(sourceWav) }
	: {
			kind: "997hz-antiphase-tone",
			inputSha256: sha256("rate=48000;frequency=997;amplitude=0.4;right=-left"),
			renderedSha256: sha256(sourceWav),
		};
const root = new URL("../..", import.meta.url);
const provenance = {
	revision: await gitRevision(),
	source: sourceDescriptor,
	wav: { channels: 2, sampleRate: rate, bitsPerSample: 16 },
	codeSha256: {
		compare: sha256(await Bun.file(fileURLToPath(import.meta.url)).arrayBuffer()),
		playout: sha256(await Bun.file(new URL("js/watch/src/audio/playout.ts", root)).arrayBuffer()),
		postRing: sha256(
			await Bun.file(new URL("debug-findings/neteq-rd/baseline/ring-buffer.ts", root)).arrayBuffer(),
		),
		sharedRing: sha256(
			await Bun.file(new URL("debug-findings/neteq-rd/baseline/shared-ring-buffer.ts", root)).arrayBuffer(),
		),
	},
	artifacts,
};
await Bun.write(manifestUrl, JSON.stringify({ rate, channels: 2, seconds, warmup, provenance, results }, null, 2));
console.table(results.map(({ stats: _stats, ...row }) => row));

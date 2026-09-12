/** Native codec evidence and authored-file presentation regression. No relay or media fixture is used. */
import { AudioSample } from "mediabunny";
import { fill } from "../../js/publish/src/source/audio";
import { Framer } from "../../js/publish/src/audio/framer";
import { Resampler } from "../../js/publish/src/audio/resampler";
import { Time } from "../../js/net/src/index";
type Input = { timestamp: number; samples: number };
function bytes(source: AllowSharedBufferSource): Uint8Array {
	return ArrayBuffer.isView(source)
		? new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
		: new Uint8Array(source);
}
async function timestampProbe() {
	const results = [];
	for (const codec of ["opus", "mp4a.40.2"]) {
		const sampleRate = 48000;
		const frame = codec === "opus" ? 960 : 1024;
		const config: AudioEncoderConfig = { codec, sampleRate, numberOfChannels: 2, bitrate: 128000 };
		const supported = await AudioEncoder.isConfigSupported(config);
		if (!supported.supported) {
			results.push({ codec, supported: false });
			continue;
		}
		const scenarios: Record<string, Input[]> = {
			contiguous: Array.from({ length: 4 }, (_, i) => ({
				timestamp: 100000 + Math.round(((i * frame) / sampleRate) * 1e6),
				samples: frame,
			})),
			gap: [
				{ timestamp: 100000, samples: frame },
				...Array.from({ length: 3 }, (_, i) => ({
					timestamp: 1000000 + Math.round(((i * frame) / sampleRate) * 1e6),
					samples: frame,
				})),
			],
			aggregateGap: [
				{ timestamp: 100000, samples: 128 },
				{ timestamp: 1000000, samples: frame * 3 - 128 },
			],
			partial: Array.from({ length: 9 }, (_, i) => ({
				timestamp: 100000 + Math.round(((i * 128) / sampleRate) * 1e6) + (i >= 3 ? 900000 : 0),
				samples: 128,
			})),
			fileLoop: Array.from({ length: 20 }, (_, i) => ({
				timestamp: 2595135 + i * 20000 + (i >= 10 ? 2600000 : 0),
				samples: 960,
			})),
		};
		for (const [scenario, inputs] of Object.entries(scenarios)) {
			const outputs: unknown[] = [];
			const errors: string[] = [];
			let sent = 0;
			let metadata: unknown;
			const encoder = new AudioEncoder({
				output: (chunk, meta) => {
					outputs.push({
						timestamp: chunk.timestamp,
						duration: chunk.duration,
						bytes: chunk.byteLength,
						sent,
					});
					if (meta?.decoderConfig)
						metadata = {
							...meta.decoderConfig,
							description: meta.decoderConfig.description
								? Array.from(bytes(meta.decoderConfig.description))
								: undefined,
						};
				},
				error: (error) => errors.push(String(error)),
			});
			encoder.configure(config);
			for (const input of inputs) {
				const data = new Float32Array(input.samples * 2);
				for (let i = 0; i < input.samples; i++) {
					data[i] = Math.sin(((i + sent * frame) * 440 * 2 * Math.PI) / sampleRate) * 0.2;
					data[input.samples + i] = data[i];
				}
				const audio = new AudioData({
					format: "f32-planar",
					sampleRate,
					numberOfChannels: 2,
					numberOfFrames: input.samples,
					timestamp: input.timestamp,
					data,
				});
				encoder.encode(audio);
				audio.close();
				sent++;
			}
			await encoder.flush();
			encoder.close();
			results.push({ codec, scenario, inputs, outputs, metadata, errors });
		}
	}
	return results;
}
async function boundaryProbe() {
	const result = [];
	for (const codec of ["opus", "mp4a.40.2"]) {
		const sampleRate = 48000,
			frame = codec === "opus" ? 960 : 1024;
		const config = { codec, sampleRate, numberOfChannels: 2, bitrate: 128000 };
		if (!(await AudioEncoder.isConfigSupported(config)).supported) {
			result.push({ codec, supported: false });
			continue;
		}
		const packets: EncodedAudioChunk[] = [];
		let description: AllowSharedBufferSource | undefined;
		const errors: string[] = [];
		const encoder = new AudioEncoder({
			output: (chunk, meta) => {
				packets.push(chunk);
				description = meta?.decoderConfig?.description ?? description;
			},
			error: (e) => errors.push(e.message),
		});
		encoder.configure(config);
		for (let i = 0; i < 12; i++) {
			const data = new Float32Array(frame * 2);
			if (i === 2) data[frame - 16] = 0.9;
			if (i === 3) data[frame + 16] = 0.9;
			const audio = new AudioData({
				format: "f32-planar",
				sampleRate,
				numberOfChannels: 2,
				numberOfFrames: frame,
				timestamp: 100000 + Math.round(((i * frame) / sampleRate) * 1e6) + (i >= 3 ? 900000 : 0),
				data,
			});
			encoder.encode(audio);
			audio.close();
		}
		await encoder.flush();
		encoder.close();
		const decoded: unknown[] = [];
		let total = 0;
		const maxima = [
			{ value: 0, index: 0 },
			{ value: 0, index: 0 },
		];
		const decoder = new AudioDecoder({
			output: (audio) => {
				const peaks = [];
				for (let ch = 0; ch < 2; ch++) {
					const data = new Float32Array(audio.numberOfFrames);
					audio.copyTo(data, { planeIndex: ch, format: "f32-planar" });
					let peak = 0,
						index = 0;
					for (let n = 0; n < data.length; n++) {
						if (Math.abs(data[n]) > peak) {
							peak = Math.abs(data[n]);
							index = n;
						}
						if (Math.abs(data[n]) > maxima[ch].value)
							maxima[ch] = { value: Math.abs(data[n]), index: total + n };
					}
					peaks.push({ peak, index });
				}
				decoded.push({ timestamp: audio.timestamp, frames: audio.numberOfFrames, start: total, peaks });
				total += audio.numberOfFrames;
				audio.close();
			},
			error: (e) => errors.push(e.message),
		});
		decoder.configure({ ...config, description });
		for (const packet of packets) decoder.decode(packet);
		await decoder.flush();
		decoder.close();
		result.push({
			codec,
			frame,
			inputBoundary: 3 * frame,
			inputPeaks: [3 * frame - 16, 3 * frame + 16],
			outputPeaks: maxima,
			description: description ? Array.from(bytes(description)) : undefined,
			decoded,
			errors,
		});
	}
	return result;
}
async function presentationProbe(renderGaps: boolean) {
	const result = [];
	for (const rate of [44100, 48000])
		for (const codec of ["opus", "mp4a.40.2"]) {
			const encodedRate = codec === "opus" ? 48000 : rate;
			const size = codec === "opus" ? 960 : 1024;
			const config = { codec, sampleRate: encodedRate, numberOfChannels: 2, bitrate: 128000 };
			if (!(await AudioEncoder.isConfigSupported(config)).supported) {
				result.push({ rate, codec, supported: false });
				continue;
			}
			const framer = new Framer({ sampleRate: encodedRate, channels: 2, size: { samples: size } });
			const resampler =
				rate === encodedRate ? undefined : new Resampler({ from: rate, to: encodedRate, channels: 2 });
			const packets: EncodedAudioChunk[] = [];
			let description: AllowSharedBufferSource | undefined;
			const errors: string[] = [];
			const inputPTS: number[] = [];
			let sourceFrames = 0,
				zeroFrames = 0,
				maxGapChunk = 0;
			const expectedPeaks: number[] = [];
			const encoder = new AudioEncoder({
				output: (chunk, meta) => {
					packets.push(chunk);
					description = meta?.decoderConfig?.description ?? description;
				},
				error: (e) => errors.push(e.message),
			});
			encoder.configure(config);
			const source = (async function* () {
				for (let loop = 0; loop < 8; loop++)
					for (const start of [0.02, 0.08]) {
						const data = new Float32Array(2048);
						data[32] = 0.9;
						data[1056] = 0.9;
						expectedPeaks.push((Math.round((loop * 0.125 + start) * rate) + 32) / rate);
						yield new AudioSample({
							format: "f32-planar",
							sampleRate: rate,
							numberOfChannels: 2,
							data,
							timestamp: loop * 0.125 + start,
						});
					}
			})();
			for await (const sample of renderGaps
				? fill(source, { timestamp: Time.Micro.zero })
				: source) {
				const planes = Array.from({ length: 2 }, (_, channel) => {
					const data = new Float32Array(sample.numberOfFrames);
					sample.copyTo(data, { planeIndex: channel, format: "f32-planar" });
					return data;
				});
				if (planes[0].every((v) => v === 0)) {
					zeroFrames += sample.numberOfFrames;
					maxGapChunk = Math.max(maxGapChunk, sample.numberOfFrames);
				}
				const expected = (sourceFrames * 1e6) / rate;
				if (Math.abs(sample.microsecondTimestamp - expected) > 1)
					throw Error(`source hole:${sample.microsecondTimestamp} vs${expected}`);
				sourceFrames += sample.numberOfFrames;
				const input = { timestamp: sample.microsecondTimestamp as Time.Micro, channels: planes };
				const converted = resampler ? resampler.push(input) : input;
				sample.close();
				if (!converted) continue;
				for (const framed of framer.push(converted)) {
					const expected = (inputPTS.length * size * 1e6) / encodedRate;
					if (Math.abs(framed.timestamp - expected) > 1)
						throw Error(`framer reset:${framed.timestamp} vs${expected}`);
					inputPTS.push(framed.timestamp);
					const data = new Float32Array(size * 2);
					data.set(framed.channels[0]);
					data.set(framed.channels[1], size);
					const audio = new AudioData({
						format: "f32-planar",
						sampleRate: encodedRate,
						numberOfChannels: 2,
						numberOfFrames: size,
						timestamp: framed.timestamp,
						data,
					});
					encoder.encode(audio);
					audio.close();
				}
			}
			await encoder.flush();
			encoder.close();
			const pcm: number[] = [];
			const decoder = new AudioDecoder({
				output: (sample) => {
					const data = new Float32Array(sample.numberOfFrames);
					sample.copyTo(data, { planeIndex: 0, format: "f32-planar" });
					for (const value of data) pcm.push(value);
					sample.close();
				},
				error: (e) => errors.push(e.message),
			});
			decoder.configure({ ...config, description });
			for (const chunk of packets) decoder.decode(chunk);
			await decoder.flush();
			decoder.close();
			const detected: Array<{ index: number; value: number }> = [];
			for (let i = 0; i < pcm.length; i++) {
				if (Math.abs(pcm[i]) < 0.3) continue;
				let peak = { index: i, value: Math.abs(pcm[i]) };
				const end = Math.min(pcm.length, i + Math.round(encodedRate * 0.02));
				for (; i < end; i++) if (Math.abs(pcm[i]) > peak.value) peak = { index: i, value: Math.abs(pcm[i]) };
				detected.push(peak);
			}
			if (detected.length !== expectedPeaks.length)
				throw Error(`impulse count:${detected.length} vs${expectedPeaks.length}`);
			const peaks = expectedPeaks.map((seconds, index) => ({
				expected: seconds,
				actual: detected[index].index / encodedRate,
				value: detected[index].value,
				offsetSamples: detected[index].index - Math.round(seconds * encodedRate),
			}));
			const offsets = peaks.map((peak) => peak.offsetSamples);
			if (Math.max(...offsets) - Math.min(...offsets) > 1) throw Error(`file loop drift:${offsets}`);
			if (codec === "opus" && offsets.some((offset) => Math.abs(offset) > 1))
				throw Error(`Opus source alignment:${offsets}`);
			if (errors.length) throw Error(errors.join("\n"));
			result.push({
				rate,
				codec,
				sourceFrames,
				zeroFrames,
				maxGapChunk,
				inputFrames: inputPTS.length,
				outputPackets: packets.length,
				peaks,
				errors,
			});
		}
	return result;
}

try {
	const timestamps = await timestampProbe();
	const boundary = await boundaryProbe();
	const presentation = await presentationProbe(true);
	if (presentation.filter((row) => row.codec === "opus" && !("supported" in row)).length !== 2)
		throw Error("native Opus unavailable");
	let negative: string | undefined;
	try {
		await presentationProbe(false);
	} catch (error) {
		negative = String(error);
	}
	if (!negative?.includes("source hole:"))
		throw Error(`negative control missed missing authored silence: ${negative}`);
	Reflect.set(globalThis, "result", { ok: true, timestamps, boundary, presentation, negative });
} catch (error) {
	Reflect.set(globalThis, "result", { ok: false, error: String(error) });
}

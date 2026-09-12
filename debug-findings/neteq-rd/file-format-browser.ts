/** Exercise synthetic HE-AAC files through the actual file, capture, and encoder classes. */
import { Origin, Path } from "@moq/net";
import { Effect, Signal } from "@moq/signals";
import { ALL_FORMATS, AudioSampleSink, BufferSource, Input } from "mediabunny";
import { Capture } from "../../js/publish/src/audio/capture";
import { Encoder } from "../../js/publish/src/audio/encoder";
import type { Source } from "../../js/publish/src/audio/types";
import { Broadcast } from "../../js/publish/src/broadcast";
import { File as FileSource } from "../../js/publish/src/source/file";

const NativeEncoder = AudioEncoder;
const NativeDecoder = AudioDecoder;
type Format = { sampleRate: number; numberOfChannels: number };
type InputFrame = Format & { timestamp: number; energy: number[][] };

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = performance.now() + 5000;
	while (!predicate()) {
		if (performance.now() > deadline) throw new Error("file encoder did not produce the required samples");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

async function encode(bytes: ArrayBuffer, codec: "opus" | "aac") {
	const inputs: InputFrame[] = [];
	const outputFormats: Format[] = [];
	let outputs = 0;
	let decoders = 0;
	class ObservedEncoder extends NativeEncoder {
		constructor(init: AudioEncoderInit) {
			super({
				...init,
				output: (chunk, metadata) => {
					outputs++;
					if (metadata?.decoderConfig)
						outputFormats.push({
							sampleRate: metadata.decoderConfig.sampleRate,
							numberOfChannels: metadata.decoderConfig.numberOfChannels,
						});
					init.output(chunk, metadata);
				},
			});
		}
		override encode(data: AudioData): void {
			const energy = [];
			for (let channel = 0; channel < data.numberOfChannels; channel++) {
				const plane = new Float32Array(data.numberOfFrames);
				data.copyTo(plane, { planeIndex: channel, format: "f32-planar" });
				energy.push(
					[997, 1703].map((frequency) => {
						let real = 0;
						let imaginary = 0;
						for (let index = 0; index < plane.length; index++) {
							const phase = (2 * Math.PI * frequency * index) / data.sampleRate;
							real += plane[index] * Math.cos(phase);
							imaginary += plane[index] * Math.sin(phase);
						}
						return (real * real + imaginary * imaginary) / plane.length ** 2;
					}),
				);
			}
			inputs.push({
				sampleRate: data.sampleRate,
				numberOfChannels: data.numberOfChannels,
				timestamp: data.timestamp,
				energy,
			});
			super.encode(data);
		}
	}
	class ObservedDecoder extends NativeDecoder {
		constructor(init: AudioDecoderInit) {
			super(init);
			decoders++;
		}
	}
	globalThis.AudioEncoder = ObservedEncoder;
	globalThis.AudioDecoder = ObservedDecoder;
	const effect = new Effect();
	const file = new FileSource({ file: new File([bytes], "synthetic.m4a", { type: "audio/mp4" }) });
	const input = new Signal<Source | undefined>(undefined);
	effect.run((scope) => {
		scope.set(input, scope.get(file.out.source).audio);
	});
	const capture = new Capture({ source: input });
	const origin = new Origin.Producer();
	const broadcast = new Broadcast({ origin, name: Path.from("synthetic.hang") });
	const encoder = new Encoder("audio/test", { capture, broadcast, codec });
	let subscriber: ReturnType<NonNullable<ReturnType<typeof broadcast.net.peek>>["subscribe"]> | undefined;
	try {
		await waitFor(() => !!broadcast.net.peek());
		const net = broadcast.net.peek();
		if (!net) throw new Error("missing local broadcast");
		subscriber = net.subscribe("audio/test");
		await waitFor(() => inputs.length >= 16 && outputs >= 10);
		const source = input.peek();
		const format = capture.out.format.peek();
		const catalog = encoder.out.catalog.peek();
		if (!source || !("samples" in source) || !format || !catalog) throw new Error("missing file format");
		if (
			source.sampleRate !== 48000 ||
			source.channelCount !== 2 ||
			format.sampleRate !== 48000 ||
			format.channelCount !== 2 ||
			catalog.sampleRate !== 48000 ||
			catalog.numberOfChannels !== 2
		) {
			throw new Error("source, capture, or catalog lost the actual decoded format");
		}
		if (
			!inputs.every((frame) => frame.sampleRate === 48000 && frame.numberOfChannels === 2) ||
			outputFormats.length === 0 ||
			!outputFormats.every((frame) => frame.sampleRate === 48000 && frame.numberOfChannels === 2)
		) {
			throw new Error("encoded audio lost the actual decoded format");
		}
		const energy = [0, 1].map((channel) =>
			[0, 1].map((tone) => inputs.reduce((sum, frame) => sum + frame.energy[channel][tone], 0)),
		);
		if (!(energy[0][0] > energy[0][1] * 2 && energy[1][1] > energy[1][0] * 2)) {
			throw new Error("independent stereo tones or their sample rate changed");
		}
		if (decoders !== 1) throw new Error("file source decoded the first sample twice");
		return {
			source: { sampleRate: source.sampleRate, numberOfChannels: source.channelCount },
			capture: format,
			catalog: { sampleRate: catalog.sampleRate, numberOfChannels: catalog.numberOfChannels },
			inputs: inputs.length,
			outputs,
			outputFormats,
			decoders,
			energy,
		};
	} finally {
		subscriber?.close();
		encoder.close();
		capture.close();
		file.close();
		effect.close();
		broadcast.close();
		origin.close();
		globalThis.AudioEncoder = NativeEncoder;
		globalThis.AudioDecoder = NativeDecoder;
	}
}

async function run() {
	const fixtures: { name: string; metadata: Format }[] = await (await fetch("/fixtures")).json();
	const cells = [];
	for (const fixture of fixtures) {
		const bytes = await (await fetch(`/${fixture.name}`)).arrayBuffer();
		const input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
		try {
			const track = await input.getPrimaryAudioTrack();
			if (!track) throw new Error("synthetic fixture has no audio");
			const metadata = {
				sampleRate: await track.getSampleRate(),
				numberOfChannels: await track.getNumberOfChannels(),
			};
			if (
				metadata.sampleRate !== fixture.metadata.sampleRate ||
				metadata.numberOfChannels !== fixture.metadata.numberOfChannels
			) {
				throw new Error("fixture metadata changed; reassess the mismatch regression");
			}
			// Probe the actual HE bitstream, since AAC-LC config support alone does not prove HE support.
			const samples = new AudioSampleSink(track).samples();
			let decoded: Format | undefined;
			try {
				const first = await samples.next();
				if (!first.done) {
					decoded = { sampleRate: first.value.sampleRate, numberOfChannels: first.value.numberOfChannels };
					first.value.close();
				}
			} catch (error) {
				cells.push({
					fixture: fixture.name,
					supported: false,
					stage: "HE bitstream decode",
					reason: String(error),
				});
				continue;
			} finally {
				await samples.return();
			}
			if (decoded?.sampleRate !== 48000 || decoded.numberOfChannels !== 2)
				throw new Error("HE fixture did not decode to 48000 Hz stereo");
			for (const codec of ["opus", "aac"] as const) {
				const config = {
					codec: codec === "aac" ? "mp4a.40.2" : "opus",
					sampleRate: 48000,
					numberOfChannels: 2,
				};
				if (!(await NativeEncoder.isConfigSupported(config)).supported) {
					cells.push({ fixture: fixture.name, codec, supported: false, stage: "encoder support" });
					continue;
				}
				cells.push({
					fixture: fixture.name,
					codec,
					supported: true,
					metadata,
					decoded,
					...(await encode(bytes, codec)),
				});
			}
		} finally {
			input.dispose();
		}
	}
	return { cells };
}
run().then(
	(result) => Reflect.set(globalThis, "fileFormatResult", result),
	(error) => Reflect.set(globalThis, "fileFormatResult", { error: String(error) }),
);

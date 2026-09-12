import { Time } from "@moq/net";
import { Terminal } from "../../../../../js/watch/src/audio/terminal";
import aac from "./aac-packets.json";

/** Check source timestamps after actual Opus and AAC decoding, including a missing interval. */
export async function decode(): Promise<string[]> {
	const checked: string[] = [];
	for (const codec of ["opus", "mp4a.40.2"]) {
		const config = {
			codec,
			sampleRate: 48000,
			numberOfChannels: 2,
			description: codec === "opus" ? undefined : new Uint8Array([0x11, 0x90]),
		};
		if (!(await AudioDecoder.isConfigSupported(config)).supported) {
			if (codec === "opus") throw new Error("Opus decoder unavailable");
			checked.push("AAC unavailable");
			continue;
		}
		const expected =
			codec === "opus"
				? [100000, 1000000, 1020000, 1040000, 1060000, 1080000, 1100000, 1120000]
				: [100000, 1000000, 1021333, 1042667, 1064000, 1085333, 1106667, 1128000];
		const duration = Time.Micro(codec === "opus" ? 20000 : 1024e6 / 48000);
		const terminal = new Terminal();
		const actual: number[] = [];
		const errors: string[] = [];
		const decoder = new AudioDecoder({
			output(sample) {
				try {
					for (const span of terminal.spans(sample)) actual.push(Math.round(span.timestamp));
				} finally {
					sample.close();
				}
			},
			error(error) {
				errors.push(error.message);
			},
		});
		try {
			decoder.configure(config);
			for (let i = 0; i < expected.length; i++) {
				const timestamp = Time.Micro(expected[i]);
				terminal.push({ timestamp, duration });
				decoder.decode(
					new EncodedAudioChunk({
						type: "key",
						timestamp,
						duration,
						data: new Uint8Array(codec === "opus" ? [0xf8, 0xff, 0xfe] : aac[i]),
					}),
				);
			}
			await decoder.flush();
			if (errors.length || JSON.stringify(actual) !== JSON.stringify(expected))
				throw new Error(`${codec} source timeline mismatch: ${JSON.stringify({ actual, expected, errors })}`);
			checked.push(codec);
		} finally {
			if (decoder.state !== "closed") decoder.close();
		}
	}
	return checked;
}

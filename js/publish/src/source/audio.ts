import type { Time } from "@moq/net";
import { AudioSample } from "mediabunny";

/** Render absent portions of a decoded file's presentation timeline as silence. */
export async function* fill(
	samples: AsyncIterable<AudioSample>,
	props: { timestamp: Time.Micro },
): AsyncGenerator<AudioSample, void, unknown> {
	let format: { sampleRate: number; numberOfChannels: number } | undefined;
	const origin = props.timestamp / 1_000_000;
	let cursor = 0;

	for await (const sample of samples) {
		try {
			if (sample.numberOfFrames === 0) continue;
			format ??= { sampleRate: sample.sampleRate, numberOfChannels: sample.numberOfChannels };
			const { sampleRate, numberOfChannels } = format;
			const chunk = Math.max(1, Math.round(sampleRate / 50));
			if (sample.sampleRate !== sampleRate || sample.numberOfChannels !== numberOfChannels) {
				throw new Error("decoded file audio format changed");
			}
			const start = Math.round((sample.timestamp - origin) * sampleRate);
			while (cursor < start) {
				const frames = Math.min(chunk, start - cursor);
				const silence = new AudioSample({
					format: "f32-planar",
					sampleRate,
					numberOfChannels,
					timestamp: origin + cursor / sampleRate,
					data: new Float32Array(frames * numberOfChannels),
				});
				cursor += frames;
				try {
					yield silence;
				} finally {
					silence.close();
				}
			}

			const offset = Math.max(0, cursor - start);
			if (offset >= sample.numberOfFrames) continue;
			const output = offset === 0 ? sample : sample.trim(offset);
			output.setTimestamp(origin + cursor / sampleRate);
			cursor += output.numberOfFrames;
			try {
				yield output;
			} finally {
				if (output !== sample) output.close();
			}
		} finally {
			sample.close();
		}
	}
}

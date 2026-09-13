import type { Time } from "@moq/net";
import { AudioSample } from "mediabunny";

/** The presentation the decoded samples are rendered onto: where it starts and what it sounds like. */
export interface Presentation {
	/** Wall clock time of the first frame of the presentation. */
	timestamp: Time.Micro;
	/** Frames per second of the rendered timeline. */
	sampleRate: number;
	/** Channels of the rendered timeline. */
	numberOfChannels: number;
}

// Cap one allocation at 20 ms so a long gap streams instead of materializing at once.
const CHUNK = 50;

/**
 * Render the parts of a decoded file's presentation that carry no samples as silence.
 *
 * A file can start late, hold a gap between decoded ranges, or end before the loop does. The
 * encoder cannot represent those intervals: `AudioEncoder` publishes its own continuous output
 * clock, so a gap in its input is simply removed from the encoded timeline and the audio track
 * creeps ahead of the video on every loop. Filling the gap here keeps the two in step.
 *
 * The clock is cumulative in frames rather than derived per sample, so a rate that does not divide
 * the loop evenly (44.1 kHz) does not round its way into a drift.
 */
export async function* fill(
	samples: AsyncIterable<AudioSample>,
	presentation: Presentation,
): AsyncGenerator<AudioSample, void, unknown> {
	const { sampleRate, numberOfChannels } = presentation;
	const chunk = Math.max(1, Math.round(sampleRate / CHUNK));
	const origin = presentation.timestamp / 1_000_000;
	let cursor = 0;

	for await (const sample of samples) {
		try {
			if (sample.numberOfFrames === 0) continue;
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

			// Preroll, and anything an earlier decoded range already covered, is dropped rather than
			// played twice: the cursor is the presentation, not the file's own timestamps.
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

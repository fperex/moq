import { Hex } from "@moq/hang/util";
import { Time } from "@moq/net";
import type { DecoderConfig } from "./config";

const rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/** Resolve encoded audio duration without inferring it from the next packet's timestamp. */
export function duration(
	config: DecoderConfig,
	frame: { payload: Uint8Array; duration?: Time.Micro },
): Time.Micro | undefined {
	if (frame.duration !== undefined && frame.duration > 0) return frame.duration;
	const data = frame.payload;
	if (config.codec === "opus") {
		if (data.length === 0) throw new Error("empty Opus packet");
		const toc = data[0];
		const mode = toc >> 3;
		const microseconds =
			mode >= 16
				? 2500 * 2 ** (mode & 3)
				: mode >= 12
					? 10000 * 2 ** (mode & 1)
					: [10000, 20000, 40000, 60000][mode & 3];
		const code = toc & 3;
		if (code === 3 && data.length < 2) throw new Error("missing Opus frame count");
		const count = code === 0 ? 1 : code === 3 ? data[1] & 63 : 2;
		if (count === 0 || microseconds * count > 120000) throw new Error("invalid Opus packet duration");
		return Time.Micro(microseconds * count);
	}
	if (config.codec === "mp4a.40.2") {
		if (config.description) {
			const bytes = Hex.toBytes(config.description);
			if (bytes.length < 2 || bytes[0] >> 3 !== 2) return undefined;
			const frequency = ((bytes[0] & 7) << 1) | (bytes[1] >> 7);
			const flag = frequency === 15 ? bytes[4] : bytes[1];
			if (flag === undefined) return undefined;
			const rate =
				frequency === 15
					? ((bytes[1] & 127) << 17) | (bytes[2] << 9) | (bytes[3] << 1) | (bytes[4] >> 7)
					: rates[frequency];
			if (!rate) return undefined;
			return Time.Micro(((flag & 4 ? 960 : 1024) * 1e6) / rate);
		}
		if (data.length >= 7 && data[0] === 255 && (data[1] & 246) === 240) {
			const rate = rates[(data[2] >> 2) & 15];
			if (rate) return Time.Micro((1024 * ((data[6] & 3) + 1) * 1e6) / rate);
		}
	}
	return undefined;
}

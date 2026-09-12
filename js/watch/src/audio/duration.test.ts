import { expect, test } from "bun:test";
import { AudioConfigSchema } from "@moq/hang/catalog";
import { Time } from "@moq/net";
import { duration } from "./duration";

const opus = AudioConfigSchema.parse({
	codec: "opus",
	sampleRate: 48000,
	numberOfChannels: 2,
	container: { kind: "legacy" },
});
test("Opus packet durations include every mode and frame packing count", () => {
	const expected = [
		10000, 20000, 40000, 60000, 10000, 20000, 40000, 60000, 10000, 20000, 40000, 60000, 10000, 20000, 10000, 20000,
		2500, 5000, 10000, 20000, 2500, 5000, 10000, 20000, 2500, 5000, 10000, 20000, 2500, 5000, 10000, 20000,
	];
	for (let mode = 0; mode < 32; mode++) {
		for (const stereo of [0, 4]) {
			expect(duration(opus, { payload: new Uint8Array([(mode << 3) | stereo]) })).toBe(
				Time.Micro(expected[mode]),
			);
			for (const code of [1, 2, 3])
				expect(duration(opus, { payload: new Uint8Array([(mode << 3) | stereo | code, 2]) })).toBe(
					Time.Micro(expected[mode] * 2),
				);
		}
	}
	expect(duration(opus, { payload: new Uint8Array([0x83, 48]) })).toBe(Time.Micro(120000));
});
test("malformed Opus duration fails before timeline admission", () => {
	for (const payload of [[], [0x83], [0x83, 0], [0xfb, 7]])
		expect(() => duration(opus, { payload: new Uint8Array(payload) })).toThrow();
});
test("container durations remain authoritative and unknown codecs remain supported", () => {
	expect(duration(opus, { payload: new Uint8Array(), duration: Time.Micro(7500) })).toBe(Time.Micro(7500));
	expect(duration({ ...opus, codec: "flac" }, { payload: new Uint8Array([1]) })).toBeUndefined();
});
test("AAC-LC honors frameLengthFlag and the source rate", () => {
	const config = AudioConfigSchema.parse({ ...opus, codec: "mp4a.40.2", description: "1190" });
	expect(duration(config, { payload: new Uint8Array([1]) })).toBeCloseTo(1024e6 / 48000, 8);
	expect(
		duration(AudioConfigSchema.parse({ ...config, description: "1194" }), { payload: new Uint8Array([1]) }),
	).toBe(Time.Micro(20000));
	expect(
		duration(AudioConfigSchema.parse({ ...config, sampleRate: 44100, description: "1210" }), {
			payload: new Uint8Array([1]),
		}),
	).toBeCloseTo(1024e6 / 44100, 8);
	expect(
		duration(AudioConfigSchema.parse({ ...config, description: "2b92" }), { payload: new Uint8Array([1]) }),
	).toBeUndefined();
});

test("AAC uses the bitstream rate when catalog rate disagrees", () => {
	const config = AudioConfigSchema.parse({ ...opus, codec: "mp4a.40.2", sampleRate: 44100, description: "1190" });
	expect(duration(config, { payload: new Uint8Array([1]) })).toBeCloseTo(1024e6 / 48000, 8);
	expect(
		duration(AudioConfigSchema.parse({ ...config, description: "17805dc010" }), { payload: new Uint8Array([1]) }),
	).toBeCloseTo(1024e6 / 48000, 8);
});

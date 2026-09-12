import { expect, test } from "bun:test";
import { Time } from "@moq/net";
import { AudioSample } from "mediabunny";
import { fill } from "./audio";

function sample(timestamp: number, values: number[], sampleRate = 1000): AudioSample {
	return new AudioSample({
		format: "f32-planar",
		sampleRate,
		numberOfChannels: 1,
		timestamp,
		data: new Float32Array(values),
	});
}

async function* sequence(samples: AudioSample[]) {
	for (const sample of samples) yield sample;
}

async function collect(samples: AsyncIterable<AudioSample>) {
	const values: number[] = [];
	const timestamps: number[] = [];
	const lengths: number[] = [];
	for await (const sample of samples) {
		const data = new Float32Array(sample.numberOfFrames);
		sample.copyTo(data, { planeIndex: 0 });
		values.push(...data);
		timestamps.push(sample.microsecondTimestamp);
		lengths.push(sample.numberOfFrames);
	}
	return { values, timestamps, lengths };
}

const props = { timestamp: Time.Micro(100_000) };

test("file presentation fills leading and interior gaps with bounded silence", async () => {
	const rendered = await collect(fill(sequence([sample(0.125, [0.5, -0.5]), sample(0.14, [0.25, -0.25])]), props));
	expect(rendered.values).toEqual([...Array(25).fill(0), 0.5, -0.5, ...Array(13).fill(0), 0.25, -0.25]);
	expect(rendered.timestamps).toEqual([100_000, 120_000, 125_000, 127_000, 140_000]);
	expect(rendered.lengths).toEqual([20, 5, 2, 13, 2]);
});

test("contiguous decoded file samples pass through without another PCM copy", async () => {
	const first = sample(0.1, [0.5, -0.5]);
	const second = sample(0.102, [0.25, -0.25]);
	const output = fill(sequence([first, second]), props);
	expect((await output.next()).value).toBe(first);
	expect((await output.next()).value).toBe(second);
	expect((await output.next()).done).toBe(true);
});

test("presentation excludes preroll and samples already covered by an earlier decoded range", async () => {
	const rendered = await collect(
		fill(sequence([sample(0.098, [9, 8, 0.5, -0.5]), sample(0.101, [7, 0.25, -0.25])]), props),
	);
	expect(rendered.values).toEqual([0.5, -0.5, 0.25, -0.25]);
	expect(rendered.timestamps).toEqual([100_000, 102_000]);
});

test("file loop tails and lead-ins share one cumulative fractional sample clock", async () => {
	const sampleRate = 44_100;
	const input = Array.from({ length: 16 }, (_, loop) => sample(0.1 + loop * 0.125 + 0.02, [0.5, -0.5], sampleRate));
	const rendered = await collect(fill(sequence(input), props));
	const impulses = rendered.values.flatMap((value, index) => (value === 0.5 ? [index] : []));
	expect(impulses).toEqual([
		882, 6395, 11907, 17420, 22932, 28445, 33957, 39470, 44982, 50495, 56007, 61520, 67032, 72545, 78057, 83570,
	]);
	expect(rendered.lengths.every((length) => length <= 882)).toBe(true);
});

test("cancelling during a file gap releases the pending decoded sample and source iterator", async () => {
	const pending = sample(10, [0.5]);
	let returned = false;
	async function* source() {
		try {
			yield pending;
		} finally {
			returned = true;
		}
	}
	const output = fill(source(), props);
	const first = await output.next();
	expect(first.value?.numberOfFrames).toBe(20);
	await output.return();
	expect(returned).toBe(true);
	expect(() => pending.copyTo(new Float32Array(1), { planeIndex: 0 })).toThrow("closed");
});

test("decode failure remains an error instead of fabricated file content", async () => {
	async function* source() {
		yield sample(0.1, [0.5]);
		throw new Error("file decode failed");
	}
	await expect(collect(fill(source(), props))).rejects.toThrow("file decode failed");
});

test("file presentation uses the first decoded format instead of encoded track metadata", async () => {
	const decoded = new AudioSample({
		format: "f32-planar",
		sampleRate: 48_000,
		numberOfChannels: 2,
		timestamp: 0.101,
		data: new Float32Array([0.5, -0.5, 0.25, -0.25]),
	});
	const output = fill(sequence([decoded]), props);
	const leading = await output.next();
	expect(leading.value?.sampleRate).toBe(48_000);
	expect(leading.value?.numberOfChannels).toBe(2);
	expect(leading.value?.numberOfFrames).toBe(48);
	expect(leading.value?.microsecondTimestamp).toBe(100_000);
	expect((await output.next()).value).toBe(decoded);
	expect((await output.next()).done).toBe(true);
});

test("a later decoded format change remains an error", async () => {
	await expect(collect(fill(sequence([sample(0.1, [0.5]), sample(0.101, [0.25], 2000)]), props))).rejects.toThrow(
		"decoded file audio format changed",
	);
});

test("empty decoded samples do not select the file presentation format", async () => {
	const empty = sample(0.1, [], 24_000);
	const actual = sample(0.1, [0.5, -0.5], 48_000);
	const output = fill(sequence([empty, actual]), props);
	expect((await output.next()).value).toBe(actual);
	expect((await output.next()).done).toBe(true);
});

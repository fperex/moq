import { describe, expect, test } from "bun:test";
import { Time } from "@moq/net";
import { AudioRingBuffer } from "./ring-buffer";
import { allocSharedRingBuffer, SharedRingBuffer } from "./shared-ring-buffer";

for (const shared of [false, true]) {
	describe(`${shared ? "shared" : "message"} ring accounting`, () => {
		const create = (buffered = false) => {
			if (!shared) return new AudioRingBuffer({ rate: 1000, channels: 1, latency: Time.Milli(100), buffered });
			const ring = new SharedRingBuffer(allocSharedRingBuffer(1, 275, 1000, buffered));
			ring.setLatency(100);
			return ring;
		};
		const write = (ring: AudioRingBuffer | SharedRingBuffer, at: number) => {
			const pcm = [new Float32Array(50).fill(0.5)];
			if (ring instanceof AudioRingBuffer) ring.write(Time.Micro(at * 1000), pcm);
			else ring.insert(Time.Micro(at * 1000), pcm);
		};

		test("overflow advances the playing timeline and counts the exact skipped media", () => {
			const ring = create();
			for (let at = 0; at < 150; at += 50) write(ring, at);
			ring.read([new Float32Array(20)]);
			for (let at = 150; at < 600; at += 50) write(ring, at);
			expect(ring.debug().jumps).toBe(0);
			expect(ring.timestamp).toBe(Time.Micro((shared ? 88 : 400) * 1000));
			const pcm = [new Float32Array(20)];
			expect(ring.read(pcm)).toBe(20);
			expect(Array.from(pcm[0])).toEqual(Array(20).fill(0.5));
			const debug = ring.debug();
			expect(debug.backend).toBe(shared ? "shared" : "message");
			expect(debug.jumps).toBe(1);
			expect(debug.jumped).toBe(shared ? 68 : 380);
			expect(debug.discarded).toBe(shared ? 68 : 380);
		});

		test("repeated startup overflow is not an observed playback jump", () => {
			const ring = create(true);
			for (let at = 0; at < 1200; at += 50) write(ring, at);
			expect(ring.debug().skips).toBe(0);
			expect(ring.debug().skipped).toBe(0);
			expect(ring.debug().jumps).toBe(0);
			expect(ring.read([new Float32Array(20)])).toBe(20);
			expect(ring.debug().jumps).toBe(0);
			expect(ring.debug().jumped).toBe(0);
		});

		test("late duplicate writes discard input without skipping playback", () => {
			const ring = create();
			for (let at = 0; at < 150; at += 50) write(ring, at);
			ring.read([new Float32Array(100)]);
			write(ring, 0);
			expect(ring.debug().discarded).toBe(50);
			expect(ring.debug().skips).toBe(0);
			expect(ring.debug().skipped).toBe(0);
			expect(ring.debug().jumps).toBe(0);
			expect(ring.timestamp).toBe(Time.Micro(100_000));
		});
	});
}

test("shrinking a playing message ring counts the dropped media", () => {
	const ring = new AudioRingBuffer({ rate: 1000, channels: 1, latency: Time.Milli(400) });
	for (let at = 0; at < 800; at += 100) ring.write(Time.Micro(at * 1000), [new Float32Array(100).fill(0.5)]);
	ring.read([new Float32Array(20)]);
	ring.resize(Time.Milli(100));
	expect(ring.debug().jumps).toBe(0);
	expect(ring.timestamp).toBe(Time.Micro(525_000));
	expect(ring.read([new Float32Array(20)])).toBe(20);
	expect(ring.debug().jumps).toBe(1);
	expect(ring.debug().jumped).toBe(205);
});

test("shrinking a message ring before playback trims instead of skipping", () => {
	const post = new AudioRingBuffer({ rate: 1000, channels: 1, latency: Time.Milli(400) });
	for (let at = 0; at < 500; at += 100) post.write(Time.Micro(at * 1000), [new Float32Array(100).fill(0.5)]);
	post.resize(Time.Milli(100));
	expect(post.read([new Float32Array(20)])).toBe(20);
	expect(post.debug().jumps).toBe(0);
	expect(post.debug().jumped).toBe(0);
});

for (const consumed of [0, 20]) {
	test(`handoff counts only unheard overflow after ${consumed} initial samples`, () => {
		const source = new SharedRingBuffer(allocSharedRingBuffer(1, 128, 1000, true));
		source.setLatency(50);
		for (const at of [0, 50]) source.insert(Time.Micro(at * 1000), [new Float32Array(50).fill(0.5)]);
		if (consumed) expect(source.read([new Float32Array(consumed)])).toBe(consumed);
		const replacement = source.resize(256);
		replacement.insert(Time.Micro(100_000), [new Float32Array(300).fill(0.5)]);
		expect(source.read([new Float32Array(40)])).toBe(40);
		const reader = new SharedRingBuffer(replacement.init, source);
		expect(replacement.debug().jumps).toBe(0);
		expect(reader.read([new Float32Array(20)])).toBe(20);
		expect(replacement.debug().jumps).toBe(1);
		expect(replacement.debug().jumped).toBe(104 - consumed);
	});
}

test("an overflow that invalidates a reader commit is counted only after media resumes", () => {
	const ring = new SharedRingBuffer(allocSharedRingBuffer(1, 128, 1000, true));
	ring.setLatency(50);
	for (const at of [0, 50]) ring.insert(Time.Micro(at * 1000), [new Float32Array(50).fill(0.5)]);
	ring.read([new Float32Array(20)]);
	ring.view();
	ring.peek([new Float32Array(20)], 20);
	ring.insert(Time.Micro(100_000), [new Float32Array(200).fill(0.5)]);
	expect(ring.commit(20)).toBe(false);
	expect(ring.debug().jumps).toBe(0);
	expect(ring.read([new Float32Array(20)])).toBe(20);
	expect(ring.debug().jumps).toBe(1);
	expect(ring.debug().jumped).toBe(152);
});

for (const incoming of [60, 200]) {
	test(`overflow accounts for a concurrent reader before inserting ${incoming} samples`, () => {
		const writer = new SharedRingBuffer(allocSharedRingBuffer(1, 128, 1000, true));
		writer.setLatency(50);
		for (const at of [0, 50]) writer.insert(Time.Micro(at * 1000), [new Float32Array(50).fill(0.5)]);
		const reader = new SharedRingBuffer(writer.init);
		expect(reader.read([new Float32Array(20)])).toBe(20);
		const exchange = Atomics.compareExchange;
		const atomics = Atomics as { compareExchange: unknown };
		let raced = false;
		atomics.compareExchange = (array: BigInt64Array, index: number, expected: bigint, next: bigint) => {
			if (!raced && array.buffer === writer.init.state) {
				raced = true;
				const output = [new Float32Array(40)];
				expect(reader.read(output)).toBe(40);
				expect(output[0]).toEqual(new Float32Array(40).fill(0.5));
			}
			return exchange(array, index, expected, next);
		};
		try {
			writer.insert(Time.Micro(100_000), [new Float32Array(incoming).fill(0.5)]);
		} finally {
			atomics.compareExchange = exchange;
		}
		expect(raced).toBe(true);
		expect(writer.debug().discarded).toBe(incoming === 60 ? 0 : 112);
		expect(reader.read([new Float32Array(20)])).toBe(20);
		expect(writer.debug().jumped).toBe(incoming === 60 ? 0 : 112);
	});
}

test("a handoff to a reset timeline does not observe the previous cursor as a jump", () => {
	const source = new SharedRingBuffer(allocSharedRingBuffer(1, 128, 1000, true));
	source.setLatency(50);
	for (const at of [0, 50]) source.insert(Time.Micro(at * 1000), [new Float32Array(50).fill(0.5)]);
	source.read([new Float32Array(20)]);
	const replacement = source.resize(256);
	replacement.reset();
	for (const at of [1000, 1050]) replacement.insert(Time.Micro(at * 1000), [new Float32Array(50).fill(0.5)]);
	const reader = new SharedRingBuffer(replacement.init, source);
	expect(reader.read([new Float32Array(20)])).toBe(20);
	expect(replacement.debug().jumps).toBe(0);
	expect(replacement.debug().jumped).toBe(0);
	expect(replacement.timestamp).toBe(Time.Micro(1_020_000));
});

test("handoff preserves a late observation even when the replacement resets", () => {
	const source = new SharedRingBuffer(allocSharedRingBuffer(1, 128, 1000, true));
	source.setLatency(50);
	for (const at of [0, 50]) source.insert(Time.Micro(at * 1000), [new Float32Array(50).fill(0.5)]);
	source.read([new Float32Array(20)]);
	source.insert(Time.Micro(100_000), [new Float32Array(200).fill(0.5)]);
	const replacement = source.resize(256);
	expect(source.read([new Float32Array(20)])).toBe(20);
	replacement.reset();
	for (const at of [1000, 1050]) replacement.insert(Time.Micro(at * 1000), [new Float32Array(50).fill(0.5)]);
	const reader = new SharedRingBuffer(replacement.init, source);
	expect(reader.read([new Float32Array(20)])).toBe(20);
	expect(replacement.debug().jumps).toBe(1);
	expect(replacement.debug().jumped).toBe(152);
});

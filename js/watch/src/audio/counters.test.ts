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
			const debug = ring.debug();
			expect(debug.backend).toBe(shared ? "shared" : "message");
			expect(debug.skips).toBeGreaterThan(0);
			expect(debug.skipped).toBe(shared ? 68 : 380);
			expect(debug.discarded).toBe(0);
			expect(ring.timestamp).toBe(Time.Micro((shared ? 88 : 400) * 1000));
			const pcm = [new Float32Array(20)];
			expect(ring.read(pcm)).toBe(20);
			expect(Array.from(pcm[0])).toEqual(Array(20).fill(0.5));
		});

		test("repeated overflow before any read remains startup trimming", () => {
			const ring = create(true);
			for (let at = 0; at < 1200; at += 50) write(ring, at);
			expect(ring.debug().skips).toBe(0);
			expect(ring.debug().skipped).toBe(0);
			expect(ring.debug().trimmed).toBe(shared ? 688 : 1000);
		});

		test("late duplicate writes discard input without skipping playback", () => {
			const ring = create();
			for (let at = 0; at < 150; at += 50) write(ring, at);
			ring.read([new Float32Array(100)]);
			write(ring, 0);
			expect(ring.debug().discarded).toBe(50);
			expect(ring.debug().skips).toBe(0);
			expect(ring.debug().skipped).toBe(0);
			expect(ring.timestamp).toBe(Time.Micro(100_000));
		});
	});
}

test("shrinking a playing message ring counts the dropped media", () => {
	const ring = new AudioRingBuffer({ rate: 1000, channels: 1, latency: Time.Milli(400) });
	for (let at = 0; at < 800; at += 100) ring.write(Time.Micro(at * 1000), [new Float32Array(100).fill(0.5)]);
	ring.read([new Float32Array(20)]);
	ring.resize(Time.Milli(100));
	expect(ring.debug().skips).toBe(1);
	expect(ring.debug().skipped).toBe(205);
	expect(ring.timestamp).toBe(Time.Micro(525_000));
});

test("shrinking a message ring before playback trims instead of skipping", () => {
	const post = new AudioRingBuffer({ rate: 1000, channels: 1, latency: Time.Milli(400) });
	for (let at = 0; at < 500; at += 100) post.write(Time.Micro(at * 1000), [new Float32Array(100).fill(0.5)]);
	post.resize(Time.Milli(100));
	expect(post.debug().trimmed).toBe(225);
	expect(post.debug().skipped).toBe(0);
});

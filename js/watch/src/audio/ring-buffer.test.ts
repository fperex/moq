import { describe, expect, it } from "bun:test";
import { Time } from "@moq/net";
import * as Playout from "./playout";
import { AudioRingBuffer } from "./ring-buffer";

// The band the reader's time stretch converges across, which the ring has to be able to hold above
// its target on top of the target itself. 75 samples at the 1kHz rate most of these tests use.
const SKIP = Playout.frames(1000, Playout.STRETCH_BOUND);

function read(buffer: AudioRingBuffer, samples: number, channelCount = 2): Float32Array[] {
	const output: Float32Array[] = [];
	for (let i = 0; i < channelCount; i++) {
		output.push(new Float32Array(samples));
	}
	const samplesRead = buffer.read(output);
	// Return the output arrays with only the read samples
	if (samplesRead < samples) {
		return output.map((channel) => channel.slice(0, samplesRead));
	}
	return output;
}

function write(
	buffer: AudioRingBuffer,
	timestamp: Time.Milli,
	samples: number,
	props?: { channels?: number; value?: number },
): void {
	const channelCount = props?.channels ?? buffer.channels;
	const data: Float32Array[] = [];
	for (let i = 0; i < channelCount; i++) {
		const channel = new Float32Array(samples);
		channel.fill(props?.value ?? 1.0);
		data.push(channel);
	}
	buffer.write(Time.Micro.fromMilli(timestamp), data);
}

/**
 * Write `samples` as a run of `chunk`-sized writes starting at `timestamp`.
 *
 * The ring holds the target with one chunk on top, so a test that wants a ring that plays has to
 * arrive the way a decoder does: several chunks, not one big one. The rate is 1000 in these tests,
 * so a sample is a millisecond.
 */
function writeChunks(
	buffer: AudioRingBuffer,
	timestamp: number,
	samples: number,
	chunk: number,
	props?: { channels?: number; value?: number },
): void {
	for (let i = 0; i < samples; i += chunk) {
		write(buffer, (timestamp + i) as Time.Milli, Math.min(chunk, samples - i), props);
	}
}

/** Fill the ring with `samples` as two halves, which un-stalls a ring targeting half of them. */
function fill(
	buffer: AudioRingBuffer,
	timestamp: number,
	samples: number,
	props?: { channels?: number; value?: number },
): void {
	writeChunks(buffer, timestamp, samples, Math.ceil(samples / 2), props);
}

describe("initialization", () => {
	it("should initialize with valid parameters", () => {
		const buffer = new AudioRingBuffer({ rate: 48000, channels: 2, latency: 100 as Time.Milli });

		// Capacity is twice the target plus the stretch band: the ring has to be able to hold the
		// slack the overflow band tolerates, or every chunk arriving on a full ring would drop the
		// oldest samples.
		expect(buffer.capacity).toBe(9600 + Playout.frames(48000, Playout.STRETCH_BOUND)); // 48000 * 0.1 * 2, plus the band
		expect(buffer.length).toBe(0);
	});

	it("should throw on invalid channel count", () => {
		expect(() => new AudioRingBuffer({ rate: 48000, channels: 0, latency: 100 as Time.Milli })).toThrow(
			/invalid channels/,
		);
	});

	it("should throw on invalid sample rate", () => {
		expect(() => new AudioRingBuffer({ rate: 0, channels: 2, latency: 100 as Time.Milli })).toThrow(
			/invalid sample rate/,
		);
	});

	it("should throw on invalid latency", () => {
		expect(() => new AudioRingBuffer({ rate: 48000, channels: 2, latency: 0 as Time.Milli })).toThrow(
			/invalid latency/,
		);
	});
});

describe("writing data", () => {
	it("should write continuous data", () => {
		const buffer = new AudioRingBuffer({ rate: 1000, channels: 2, latency: 100 as Time.Milli });

		// Write 10 samples at timestamp 0
		write(buffer, 0 as Time.Milli, 10, { channels: 2, value: 1.0 });
		expect(buffer.length).toBe(10);

		// Write 10 more samples at timestamp 10ms
		write(buffer, 10 as Time.Milli, 10, { channels: 2, value: 2.0 });
		expect(buffer.length).toBe(20);
	});

	it("should handle gaps by filling with zeros", () => {
		const buffer = new AudioRingBuffer({ rate: 1000, channels: 2, latency: 50 as Time.Milli });

		// Write at timestamp 0
		write(buffer, 0 as Time.Milli, 10, { channels: 2, value: 1.0 });

		// Write at timestamp 20ms (sample 20), creating a 10 sample gap
		write(buffer, 20 as Time.Milli, 10, { channels: 2, value: 2.0 });

		// Should have filled the gap with zeros
		expect(buffer.length).toBe(30); // 10 + 10 (gap) + 10

		// Exit stalled mode by filling buffer
		fill(buffer, 30, 70, { channels: 2, value: 0.0 });
		expect(buffer.stalled).toBe(false);

		// Read and verify the gap was filled with zeros
		const output = read(buffer, 30, 2);
		expect(output[0].length).toBe(30);

		// First 10 samples should be 1.0
		for (let i = 0; i < 10; i++) {
			expect(output[0][i]).toBe(1.0);
			expect(output[1][i]).toBe(1.0);
		}
		// Next 10 samples should be 0 (the gap)
		for (let i = 10; i < 20; i++) {
			expect(output[0][i]).toBe(0);
			expect(output[1][i]).toBe(0);
		}
		// Last 10 samples should be 2.0
		for (let i = 20; i < 30; i++) {
			expect(output[0][i]).toBe(2.0);
			expect(output[1][i]).toBe(2.0);
		}
	});

	it("should handle late-arriving samples (out-of-order writes)", () => {
		const buffer = new AudioRingBuffer({ rate: 1000, channels: 1, latency: 50 as Time.Milli });

		// Fill buffer to exit stalled mode
		fill(buffer, 0, 100, { channels: 1, value: 0.0 });
		expect(buffer.stalled).toBe(false);

		// Read 50 samples to advance read pointer to 50
		read(buffer, 50, 1);

		// Write at timestamp 120ms (sample 120) - this creates a gap from 100-120
		write(buffer, 120 as Time.Milli, 10, { channels: 1, value: 1.0 });

		// Now write data that fills part of the gap at timestamp 110ms (sample 110)
		// This should work because readIndex is at 50, so sample 110 is still ahead
		write(buffer, 110 as Time.Milli, 10, { channels: 1, value: 2.0 });

		// We should have samples from 50-99 (original), gap 100-109 (zeros), 110-119 (2.0), 120-129 (1.0)
		expect(buffer.length).toBe(80); // 130 - 50

		// Skip the old samples and gap
		read(buffer, 60, 1); // Read samples 50-109

		// Read and verify the out-of-order writes
		const output = read(buffer, 20, 1);
		expect(output[0].length).toBe(20);

		// First 10 samples should be 2.0 (the late-arriving data at 110-119)
		for (let i = 0; i < 10; i++) {
			expect(output[0][i]).toBe(2.0);
		}
		// Next 10 samples should be 1.0 (the earlier write at 120-129)
		for (let i = 10; i < 20; i++) {
			expect(output[0][i]).toBe(1.0);
		}
	});

	it("should discard samples that are too old", () => {
		const buffer = new AudioRingBuffer({ rate: 1000, channels: 2, latency: 50 as Time.Milli });

		// Exit stalled mode by filling buffer
		fill(buffer, 0, 100, { channels: 2, value: 0.0 });
		expect(buffer.stalled).toBe(false);

		// Read 60 samples, readIndex now at 60
		read(buffer, 60, 2);

		// Write 50 new samples at timestamp 100
		write(buffer, 100 as Time.Milli, 50, { channels: 2, value: 1.0 });
		expect(buffer.length).toBe(90); // 150 - 60

		// Read 10 more samples, readIndex now at 70
		read(buffer, 10, 2);
		expect(buffer.length).toBe(80); // 150 - 70

		// Try to write data that's before the read index (at sample 50, which is before 70)
		write(buffer, 50 as Time.Milli, 5, { channels: 2, value: 2.0 }); // These should be ignored

		// Available should still be 80 (unchanged because old samples were discarded)
		expect(buffer.length).toBe(80);
	});

	it("should not throw when writing to buffer", () => {
		const buffer = new AudioRingBuffer({ rate: 1000, channels: 2, latency: 100 as Time.Milli });
		// The current implementation doesn't require initialization
		expect(() => write(buffer, 0 as Time.Milli, 10, { channels: 2, value: 0.0 })).not.toThrow();
	});
});

describe("reading data", () => {
	it("should read available data", () => {
		const buffer = new AudioRingBuffer({ rate: 1000, channels: 2, latency: 50 as Time.Milli });

		// Exit stalled mode by filling the buffer
		fill(buffer, 0, 100, { channels: 2, value: 0.0 });
		// Buffer should now be out of stalled mode
		expect(buffer.stalled).toBe(false);

		// Read some samples to make room (readIndex at 80)
		read(buffer, 80, 2);
		expect(buffer.length).toBe(20); // 100 - 80

		// Write 20 samples at the current position
		write(buffer, 100 as Time.Milli, 20, { channels: 2, value: 1.5 });
		expect(buffer.length).toBe(40); // 120 - 80

		// First read the remaining old samples (80-99)
		const output1 = read(buffer, 20, 2);
		expect(output1[0].length).toBe(20);
		for (let channel = 0; channel < 2; channel++) {
			for (let i = 0; i < 20; i++) {
				expect(output1[channel][i]).toBe(0.0);
			}
		}

		// Now read the new samples (100-109)
		const output2 = read(buffer, 10, 2);
		expect(output2[0].length).toBe(10);
		expect(buffer.length).toBe(10); // 120 - 110

		// Verify the new data
		for (let channel = 0; channel < 2; channel++) {
			for (let i = 0; i < 10; i++) {
				expect(output2[channel][i]).toBe(1.5);
			}
		}
	});

	it("should handle partial reads", () => {
		const buffer = new AudioRingBuffer({ rate: 1000, channels: 2, latency: 50 as Time.Milli });

		// Exit stalled mode by filling the buffer
		fill(buffer, 0, 100, { channels: 2, value: 0.0 });
		expect(buffer.stalled).toBe(false);

		// Read some to make room (readIndex at 80)
		read(buffer, 80, 2);

		// Write 20 samples
		write(buffer, 100 as Time.Milli, 20, { channels: 2, value: 1.0 });
		expect(buffer.length).toBe(40); // 120 - 80

		// Try to read 50 samples (only 40 available)
		const output = read(buffer, 50, 2);

		expect(output[0].length).toBe(40);
		expect(buffer.length).toBe(0);
	});

	it("should return 0 when no data available", () => {
		const buffer = new AudioRingBuffer({ rate: 1000, channels: 2, latency: 100 as Time.Milli });

		const output = read(buffer, 10, 2);
		expect(output[0].length).toBe(0);
	});

	it("should return 0 when not initialized", () => {
		const buffer = new AudioRingBuffer({ rate: 1000, channels: 2, latency: 100 as Time.Milli });
		const output = read(buffer, 10, 2);
		expect(output[0].length).toBe(0);
	});
});

describe("stall behavior", () => {
	it("should start in stalled mode", () => {
		const buffer = new AudioRingBuffer({ rate: 1000, channels: 2, latency: 100 as Time.Milli });
		expect(buffer.stalled).toBe(true);

		// Should not output anything in stalled mode
		write(buffer, 0 as Time.Milli, 50, { channels: 2, value: 1.0 });
		const output = read(buffer, 10, 2);
		expect(output[0].length).toBe(0);
	});

	it("should exit stalled mode when buffer is full", () => {
		const buffer = new AudioRingBuffer({ rate: 1000, channels: 2, latency: 50 as Time.Milli });

		// Fill the buffer completely
		write(buffer, 0 as Time.Milli, 100, { channels: 2, value: 1.0 });

		// Write more data to trigger overflow handling
		write(buffer, 10 as Time.Milli, 50, { channels: 2, value: 2.0 }); // This should exit stalled mode

		expect(buffer.stalled).toBe(false);

		// Now we should be able to read
		const output = read(buffer, 10, 2);
		expect(output[0].length).toBe(10);
	});
});

describe("ring buffer wrapping", () => {
	// 400 sample target, so 875 samples of capacity. The ring holds the target plus one 200 sample
	// chunk, and skips only past the 75 sample stretch band above that.
	const TARGET = 400;
	const CHUNK = 200;
	const HOLD = TARGET + CHUNK;
	const BAND = HOLD + SKIP;

	it("tolerates a burst that drains again", () => {
		const buffer = new AudioRingBuffer({ rate: 1000, channels: 1, latency: TARGET as Time.Milli });

		writeChunks(buffer, 0, HOLD, CHUNK, { channels: 1, value: 1.0 });
		expect(buffer.stalled).toBe(false);
		expect(read(buffer, 400, 1)[0].length).toBe(400);

		// A flush lands several chunks at once, taking the ring past the band in one go. It drains
		// back before the next one, so the trough never rises and nothing is dropped: the reader's
		// time stretch is what walks it back down.
		write(buffer, 600 as Time.Milli, 200, { channels: 1, value: 2.0 });
		write(buffer, 800 as Time.Milli, 200, { channels: 1, value: 3.0 });
		write(buffer, 1000 as Time.Milli, 200, { channels: 1, value: 4.0 });
		expect(buffer.length).toBeGreaterThan(BAND);

		// And it all plays: abs 400-1199, so 2.0 arrives where the first writes left off.
		expect(read(buffer, 800, 1)[0].length).toBe(800);
	});

	it("drops back to the hold level once the surplus outlasts a window of playback", () => {
		const buffer = new AudioRingBuffer({ rate: 1000, channels: 1, latency: TARGET as Time.Milli });

		writeChunks(buffer, 0, HOLD, CHUNK, { channels: 1, value: 1.0 });
		expect(buffer.stalled).toBe(false);

		// Two hundred samples in, a hundred out: the trough climbs past the band and stays there,
		// which is a publisher running faster than real time rather than a burst.
		let media = HOLD;
		let dropped = false;
		for (let i = 0; i < 20; i++) {
			write(buffer, media as Time.Milli, 200, { channels: 1, value: 2.0 });
			media += 200;
			read(buffer, 100, 1);
			if (buffer.length <= HOLD) dropped = true;
			expect(buffer.length).toBeLessThanOrEqual(buffer.capacity);
		}

		expect(dropped).toBe(true);
		// Nothing stale survived the wrap: everything past the first writes is the second value.
		const output = read(buffer, 100, 1);
		expect(output[0].every((sample) => sample === 2.0)).toBe(true);
	});
});

describe("multi-channel handling", () => {
	it("should handle stereo data correctly", () => {
		const buffer = new AudioRingBuffer({ rate: 1000, channels: 2, latency: 50 as Time.Milli });

		// Exit stalled mode by filling buffer
		fill(buffer, 0, 100, { channels: 2, value: 0.5 });
		expect(buffer.stalled).toBe(false);

		// Read some to make room
		read(buffer, 80, 2);

		// Write stereo data with same value for both channels
		write(buffer, 100 as Time.Milli, 20, { channels: 2, value: 1.5 });

		// Read and verify
		const output = read(buffer, 20, 2);
		expect(output[0].length).toBe(20);
		expect(output[1].length).toBe(20);

		// Both channels should have the same data
		for (let i = 0; i < 20; i++) {
			expect(output[0][i]).toBe(0.5);
			expect(output[1][i]).toBe(0.5);
		}

		// Read the next batch
		const output2 = read(buffer, 20, 2);
		for (let i = 0; i < 20; i++) {
			expect(output2[0][i]).toBe(1.5);
			expect(output2[1][i]).toBe(1.5);
		}
	});
});

describe("edge cases", () => {
	it("should throw when output array has wrong channel count", () => {
		const buffer = new AudioRingBuffer({ rate: 1000, channels: 2, latency: 100 as Time.Milli });
		write(buffer, 0 as Time.Milli, 50, { channels: 2, value: 1.0 });

		const output: Float32Array[] = [];
		// Current implementation throws when channel count doesn't match
		expect(() => buffer.read(output)).toThrow(/wrong number of channels/);
	});

	it("should handle zero-length output buffers", () => {
		const buffer = new AudioRingBuffer({ rate: 1000, channels: 2, latency: 100 as Time.Milli });
		write(buffer, 0 as Time.Milli, 50, { channels: 2, value: 1.0 });

		const output = [new Float32Array(0), new Float32Array(0)];
		const samplesRead = buffer.read(output);
		expect(samplesRead).toBe(0);
	});

	it("should handle fractional timestamps", () => {
		const buffer = new AudioRingBuffer({ rate: 1000, channels: 2, latency: 50 as Time.Milli });

		// Exit stalled mode first
		write(buffer, 0 as Time.Milli, 100, { channels: 2, value: 0.0 });
		write(buffer, 10 as Time.Milli, 10, { channels: 2, value: 0.0 }); // This exits stalled mode
		read(buffer, 110, 2);

		// Write with fractional timestamp that rounds
		write(buffer, 1105 as Time.Milli, 10, { channels: 2, value: 1.0 }); // 110.5 samples, rounds to 111
		write(buffer, 1204 as Time.Milli, 10, { channels: 2, value: 2.0 }); // 120.4 samples, rounds to 120

		const output = read(buffer, 20, 2);
		expect(output[0].length).toBeGreaterThan(0);
	});
});

describe("resize", () => {
	it("should resize to a larger buffer", () => {
		const buffer = new AudioRingBuffer({ rate: 1000, channels: 1, latency: 100 as Time.Milli });
		expect(buffer.capacity).toBe(200 + SKIP);

		// Write 50 samples
		write(buffer, 0 as Time.Milli, 50, { channels: 1, value: 1.0 });
		expect(buffer.length).toBe(50);

		// Resize to larger buffer (200ms = 200 samples)
		buffer.resize(200 as Time.Milli);

		expect(buffer.capacity).toBe(400 + SKIP);
		expect(buffer.length).toBe(50); // Samples preserved
		expect(buffer.stalled).toBe(true); // Should trigger stall
	});

	it("should resize to a smaller buffer and keep the most recent samples", () => {
		const buffer = new AudioRingBuffer({ rate: 1000, channels: 1, latency: 100 as Time.Milli });
		expect(buffer.capacity).toBe(200 + SKIP);

		// Write 250 samples in 50 sample chunks: 150 with value 1.0, the rest with 2.0. The reader
		// takes a block once the ring holds its level, because until it has the writer starts the
		// playhead at the newest audio less that level rather than letting a fill run deep: a ring only
		// sits above what it holds once playback is under way.
		writeChunks(buffer, 0, 150, 50, { channels: 1, value: 1.0 });
		expect(read(buffer, 50, 1)[0].length).toBe(50);
		writeChunks(buffer, 150, 100, 50, { channels: 1, value: 2.0 });
		expect(buffer.length).toBe(200);

		// Resize to a 30 sample target. Capacity is the level the ring holds, the 30 sample target
		// with the 50 sample chunk on top, plus the band. Everything past it is dropped from the
		// front, so the window that survives ends where the old one did.
		buffer.resize(30 as Time.Milli);

		const capacity = 30 + 50 + SKIP;
		expect(buffer.capacity).toBe(capacity);
		expect(buffer.length).toBe(capacity); // Truncated to new capacity
		expect(Time.Milli.fromMicro(buffer.timestamp)).toBe((250 - capacity) as Time.Milli);
	});

	it("keeps the timeline when every buffered sample fits", () => {
		// Capacity follows the target, so every step of it moves the samples into an array of a new
		// size. Nothing was skipped, so the reader must not be told to forget what it learned.
		const buffer = new AudioRingBuffer({ rate: 1000, channels: 1, latency: 40 as Time.Milli });
		writeChunks(buffer, 0, 60, 20, { channels: 1, value: 1.0 });
		expect(read(buffer, 20, 1)[0].length).toBe(20);
		write(buffer, 60 as Time.Milli, 20, { channels: 1, value: 2.0 });
		const generation = buffer.view().generation;

		buffer.resize(60 as Time.Milli);
		expect(buffer.capacity).toBe(120 + SKIP);
		expect(buffer.length).toBe(60);
		expect(buffer.view().generation).toBe(generation);

		buffer.resize(40 as Time.Milli);
		expect(buffer.capacity).toBe(80 + SKIP);
		expect(buffer.length).toBe(60);
		expect(buffer.view().generation).toBe(generation);

		const output = read(buffer, 60, 1);
		expect(output[0].length).toBe(60);
		expect(output[0].subarray(0, 40).every((sample) => sample === 1.0)).toBe(true);
		expect(output[0].subarray(40).every((sample) => sample === 2.0)).toBe(true);
	});

	it("starts a new timeline when the new capacity drops samples", () => {
		// The shrink above: 200 buffered against a capacity of 155, so the reader's next sample is not
		// the one after its last.
		const buffer = new AudioRingBuffer({ rate: 1000, channels: 1, latency: 100 as Time.Milli });
		writeChunks(buffer, 0, 150, 50, { channels: 1, value: 1.0 });
		expect(read(buffer, 50, 1)[0].length).toBe(50);
		writeChunks(buffer, 150, 100, 50, { channels: 1, value: 2.0 });
		expect(buffer.length).toBe(200);
		const generation = buffer.view().generation;

		buffer.resize(30 as Time.Milli);
		expect(buffer.length).toBe(30 + 50 + SKIP);
		expect(buffer.view().generation).not.toBe(generation);
	});

	it("should be a no-op when capacity is unchanged", () => {
		const buffer = new AudioRingBuffer({ rate: 1000, channels: 1, latency: 100 as Time.Milli });

		// Exit stalled mode
		fill(buffer, 0, 200, { channels: 1, value: 1.0 });
		expect(buffer.stalled).toBe(false);

		// Resize to same capacity
		buffer.resize(100 as Time.Milli);

		// Should still not be stalled (no-op)
		expect(buffer.stalled).toBe(false);
		expect(buffer.capacity).toBe(200 + SKIP);
	});

	it("should throw on zero latency", () => {
		const buffer = new AudioRingBuffer({ rate: 1000, channels: 1, latency: 100 as Time.Milli });
		expect(() => buffer.resize(0 as Time.Milli)).toThrow(/empty buffer/);
	});

	it("should handle resize with stereo data", () => {
		const buffer = new AudioRingBuffer({ rate: 1000, channels: 2, latency: 100 as Time.Milli });

		// Write stereo data with different values per channel
		const data = [new Float32Array(60), new Float32Array(60)];
		for (let i = 0; i < 60; i++) {
			data[0][i] = 1.0; // Left channel
			data[1][i] = 2.0; // Right channel
		}
		buffer.write(0 as Time.Micro, data);
		expect(buffer.length).toBe(60);

		// Resize to smaller buffer. The 60 sample chunk is wider than the new 50 sample target, so
		// capacity holds that rather than twice the target.
		buffer.resize(50 as Time.Milli);
		expect(buffer.capacity).toBe(50 + 60 + SKIP);
		expect(buffer.length).toBe(60);
		expect(buffer.stalled).toBe(true);
	});

	it("should handle resize when buffer is empty", () => {
		const buffer = new AudioRingBuffer({ rate: 1000, channels: 1, latency: 100 as Time.Milli });
		expect(buffer.length).toBe(0);

		// Resize empty buffer
		buffer.resize(200 as Time.Milli);

		expect(buffer.capacity).toBe(400 + SKIP);
		expect(buffer.length).toBe(0);
		expect(buffer.stalled).toBe(true);
	});

	it("should handle resize after partial read", () => {
		const buffer = new AudioRingBuffer({ rate: 1000, channels: 1, latency: 50 as Time.Milli });

		// Fill and exit stalled mode
		fill(buffer, 0, 100, { channels: 1, value: 1.0 });
		expect(buffer.stalled).toBe(false);

		// Read 60 samples (readIndex at 60, writeIndex at 100)
		read(buffer, 60, 1);
		expect(buffer.length).toBe(40);

		// Write more data
		write(buffer, 100 as Time.Milli, 30, { channels: 1, value: 2.0 });
		expect(buffer.length).toBe(70); // 130 - 60

		// Resize to a 50 sample target - 100 of capacity, so all 70 survive (samples 60-129)
		buffer.resize(50 as Time.Milli);
		expect(buffer.capacity).toBe(100 + SKIP);
		expect(buffer.length).toBe(70);
		expect(buffer.stalled).toBe(false);
	});

	it("should exit stall and read new data after resize", () => {
		const buffer = new AudioRingBuffer({ rate: 1000, channels: 1, latency: 100 as Time.Milli });

		// Write some initial data
		write(buffer, 0 as Time.Milli, 50, { channels: 1, value: 1.0 });

		// Resize to smaller buffer
		buffer.resize(50 as Time.Milli);
		expect(buffer.stalled).toBe(true);

		// Write new data to reach the new target and exit stall. Nothing is dropped: the ring has
		// room for the preserved samples plus a chunk above the target.
		write(buffer, 50 as Time.Milli, 50, { channels: 1, value: 2.0 });
		expect(buffer.stalled).toBe(false);
		expect(buffer.length).toBe(100);

		// Read plays the preserved samples first, then the new ones.
		const output = read(buffer, 100, 1);
		expect(output[0].length).toBe(100);
		for (let i = 0; i < 50; i++) {
			expect(output[0][i]).toBe(1.0);
		}
		for (let i = 50; i < 100; i++) {
			expect(output[0][i]).toBe(2.0);
		}
	});

	it("should preserve samples correctly when resizing larger then filling", () => {
		const buffer = new AudioRingBuffer({ rate: 1000, channels: 1, latency: 30 as Time.Milli });
		expect(buffer.capacity).toBe(60 + SKIP);

		// Write 30 samples
		write(buffer, 0 as Time.Milli, 30, { channels: 1, value: 1.0 });
		expect(buffer.length).toBe(30);

		// Resize to larger buffer (50ms = 50 samples)
		buffer.resize(50 as Time.Milli);
		expect(buffer.capacity).toBe(100 + SKIP);
		expect(buffer.length).toBe(30); // All samples preserved
		expect(buffer.stalled).toBe(true);

		// Write 70 more samples to fill the buffer and exit stall
		fill(buffer, 30, 70, { channels: 1, value: 2.0 });
		expect(buffer.stalled).toBe(false);
		expect(buffer.length).toBe(100);

		// Read all - should have 30 samples of 1.0 then 70 of 2.0
		const output = read(buffer, 100, 1);
		expect(output[0].length).toBe(100);
		for (let i = 0; i < 30; i++) {
			expect(output[0][i]).toBe(1.0);
		}
		for (let i = 30; i < 100; i++) {
			expect(output[0][i]).toBe(2.0);
		}
	});

	it("should read preserved samples back correctly after shrinking", () => {
		// Regression: the copy loop inside resize() used a relative dst index
		// (`i % dst.length`) while read() uses the absolute ring position
		// (`readIndex % capacity`). When `copyStart` was not a multiple of the new
		// capacity, preserved samples ended up in the wrong slots and read() returned
		// mangled data. This test fails under that bug by constructing a scenario
		// where `copyStart % newCapacity !== 0`.
		const buffer = new AudioRingBuffer({ rate: 1000, channels: 1, latency: 50 as Time.Milli });

		// Fill the buffer to exit stall (writeIndex=100, readIndex=0).
		fill(buffer, 0, 100, { channels: 1, value: 1.0 });
		expect(buffer.stalled).toBe(false);

		// Advance readIndex to 20 so there's room to wrap the write pointer.
		read(buffer, 20, 1);

		// Write samples that wrap: abs 100-109 → slots 0-9, value 2.0.
		write(buffer, 100 as Time.Milli, 10, { channels: 1, value: 2.0 });
		// abs 110-119 → slots 10-19, value 3.0.
		write(buffer, 110 as Time.Milli, 10, { channels: 1, value: 3.0 });

		// Preserved range after resize: all 100 buffered samples = abs 20..119.
		// copyStart = 120 - 100 = 20, and 20 % 150 = 20 (non-zero → triggers the bug).
		buffer.resize(25 as Time.Milli);
		expect(buffer.capacity).toBe(25 + 50 + SKIP);
		expect(buffer.length).toBe(100);
		expect(buffer.stalled).toBe(false);

		// Read the preserved samples. Expected layout by absolute index:
		//   abs 20..99  = 1.0 (80 samples, from the initial fill)
		//   abs 100..109 = 2.0 (10 samples)
		//   abs 110..119 = 3.0 (10 samples)
		const output = read(buffer, 100, 1);
		expect(output[0].length).toBe(100);
		for (let i = 0; i < 80; i++) {
			expect(output[0][i]).toBe(1.0);
		}
		for (let i = 80; i < 90; i++) {
			expect(output[0][i]).toBe(2.0);
		}
		for (let i = 90; i < 100; i++) {
			expect(output[0][i]).toBe(3.0);
		}
	});

	it("should continue accepting absolute-timestamp writes after resize", () => {
		// resize() must keep readIndex/writeIndex on the same absolute axis that
		// write() uses (`round(timestamp * rate)`). If the indices were reset to 0
		// while timestamps stayed absolute, the next write would leave a giant zero
		// gap. This test asserts that post-resize writes land contiguously with the
		// preserved samples.
		const buffer = new AudioRingBuffer({ rate: 1000, channels: 1, latency: 200 as Time.Milli });

		// Fill the buffer, then partially drain it.
		fill(buffer, 0, 400, { channels: 1, value: 1.0 });
		read(buffer, 160, 1);
		// Wrap the writer over slots 0-119 with value 2.0 (abs 400-519).
		write(buffer, 400 as Time.Milli, 120, { channels: 1, value: 2.0 });

		// Resize smaller. All 360 buffered samples fit the new 400 sample capacity: abs 160..519.
		buffer.resize(200 as Time.Milli);
		expect(buffer.length).toBe(360);
		expect(buffer.stalled).toBe(false);

		// Write the next 40 samples at their real timestamp. This should append,
		// not create a gap or be discarded as "too old".
		write(buffer, 520 as Time.Milli, 40, { channels: 1, value: 3.0 });

		// That put the ring past the band (200 + 40 + 75), so it drops back to the level it holds,
		// the 200 sample target with the 40 sample chunk on top. Remaining: abs 320..399 = 1.0 (80),
		// abs 400..519 = 2.0 (120), abs 520..559 = 3.0 (40).
		expect(buffer.length).toBe(240);

		const output = read(buffer, 240, 1);
		expect(output[0].length).toBe(240);
		for (let i = 0; i < 80; i++) {
			expect(output[0][i]).toBe(1.0);
		}
		for (let i = 80; i < 200; i++) {
			expect(output[0][i]).toBe(2.0);
		}
		for (let i = 200; i < 240; i++) {
			expect(output[0][i]).toBe(3.0);
		}
	});
});

describe("decoded rate must match the ring (#2352)", () => {
	// The ring maps a frame's timestamp to a sample index using its own rate, so the ring must run at
	// the rate the decoder actually output. A 20ms Opus frame decodes to 960 samples (48kHz); if the
	// ring runs at that rate they land contiguously, but if it runs at a mismatched rate (e.g. 44100,
	// the machine default a file publish leaked into the catalog) each frame overruns its slot and
	// every frame after the first is misplaced, which is the noise reported in #2352.
	function writeOpusFrames(rate: number): AudioRingBuffer {
		// 1s floor so nothing overflows while we fill 10 frames.
		const buffer = new AudioRingBuffer({ rate, channels: 1, latency: 1000 as Time.Milli });
		for (let i = 0; i < 10; i++) {
			write(buffer, (i * 20) as Time.Milli, 960, { channels: 1, value: (i + 1) / 10 });
		}
		return buffer;
	}

	it("places 20ms/960-sample frames contiguously at 48kHz", () => {
		// 20ms at 48kHz is exactly 960 samples, so 10 frames pack into 9600 with no gaps or overlap.
		expect(writeOpusFrames(48000).length).toBe(9600);
	});

	it("misplaces the frames when the ring rate disagrees", () => {
		// 20ms at 44100 is 882 samples, so each 960-sample frame overlaps the next and the buffer never
		// reaches the contiguous 9600 it would at the matching rate.
		expect(writeOpusFrames(44100).length).toBeLessThan(9600);
	});
});

describe("live anchoring", () => {
	// The SharedArrayBuffer ring anchors in both modes; this keeps the postMessage fallback
	// in step. Without anchoring, a first frame at a large timestamp gap-filled the whole ring
	// with zeros, un-stalled on that overflow, and left the playhead a floor before the frame.
	it("anchors a live ring to the first frame instead of gap-filling from zero", () => {
		const buffer = new AudioRingBuffer({ rate: 1000, channels: 1, latency: 40 as Time.Milli });
		expect(buffer.capacity).toBe(80 + SKIP);

		write(buffer, 2000 as Time.Milli, 40, { channels: 1, value: 0.5 });
		// Still short of the floor, so nothing plays yet and the ring holds only real samples.
		expect(buffer.stalled).toBe(true);
		expect(buffer.length).toBe(40);
		expect(Time.Milli.fromMicro(buffer.timestamp)).toBe(2000 as Time.Milli);

		write(buffer, 2040 as Time.Milli, 60, { channels: 1, value: 0.5 });
		expect(buffer.stalled).toBe(false);

		// Playback starts on the first real sample, not on gap-filled silence.
		const output = read(buffer, 40, 1);
		expect(output[0].length).toBe(40);
		expect(output[0][0]).toBeCloseTo(0.5, 5);
	});
});

describe("capacity", () => {
	it("grows capacity with the target rather than capping the band", () => {
		// The write path bounds the ring at `min(target + slack, capacity)`, so a target that climbed
		// past a fixed capacity would be silently capped there and the deeper buffer would never
		// arrive. `resize` keeps capacity at twice the target, which is what stops that.
		const buffer = new AudioRingBuffer({ rate: 1000, channels: 1, latency: 200 as Time.Milli });
		fill(buffer, 0, 400, { channels: 1, value: 1.0 });
		expect(buffer.stalled).toBe(false);

		buffer.resize(1000 as Time.Milli);
		expect(buffer.capacity).toBeGreaterThanOrEqual(1000);

		write(buffer, 400 as Time.Milli, 1000, { channels: 1, value: 2.0 });
		expect(buffer.length).toBeGreaterThanOrEqual(1000);
	});

	it("grows capacity for a chunk wider than the target", () => {
		// A publisher whose frames are longer than the delay its catalog advertises: 60ms Opus under
		// a 20ms advertised jitter. The ring has to hold the 20ms target with that 60ms chunk on top
		// and the stretch band above it, or the hard capacity would start dropping the audio the
		// band exists to keep.
		const buffer = new AudioRingBuffer({ rate: 1000, channels: 1, latency: 20 as Time.Milli });
		expect(buffer.capacity).toBe(40 + SKIP);

		write(buffer, 0 as Time.Milli, 60, { channels: 1, value: 1.0 });
		expect(buffer.capacity).toBe(20 + 60 + SKIP);
		expect(buffer.length).toBe(60);

		// A second chunk sits inside the band the wider ring can now hold, so nothing is thrown away.
		// The old capacity of twice the target plus the band was 115, and 120 would not have fit.
		write(buffer, 60 as Time.Milli, 60, { channels: 1, value: 2.0 });
		expect(buffer.length).toBe(120);
		expect(buffer.debug().discarded).toBe(0);
	});

	it("keeps the timeline when a wider chunk grows it mid-stream", () => {
		// A publisher moving from 20ms to 60ms frames. The wider ring holds everything the narrow one
		// did, so the reader is still on the timeline it was playing.
		const buffer = new AudioRingBuffer({ rate: 1000, channels: 1, latency: 20 as Time.Milli });
		writeChunks(buffer, 0, 40, 20, { channels: 1, value: 1.0 });
		expect(read(buffer, 20, 1)[0].length).toBe(20);
		const generation = buffer.view().generation;

		write(buffer, 40 as Time.Milli, 60, { channels: 1, value: 2.0 });
		expect(buffer.capacity).toBe(20 + 60 + SKIP);
		expect(buffer.length).toBe(80);
		expect(buffer.view().generation).toBe(generation);
	});
});

describe("the chunk above the target", () => {
	// The real shape a conference call has: 48kHz Opus in 20ms frames, and the lowest target the
	// estimator can report. The target counts the frame being played, the way NetEq's does, so the
	// ring holds 40ms and one arrival a few milliseconds late no longer finds it empty.
	const RATE = 48000;

	function opus() {
		return new AudioRingBuffer({ rate: RATE, channels: 1, latency: 20 as Time.Milli });
	}

	it("un-stalls at the target plus a chunk, not at the target", () => {
		const buffer = opus();

		write(buffer, 0 as Time.Milli, 960, { channels: 1, value: 1.0 });
		expect(buffer.length).toBe(960);
		expect(buffer.stalled).toBe(true);

		write(buffer, 20 as Time.Milli, 960, { channels: 1, value: 1.0 });
		expect(buffer.stalled).toBe(false);
	});

	it("plays a full quantum through a chunk that arrives ten milliseconds late", () => {
		const buffer = opus();
		// Feed it a chunk at a time and start playing the moment it says it is ready, which is what
		// the refill after a stall does. What it stops at is the whole question.
		for (let at = 0; buffer.stalled; at += 20) {
			write(buffer, at as Time.Milli, 960, { channels: 1, value: 1.0 });
		}

		// Thirty milliseconds of render quanta with nothing arriving: the chunk due at 40ms is ten
		// late. A ring holding only the target would be empty ten milliseconds before it landed.
		const quanta = Math.floor((RATE * 30) / 1000 / 128);
		for (let i = 0; i < quanta; i++) {
			expect(read(buffer, 128, 1)[0].length).toBe(128);
		}
		expect(buffer.underruns).toBe(0);
		expect(buffer.stalled).toBe(false);
	});
});

describe("re-buffer", () => {
	it("re-stalls and refills to the hold level after running dry", () => {
		// A 40 sample target with 20 sample chunks: the ring holds 60, the target plus the chunk
		// being played.
		const buffer = new AudioRingBuffer({ rate: 1000, channels: 1, latency: 40 as Time.Milli });

		writeChunks(buffer, 0, 60, 20, { channels: 1, value: 1.0 });
		expect(buffer.stalled).toBe(false);

		// Drain it.
		expect(read(buffer, 60, 1)[0].length).toBe(60);
		expect(buffer.length).toBe(0);

		// The next read finds nothing and parks playback rather than handing the worklet a quantum
		// of silence and trying again on the next one.
		expect(read(buffer, 20, 1)[0].length).toBe(0);
		expect(buffer.stalled).toBe(true);
		expect(buffer.underruns).toBe(1);

		// Two chunks are still short of the level, so playback stays parked.
		writeChunks(buffer, 60, 40, 20, { channels: 1, value: 2.0 });
		expect(buffer.stalled).toBe(true);
		expect(read(buffer, 20, 1)[0].length).toBe(0);

		// Reaching it resumes playback, and nothing buffered in the meantime was lost.
		write(buffer, 100 as Time.Milli, 20, { channels: 1, value: 2.0 });
		expect(buffer.stalled).toBe(false);
		expect(read(buffer, 60, 1)[0].length).toBe(60);
	});

	it("counts a quantum it could only partly fill as an underrun", () => {
		const buffer = new AudioRingBuffer({ rate: 1000, channels: 1, latency: 40 as Time.Milli });

		writeChunks(buffer, 0, 60, 20, { channels: 1, value: 1.0 });
		expect(read(buffer, 50, 1)[0].length).toBe(50);

		// Ten samples remain against a quantum of twenty: the rest of the quantum is silence, which
		// is an underrun whether or not a chunk lands before the next read. It is not a stall: a
		// refill would cost the whole level to cover a gap shorter than one quantum.
		expect(read(buffer, 20, 1)[0].length).toBe(10);
		expect(buffer.stalled).toBe(false);
		expect(buffer.underruns).toBe(1);

		// A chunk landing before the next read keeps playback going.
		write(buffer, 60 as Time.Milli, 20, { channels: 1, value: 2.0 });
		expect(read(buffer, 20, 1)[0].length).toBe(20);
		expect(buffer.underruns).toBe(1);
	});

	it("stall() parks playback without discarding what is buffered", () => {
		const buffer = new AudioRingBuffer({ rate: 1000, channels: 1, latency: 40 as Time.Milli });

		writeChunks(buffer, 0, 60, 20, { channels: 1, value: 1.0 });
		expect(read(buffer, 20, 1)[0].length).toBe(20);

		// A viewer's deeper delay parks playback until the ring holds the new depth.
		buffer.resize(60 as Time.Milli);
		buffer.stall();
		expect(buffer.stalled).toBe(true);
		expect(read(buffer, 20, 1)[0].length).toBe(0);
		expect(buffer.length).toBe(40); // nothing was thrown away, unlike reset()

		write(buffer, 60 as Time.Milli, 20, { channels: 1, value: 2.0 });
		expect(buffer.stalled).toBe(true); // 60 buffered, the ring holds 80

		write(buffer, 80 as Time.Milli, 20, { channels: 1, value: 2.0 });
		expect(buffer.stalled).toBe(false);

		// Playback resumes on the same timeline: the samples buffered before the stall play first.
		const output = read(buffer, 20, 1);
		expect(output[0].length).toBe(20);
		expect(output[0][0]).toBe(1.0);
		expect(buffer.underruns).toBe(0);
	});

	it("does not count an underrun while parked", () => {
		const buffer = new AudioRingBuffer({ rate: 1000, channels: 1, latency: 40 as Time.Milli });
		read(buffer, 20, 1);
		read(buffer, 20, 1);
		expect(buffer.underruns).toBe(0);
	});
});

describe("buffered mode", () => {
	function createBuffered(latency: number) {
		return new AudioRingBuffer({ rate: 1000, channels: 1, latency: latency as Time.Milli, buffered: true });
	}

	it("anchors to the first frame and un-stalls at the latency target", () => {
		const buffer = createBuffered(50);
		expect(buffer.stalled).toBe(true);
		write(buffer, 2000 as Time.Milli, 100, { channels: 1, value: 0.1 });
		expect(buffer.stalled).toBe(false);
		expect(Time.Milli.fromMicro(buffer.timestamp)).toBe(2000 as Time.Milli);
	});

	it("plays frames in order within the floor-sized ring without skipping ahead", () => {
		// 600ms floor at 1000Hz -> 1200-sample ring, comfortably holding the 1000-sample utterance
		// the backpressure loop would feed it. A non-buffered ring would have skipped to write-latency.
		const buffer = createBuffered(600);
		for (let i = 0; i < 10; i++) {
			write(buffer, (2000 + i * 100) as Time.Milli, 100, { channels: 1, value: (i + 1) / 10 });
		}
		expect(buffer.length).toBe(1000);

		const first = read(buffer, 100, 1);
		expect(first[0][0]).toBeCloseTo(0.1, 5);
		const second = read(buffer, 100, 1);
		expect(second[0][0]).toBeCloseTo(0.2, 5);
	});

	it("reset re-stalls and re-anchors to the next utterance", () => {
		const buffer = createBuffered(50);
		write(buffer, 2000 as Time.Milli, 100, { channels: 1, value: 0.1 });
		read(buffer, 50, 1);

		buffer.reset();
		expect(buffer.stalled).toBe(true);

		write(buffer, 500 as Time.Milli, 100, { channels: 1, value: 0.9 });
		expect(Time.Milli.fromMicro(buffer.timestamp)).toBe(500 as Time.Milli);
		const out = read(buffer, 100, 1);
		expect(out[0][0]).toBeCloseTo(0.9, 5);
	});

	it("drops the oldest samples once the ring fills beyond the floor", () => {
		// 50ms floor at 1000Hz -> 50-sample floor, 100-sample ring. Backpressure normally keeps the
		// decode loop from running this far ahead; if it slips, the ring drops its oldest as a backstop.
		const buffer = createBuffered(50);

		write(buffer, 0 as Time.Milli, 100, { channels: 1, value: 0.1 }); // [0, 100)
		write(buffer, 100 as Time.Milli, 100, { channels: 1, value: 0.2 }); // exceeds 100-sample ring; drops [0, 100)

		expect(Time.Milli.fromMicro(buffer.timestamp)).toBe(100 as Time.Milli);
		expect(read(buffer, 100, 1)[0][0]).toBeCloseTo(0.2, 5);
	});

	it("truncate drops the write-ahead tail a successor supersedes", () => {
		// 600ms floor at 1000Hz -> 1200-sample ring, holding a 1s write-ahead utterance.
		const buffer = createBuffered(600);
		for (let i = 0; i < 10; i++) {
			write(buffer, (2000 + i * 100) as Time.Milli, 100, { channels: 1, value: 0.1 });
		}
		read(buffer, 100, 1); // playhead at 2100

		// A successor track takes over at 2200 with 100ms of its own audio. Writing it only overwrites
		// [2200, 2300); without the truncate, [2300, 3000) of the old track still plays after it.
		buffer.truncate(Time.Micro.fromMilli(2200 as Time.Milli));
		write(buffer, 2200 as Time.Milli, 100, { channels: 1, value: 0.9 });

		expect(buffer.stalled).toBe(false); // truncate keeps playing, unlike reset()
		expect(read(buffer, 100, 1)[0][0]).toBeCloseTo(0.1, 5); // [2100, 2200) was already due
		expect(read(buffer, 100, 1)[0][0]).toBeCloseTo(0.9, 5); // the successor
		expect(read(buffer, 100, 1)[0].length).toBe(0); // and nothing after it
	});

	it("truncate never rewinds past the playhead", () => {
		const buffer = createBuffered(600);
		write(buffer, 2000 as Time.Milli, 1000, { channels: 1, value: 0.1 });
		read(buffer, 100, 1); // playhead at 2100

		// A successor whose first frame predates the playhead: those samples are already due, so the
		// write index floors there rather than going backwards.
		buffer.truncate(Time.Micro.fromMilli(1000 as Time.Milli));
		expect(buffer.length).toBe(0);
		expect(read(buffer, 100, 1)[0].length).toBe(0);
	});
});

describe("latency increase re-anchor", () => {
	it("resize() does not re-stall a mid-playback ring, but reset() does", () => {
		const buffer = new AudioRingBuffer({ rate: 1000, channels: 1, latency: 100 as Time.Milli });

		// Fill to the floor so playback starts (un-stalls), then play some samples.
		fill(buffer, 0, 200, { channels: 1, value: 1.0 });
		expect(buffer.stalled).toBe(false);
		read(buffer, 50, 1);

		// Raising the latency floor grows the target but must NOT re-stall a ring mid-playback:
		// resize() only re-stalls an empty ring, so it keeps draining at the old depth. This is
		// exactly why setLatency() alone doesn't re-buffer -- the reader expands into the new depth.
		buffer.resize(200 as Time.Milli);
		expect(buffer.stalled).toBe(false);

		// reset() re-stalls, so the ring refills to the (new) floor before playing again, and it also
		// throws the buffer away and re-anchors. The supply parks with stall() instead (`Supply.#runLatency`),
		// and only for a delay the viewer set past the stretch bound; reset() contrasts with resize().
		buffer.reset();
		expect(buffer.stalled).toBe(true);

		// ...and it refills to the *new* 200 sample floor, not the old 100: 200 buffered in 50 sample
		// chunks is still one chunk short of what the ring holds, and that chunk is what resumes
		// playback. This proves resize(200) moved the target.
		writeChunks(buffer, 0, 200, 50, { channels: 1, value: 1.0 });
		expect(buffer.stalled).toBe(true);
		write(buffer, 200 as Time.Milli, 50, { channels: 1, value: 1.0 });
		expect(buffer.stalled).toBe(false);
	});
});

describe("trimming the first fill", () => {
	// A 30ms target with 10ms chunks: the ring holds 40ms, the target plus the chunk being played.
	const TARGET = 30;
	const CHUNK = 10;
	const HOLD = TARGET + CHUNK;
	const FILL = 90;

	function filled(): AudioRingBuffer {
		const buffer = new AudioRingBuffer({ rate: 1000, channels: 1, latency: TARGET as Time.Milli });
		// Each chunk carries its own index, so where the playhead starts is readable off the samples.
		for (let i = 0; i < FILL / CHUNK; i++) {
			write(buffer, (i * CHUNK) as Time.Milli, CHUNK, { channels: 1, value: i });
		}
		return buffer;
	}

	it("starts the playhead at the newest audio less the level it holds", () => {
		const buffer = filled();

		// Nothing had been played, so the excess was dropped in silence rather than left for the
		// reader's time stretch to close over the seconds after a tune-in or an unmute.
		expect(buffer.debug().trimmed).toBe(FILL - HOLD);
		expect(buffer.length).toBe(HOLD);
		expect(buffer.stalled).toBe(false);

		// Nothing else counted it: a trim is neither a reader skipping ahead nor a writer overflowing.
		expect(buffer.debug().skips).toBe(0);
		expect(buffer.debug().skipped).toBe(0);
		expect(buffer.debug().discarded).toBe(0);
		expect(buffer.underruns).toBe(0);

		// And the first read is the newest 40ms, which is chunk 5 onwards rather than chunk 0.
		const output = read(buffer, HOLD, 1);
		expect(output[0].length).toBe(HOLD);
		expect(output[0][0]).toBe((FILL - HOLD) / CHUNK);
	});

	it("leaves a fill that is already on the level it holds alone", () => {
		const buffer = new AudioRingBuffer({ rate: 1000, channels: 1, latency: TARGET as Time.Milli });
		for (let i = 0; i < HOLD / CHUNK; i++) {
			write(buffer, (i * CHUNK) as Time.Milli, CHUNK, { channels: 1, value: i });
		}

		expect(buffer.stalled).toBe(false);
		expect(buffer.debug().trimmed).toBe(0);
		expect(read(buffer, HOLD, 1)[0][0]).toBe(0);
	});

	it("keeps a surplus once something has been played", () => {
		const buffer = filled();

		// One block read is what makes the rest of the timeline the listener's: from here a surplus is
		// audio on its way to being heard, and the reader's time stretch is what closes it.
		expect(read(buffer, CHUNK, 1)[0].length).toBe(CHUNK);
		const trimmed = buffer.debug().trimmed;

		for (let i = 0; i < 5; i++) {
			write(buffer, (FILL + i * CHUNK) as Time.Milli, CHUNK, { channels: 1, value: 9 + i });
		}

		expect(buffer.debug().trimmed).toBe(trimmed);
		expect(buffer.length).toBeGreaterThan(HOLD);
	});
});

describe("a declared endpoint", () => {
	// A 30ms target with 10ms chunks: the ring holds 40ms, the target plus the chunk being played.
	const TARGET = 30;
	const CHUNK = 10;
	const HOLD = TARGET + CHUNK;
	const FILL = 90;

	/** A ring the reader has played out and run dry on, which is where a declared pause finds it. */
	function drained(): AudioRingBuffer {
		const buffer = new AudioRingBuffer({ rate: 1000, channels: 1, latency: TARGET as Time.Milli });
		for (let i = 0; i < HOLD / CHUNK; i++) {
			write(buffer, (i * CHUNK) as Time.Milli, CHUNK, { channels: 1, value: i });
		}
		expect(buffer.stalled).toBe(false);
		expect(read(buffer, HOLD, 1)[0].length).toBe(HOLD);
		read(buffer, CHUNK, 1); // nothing left: the reader parks
		expect(buffer.stalled).toBe(true);
		return buffer;
	}

	it("releases a stall on an empty ring", () => {
		const buffer = drained();

		buffer.end();

		// A stall waits for a refill and there is no refill coming, so it is a wait nothing can end.
		// The reader parks on the endpoint itself, which is the pause the publisher declared rather
		// than a gap to conceal.
		expect(buffer.stalled).toBe(false);
		expect(buffer.view().ended).toBe(true);
		expect(read(buffer, CHUNK, 1)[0].length).toBe(0);
	});

	it("takes the endpoint back on a write, and media after a played-out one is a fresh fill", () => {
		const buffer = drained();
		buffer.end();
		expect(buffer.debug().fresh).toBe(false); // this timeline has been played

		const generation = buffer.view().generation;

		// The publisher unmutes ten seconds later, and the relay serves more than the ring holds.
		for (let i = 0; i < FILL / CHUNK; i++) {
			write(buffer, (10_000 + i * CHUNK) as Time.Milli, CHUNK, { channels: 1, value: i });
		}

		expect(buffer.view().ended).toBe(false);
		// Nothing of the resumed run has been heard, so the playhead starts on the newest audio and
		// the rest is dropped in silence rather than left for the reader to stretch across.
		expect(buffer.debug().anchor).toBe(10_000);
		expect(buffer.debug().fresh).toBe(true);
		expect(buffer.view().generation).not.toBe(generation);
		expect(buffer.debug().trimmed).toBe(FILL - HOLD);
		expect(buffer.length).toBe(HOLD);
		expect(buffer.stalled).toBe(false);
		expect(read(buffer, HOLD, 1)[0][0]).toBe((FILL - HOLD) / CHUNK);
	});
});

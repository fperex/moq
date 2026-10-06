import { expect, mock, test } from "bun:test";

// A browser can ship one half of the audio codec pair. The polyfill then replaces only the missing
// half, so the classes that carry the data stay native and the libav side is handed instances it
// does not recognize. These stand in for the libav classes so the bridging can be checked without
// loading the wasm build.
class FakeEncodedAudioChunk {
	readonly init: Record<string, unknown>;

	constructor(init: Record<string, unknown>) {
		this.init = init;
	}
}

class FakeAudioData {
	readonly from: unknown;
	closed = false;

	static fromNative(from: unknown): FakeAudioData {
		return new FakeAudioData(from);
	}

	constructor(from: unknown) {
		this.from = from;
	}

	close(): void {
		this.closed = true;
	}
}

class FakeAudioDecoder {
	static decoded: unknown[] = [];

	decode(chunk: unknown): void {
		FakeAudioDecoder.decoded.push(chunk);
	}
}

class FakeAudioEncoder {
	static encoded: unknown[] = [];

	encode(data: unknown): void {
		FakeAudioEncoder.encoded.push(data);
	}
}

mock.module("@libav.js/variant-opus-af", () => ({ default: {} }));
mock.module("@kixelated/libavjs-webcodecs-polyfill", () => ({
	load: async () => {},
	AudioDecoder: FakeAudioDecoder,
	AudioEncoder: FakeAudioEncoder,
	AudioData: FakeAudioData,
	EncodedAudioChunk: FakeEncodedAudioChunk,
}));

test("a native codec's data reaches the polyfilled half of the pair", async () => {
	const decoder = Object.getOwnPropertyDescriptor(globalThis, "AudioDecoder");
	const encoder = Object.getOwnPropertyDescriptor(globalThis, "AudioEncoder");

	// The browser decodes audio natively but cannot encode it, so only the encoder is polyfilled and
	// AudioData stays the browser's own class.
	Object.defineProperty(globalThis, "AudioDecoder", { configurable: true, value: class {}, writable: true });
	Reflect.deleteProperty(globalThis, "AudioEncoder");

	try {
		const { polyfill } = await import("./libav");
		expect(await polyfill()).toBe(true);

		const native = { format: "f32-planar", sampleRate: 48_000 };
		new FakeAudioEncoder().encode(native);

		const [encoded] = FakeAudioEncoder.encoded;
		expect(encoded).toBeInstanceOf(FakeAudioData);
		expect((encoded as FakeAudioData).from).toBe(native);
		// The conversion owns its copy, so it has to release it once the encoder has read it.
		expect((encoded as FakeAudioData).closed).toBe(true);

		// The decoder is the browser's own, so nothing routes through the libav one and it is left
		// exactly as the polyfill shipped it.
		const chunk = new FakeEncodedAudioChunk({ type: "key", timestamp: 0 });
		new FakeAudioDecoder().decode(chunk);
		expect(FakeAudioDecoder.decoded).toEqual([chunk]);
	} finally {
		if (decoder) Object.defineProperty(globalThis, "AudioDecoder", decoder);
		else Reflect.deleteProperty(globalThis, "AudioDecoder");
		if (encoder) Object.defineProperty(globalThis, "AudioEncoder", encoder);
		else Reflect.deleteProperty(globalThis, "AudioEncoder");
	}
});

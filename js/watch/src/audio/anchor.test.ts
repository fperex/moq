import { describe, expect, it } from "bun:test";
import { Anchor } from "./anchor";

// A decoder that rejects a chunk the way Chromium does: `decode()` throws DataError when the run
// has not been opened by a key chunk, which is the state a fresh `configure()` and every `reset()`
// and `flush()` leaves it in. See the Anchor doc comment.
class MockDecoder {
	#keyRequired = true;
	readonly decoded: string[] = [];

	configure(): void {
		this.#keyRequired = true;
	}

	reset(): void {
		this.#keyRequired = true;
	}

	flush(): void {
		this.#keyRequired = true;
	}

	decode(type: EncodedAudioChunkType): void {
		if (this.#keyRequired && type !== "key") {
			throw new DOMException("Failed to execute 'decode' on 'AudioDecoder'", "DataError");
		}
		this.#keyRequired = false;
		this.decoded.push(type);
	}
}

describe("anchor", () => {
	it("opens the first run with a key chunk however the container marked the frame", () => {
		const anchor = new Anchor();
		expect(anchor.type(false)).toBe("key");
	});

	it("leaves the rest of the run to the container", () => {
		const anchor = new Anchor();
		anchor.type(true);
		expect(anchor.type(false)).toBe("delta");
		expect(anchor.type(true)).toBe("key");
	});

	it("reopens the run after the decoder restarts", () => {
		const anchor = new Anchor();
		anchor.type(true);
		expect(anchor.type(false)).toBe("delta");

		anchor.restarted();
		expect(anchor.type(false)).toBe("key");
		expect(anchor.type(false)).toBe("delta");
	});

	// The bug: a hole in the source re-anchors the decoder mid-group, and the container marks only a
	// group's *first* frame a key, so the frame that triggered the hole reached a freshly reset
	// decoder as a delta and threw DataError out of the decode loop, silencing the session.
	it("re-anchors mid-group without the decoder rejecting the chunk", () => {
		const decoder = new MockDecoder();
		const anchor = new Anchor();

		// The group's first frame, which the container marks a key, then two frames into the group.
		decoder.configure();
		for (const keyframe of [true, false]) decoder.decode(anchor.type(keyframe));

		// A hole: the decoder is drained and restarted so the next chunk re-anchors its timeline.
		decoder.flush();
		decoder.reset();
		decoder.configure();
		anchor.restarted();

		expect(() => decoder.decode(anchor.type(false))).not.toThrow();
		expect(decoder.decoded).toEqual(["key", "delta", "key"]);
	});

	it("reopens the run after an endpoint flush alone", () => {
		const decoder = new MockDecoder();
		const anchor = new Anchor();

		decoder.configure();
		decoder.decode(anchor.type(true));

		// A declared endpoint drains the decoder without resetting it; the break that follows still
		// has to open a new run.
		decoder.flush();
		anchor.restarted();

		expect(() => decoder.decode(anchor.type(false))).not.toThrow();
	});
});

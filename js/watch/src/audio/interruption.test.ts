import { describe, expect, it } from "bun:test";
import { Interruption } from "./interruption";

describe("interruption", () => {
	it("does not report a ring that has never played", () => {
		// A cold start is the player arriving, not playback stopping.
		const interruption = new Interruption();
		expect(interruption.update(true)).toBe(false);
		expect(interruption.update(true)).toBe(false);
	});

	it("reports a ring that stalls after it has played", () => {
		const interruption = new Interruption();
		interruption.update(true);
		expect(interruption.update(false)).toBe(false);

		// The reader ran dry, which is the silence a viewer hears.
		expect(interruption.update(true)).toBe(true);
	});

	it("does not report the fill after a restart, however long it ran before", () => {
		// The unmute case: audio played, the download stopped and the ring was flushed, and the
		// replacement subscription fills it from empty while video never stopped painting.
		const interruption = new Interruption();
		interruption.update(true);
		interruption.update(false);

		interruption.restarted();
		expect(interruption.update(true)).toBe(false);

		// Once it is playing again, the next dry spell is an interruption like any other.
		expect(interruption.update(false)).toBe(false);
		expect(interruption.update(true)).toBe(true);
	});
});

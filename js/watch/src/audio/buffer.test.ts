import { afterEach, describe, expect, it } from "bun:test";
import type { Time } from "@moq/net";
import { ClockSource } from "./buffer";
import type { Playhead } from "./playhead";

// `Time.Milli.now()` reads `performance.now()` on every call, so stubbing it puts the park timer
// under the test's control.
function fakeClock(start = 1000) {
	const real = performance.now.bind(performance);
	let at = start;
	performance.now = () => at;
	return {
		advance(ms: number) {
			at += ms;
		},
		restore() {
			performance.now = real;
		},
	};
}

let clock: ReturnType<typeof fakeClock> | undefined;
afterEach(() => {
	clock?.restore();
	clock = undefined;
});

function playhead(media: number, rate: number): Playhead {
	return { timestamp: (media * 1000) as Time.Micro, rate };
}

describe("ClockSource", () => {
	it("stamps a moving playhead with the time it was sampled", () => {
		clock = fakeClock();
		const source = new ClockSource();

		expect(source.sample(playhead(500, 1))).toEqual({
			timestamp: 500_000 as Time.Micro,
			reference: 1000 as Time.Milli,
			rate: 1,
		});

		clock.advance(50);
		expect(source.sample(playhead(550, 1))).toEqual({
			timestamp: 550_000 as Time.Micro,
			reference: 1050 as Time.Milli,
			rate: 1,
		});
	});

	it("has no clock before the ring is anchored", () => {
		clock = fakeClock();
		expect(new ClockSource().sample(undefined)).toBeUndefined();
	});

	it("parks through a refill", () => {
		clock = fakeClock();
		const source = new ClockSource();
		source.sample(playhead(500, 1));

		// A re-stall is a refill, and playback pauses with it rather than running away from the
		// audio a listener can hear.
		clock.advance(50);
		expect(source.sample(playhead(500, 0))?.rate).toBe(0);
		clock.advance(500);
		expect(source.sample(playhead(500, 0))?.rate).toBe(0);
	});

	it("parks for as long as a refill keeps arriving", () => {
		// A deep target takes longer to refill than any fixed timeout would allow, and video has to
		// wait it out rather than run ahead and snap back when audio returns.
		clock = fakeClock();
		const source = new ClockSource();
		source.sample(playhead(500, 1));

		for (let i = 0; i < 10; i++) {
			clock.advance(400);
			source.filling();
			expect(source.sample(playhead(500, 0))?.rate).toBe(0);
		}
	});

	it("gives up the clock once a park stops looking like a refill", () => {
		clock = fakeClock();
		const source = new ClockSource();
		source.sample(playhead(500, 1));

		// The park is timed from the first sample that reports one.
		clock.advance(50);
		expect(source.sample(playhead(500, 0))?.rate).toBe(0);
		clock.advance(1001);
		expect(source.sample(playhead(500, 0))).toBeUndefined();

		// And takes it back as soon as the playhead moves again, e.g. after an unmute.
		clock.advance(10);
		expect(source.sample(playhead(500, 1))?.rate).toBe(1);
		clock.advance(10);
		expect(source.sample(playhead(510, 0))?.rate).toBe(0);
	});

	it("gives up the clock at once on a declared endpoint", () => {
		// A publisher that says it has paused is not refilling, so there is nothing to wait out:
		// holding video against the playhead would freeze the picture for a second first.
		clock = fakeClock();
		const source = new ClockSource();
		source.sample(playhead(500, 1));

		source.ended();
		expect(source.sample(playhead(500, 0))).toBeUndefined();

		// Media returning takes it back.
		clock.advance(10);
		source.filling();
		expect(source.sample(playhead(500, 0))?.rate).toBe(0);
	});
});

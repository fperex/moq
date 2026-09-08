import { describe, expect, it } from "bun:test";
import type { Time } from "@moq/net";
import { Signal } from "@moq/signals";
import { Sync } from "./sync";

// Effects in @moq/signals flush on a microtask, so let pending updates drain before asserting.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// A decoder's contribution to the shared clock: what its rendition advertises, and what its
// arrivals measure.
const media = (jitter?: number, spread?: number) => ({
	jitter: new Signal<Time.Milli | undefined>(jitter as Time.Milli | undefined),
	spread: new Signal<Time.Milli | undefined>(spread as Time.Milli | undefined),
});

describe("delay and buffer", () => {
	it("holds no lookahead by default", async () => {
		const sync = new Sync();
		await flush();
		expect(sync.out.buffered.peek()).toBe(false);
		sync.close();
	});

	it("caps maxAge at the delay when no buffer is configured", async () => {
		const sync = new Sync({ delay: 100 as Time.Milli });
		await flush();
		expect(sync.out.buffered.peek()).toBe(false);
		expect(sync.out.delay.peek()).toBe(100 as Time.Milli);
		expect(sync.out.maxAge.peek()).toBe(100 as Time.Milli);
		sync.close();
	});

	it("adds the buffer on top of the delay", async () => {
		// The buffer is measured from the live edge, so it does not swallow the delay: a frame may
		// sit `delay + buffer` ahead of the playhead before playback skips forward.
		const sync = new Sync({ delay: 100 as Time.Milli, buffer: 30_000 as Time.Milli });
		await flush();
		expect(sync.out.buffered.peek()).toBe(true);
		expect(sync.out.maxAge.peek()).toBe(30_100 as Time.Milli);
		sync.close();
	});

	it("stays unbuffered for a zero buffer", async () => {
		const sync = new Sync({ delay: 200 as Time.Milli, buffer: 0 as Time.Milli });
		await flush();
		expect(sync.out.buffered.peek()).toBe(false);
		expect(sync.out.maxAge.peek()).toBe(200 as Time.Milli);
		sync.close();
	});

	it("reacts to a buffer set after construction", async () => {
		const buffer = new Signal<Time.Milli>(0 as Time.Milli);
		const sync = new Sync({ delay: 100 as Time.Milli, buffer });
		await flush();
		expect(sync.out.buffered.peek()).toBe(false);

		buffer.set(30_000 as Time.Milli);
		await flush();
		expect(sync.out.buffered.peek()).toBe(true);
		expect(sync.out.maxAge.peek()).toBe(30_100 as Time.Milli);
		sync.close();
	});

	it("holds nothing when instant, whatever the buffer says", async () => {
		const sync = new Sync({ delay: "instant", buffer: 30_000 as Time.Milli });
		await flush();
		expect(sync.out.buffered.peek()).toBe(false);
		expect(sync.out.delay.peek()).toBe(0 as Time.Milli);
		expect(sync.out.maxAge.peek()).toBe(0 as Time.Milli);
		sync.close();
	});

	it("includes registered decoder jitter until the decoder unregisters", async () => {
		const decoder = media(20);
		const sync = new Sync({ delay: 100 as Time.Milli });
		const unregister = sync.register(decoder);
		await flush();
		expect(sync.out.delay.peek()).toBe(120 as Time.Milli);

		decoder.jitter.set(80 as Time.Milli);
		await flush();
		expect(sync.out.delay.peek()).toBe(180 as Time.Milli);

		unregister();
		await flush();
		expect(sync.out.delay.peek()).toBe(100 as Time.Milli);
		sync.close();
	});

	it("unregisters duplicate jitter inputs independently", async () => {
		const decoder = media(20);
		const sync = new Sync({ delay: 100 as Time.Milli });
		const unregisterFirst = sync.register({ ...decoder });
		const unregisterSecond = sync.register({ ...decoder });

		unregisterFirst();
		await flush();
		expect(sync.out.delay.peek()).toBe(120 as Time.Milli);

		unregisterSecond();
		await flush();
		expect(sync.out.delay.peek()).toBe(100 as Time.Milli);
		sync.close();
	});
});

describe("auto delay", () => {
	it("starts at the advertised delay and follows the measured arrivals", async () => {
		const audio = media(20);
		const sync = new Sync();
		sync.register(audio);
		sync.register(media(33));
		await flush();

		// Nothing measured yet, so the delay is what the catalog advertises.
		expect(sync.out.jitter.peek()).toBe(0 as Time.Milli);
		expect(sync.out.delay.peek()).toBe(33 as Time.Milli);

		// A publisher flushing 250ms of audio at once needs 250ms of buffer, whatever the RTT is.
		// The measured spread already covers what the catalog advertises, so it replaces the
		// advertised delay rather than stacking on it.
		audio.spread.set(250 as Time.Milli);
		await flush();
		expect(sync.out.jitter.peek()).toBe(250 as Time.Milli);
		expect(sync.out.delay.peek()).toBe(250 as Time.Milli);

		sync.close();
	});

	it("takes the largest spread across tracks", async () => {
		const audio = media(undefined, 40);
		const sync = new Sync();
		sync.register(audio);
		sync.register(media(undefined, 120));
		await flush();
		expect(sync.out.jitter.peek()).toBe(120 as Time.Milli);

		audio.spread.set(200 as Time.Milli);
		await flush();
		expect(sync.out.jitter.peek()).toBe(200 as Time.Milli);

		sync.close();
	});

	it("ignores the measured spread when the delay is a fixed number", async () => {
		const sync = new Sync({ delay: 500 as Time.Milli });
		sync.register(media(20, 250));
		await flush();
		expect(sync.out.jitter.peek()).toBe(500 as Time.Milli);
		expect(sync.out.delay.peek()).toBe(520 as Time.Milli);
		sync.close();
	});
});

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { Time } from "@moq/net";
import { Signal } from "@moq/signals";
import { type Clock, type Delay, Sync } from "./sync";

// Effects in @moq/signals flush on a microtask, so let pending updates drain before asserting.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

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
});

describe("audio presentation clock", () => {
	let now = Time.Milli.zero;
	let sync: Sync | undefined;
	let restore: () => void;

	beforeEach(() => {
		now = Time.Milli(200);
		const clock = spyOn(Time.Milli, "now").mockImplementation(() => now);
		restore = () => clock.mockRestore();
	});

	afterEach(() => {
		sync?.close();
		sync = undefined;
		restore();
	});

	it("extrapolates rendered media at the reported rate despite early arrivals", async () => {
		sync = new Sync({
			delay: Time.Milli(100),
			clock: { timestamp: Time.Milli(1000), reference: Time.Milli(200), rate: 0.5 },
		});
		await flush();
		now = Time.Milli(250);
		expect(sync.now()).toBe(Time.Milli(1025));
		now = Time.Milli(350);
		sync.received(Time.Milli(5000), "video");
		expect(sync.now()).toBe(Time.Milli(1075));
	});

	it("holds the media position and a future frame until audio advances", async () => {
		const clock = new Signal<Clock | undefined>({
			timestamp: Time.Milli(1000),
			reference: Time.Milli(200),
			rate: 0,
		});
		sync = new Sync({ clock });
		await flush();
		now = Time.Milli(10000);
		expect(sync.now()).toBe(Time.Milli(1000));
		let presented = false;
		const pending = sync.wait(Time.Milli(1001)).then(() => {
			presented = true;
		});
		await flush();
		expect(presented).toBe(false);
		clock.set({ timestamp: Time.Milli(1002), reference: now, rate: 1 });
		await pending;
		expect(presented).toBe(true);
		expect(sync.now()).toBe(Time.Milli(1002));
	});

	it("continues from the last audio position when audio becomes inactive", async () => {
		const clock = new Signal<Clock | undefined>({
			timestamp: Time.Milli(1000),
			reference: Time.Milli(100),
			rate: 1,
		});
		sync = new Sync({ delay: Time.Milli(100), clock });
		await flush();
		sync.received(Time.Milli(10000), "video");
		expect(sync.now()).toBe(Time.Milli(1100));
		now = Time.Milli(250);
		clock.set(undefined);
		await flush();
		expect(sync.now()).toBe(Time.Milli(1150));
		now = Time.Milli(300);
		expect(sync.now()).toBe(Time.Milli(1200));
	});

	it("releases old waits on reset and requires a fresh clock snapshot", async () => {
		const clock = new Signal<Clock | undefined>({
			timestamp: Time.Milli(1200),
			reference: now,
			rate: 0,
		});
		const delay = new Signal<Delay>(Time.Milli(100));
		sync = new Sync({ clock, delay });
		await flush();
		const pending = sync.wait(Time.Milli(1300));
		sync.reset();
		await pending;
		expect(sync.now()).toBeUndefined();
		delay.set(Time.Milli(150));
		await flush();
		expect(sync.now()).toBeUndefined();
		clock.set({ timestamp: Time.Milli(30), reference: now, rate: 1 });
		await flush();
		expect(sync.now()).toBe(Time.Milli(30));
	});

	it("keeps the fallback continuous when the audio target disappears with its clock", async () => {
		const clock = new Signal<Clock | undefined>({
			timestamp: Time.Milli(1000),
			reference: Time.Milli(100),
			rate: 1,
		});
		const audioTarget = new Signal<Time.Milli | undefined>(Time.Milli(300));
		sync = new Sync({ clock, audioTarget });
		await flush();
		expect(sync.now()).toBe(Time.Milli(1100));
		clock.set(undefined);
		audioTarget.set(undefined);
		await flush();
		expect(sync.out.delay.peek()).toBe(Time.Milli(100));
		expect(sync.now()).toBe(Time.Milli(1100));
		now = Time.Milli(250);
		expect(sync.now()).toBe(Time.Milli(1150));
	});

	it("ignores the audio clock and releases held frames in instant mode", async () => {
		const delay = new Signal<Delay>(Time.Milli(100));
		sync = new Sync({
			delay,
			clock: { timestamp: Time.Milli(1000), reference: now, rate: 0 },
		});
		await flush();
		sync.received(Time.Milli(50), "video");
		const pending = sync.wait(Time.Milli(2000));
		delay.set("instant");
		await pending;
		await flush();
		now = Time.Milli(250);
		expect(sync.now()).toBe(Time.Milli(100));
		await sync.wait(Time.Milli(100000));
	});

	it("releases a held frame when closed", async () => {
		sync = new Sync({ clock: { timestamp: Time.Milli(0), reference: now, rate: 0 } });
		await flush();
		const pending = sync.wait(Time.Milli(100));
		sync.close();
		await pending;
	});

	it("uses measured audio delay only in auto and preserves buffer budgets", async () => {
		const delay = new Signal<Delay>("auto");
		const audioTarget = new Signal<Time.Milli | undefined>(Time.Milli(200));
		sync = new Sync({ delay, audioTarget, audio: Time.Milli(20), buffer: Time.Milli(300) });
		await flush();
		expect(sync.out.delay.peek()).toBe(Time.Milli(200));
		expect(sync.out.maxAge.peek()).toBe(Time.Milli(500));
		audioTarget.set(Time.Milli(10));
		await flush();
		expect(sync.out.delay.peek()).toBe(Time.Milli(120));
		audioTarget.set(Time.Milli(300));
		delay.set(Time.Milli(60));
		await flush();
		expect(sync.out.delay.peek()).toBe(Time.Milli(80));
		expect(sync.out.maxAge.peek()).toBe(Time.Milli(380));
		delay.set("instant");
		await flush();
		expect(sync.out.delay.peek()).toBe(Time.Milli(0));
		expect(sync.out.maxAge.peek()).toBe(Time.Milli(0));
	});
});

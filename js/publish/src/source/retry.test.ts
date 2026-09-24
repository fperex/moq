import { expect, spyOn, test } from "bun:test";
import { Effect, Signal } from "@moq/signals";
import { Camera } from "./camera";
import { Microphone } from "./microphone";
import { Retry } from "./retry";
import { Screen } from "./screen";
import type { Media } from "./types";

// A MediaStreamTrack ends on its own when the device disappears or the OS revokes it. Only the bits
// the sources touch, plus end() to fire it.
class FakeTrack extends EventTarget {
	readyState: MediaStreamTrackState = "live";
	stopped = false;

	// Told to the device that handed this track out, which stays busy for a while afterwards.
	onstop: (() => void) | undefined;

	getSettings(): MediaTrackSettings {
		return { deviceId: "default" };
	}

	stop(): void {
		this.stopped = true;
		this.readyState = "ended";
		this.onstop?.();
	}

	/** Die the way an unplugged device does. */
	end(): void {
		this.readyState = "ended";
		this.dispatchEvent(new Event("ended"));
	}
}

class FakeMediaDevices extends EventTarget {
	tracks: FakeTrack[] = [];

	// getUserMedia rejects, the way it does once the last device is gone.
	missing = false;
	denied = false;

	// Hand back an already-dead track, the way a device that vanished mid-call would.
	bornDead = false;

	// What enumerateDevices reports; replacing it and firing devicechange simulates a replug.
	devices: MediaDeviceInfo[] = [device("cam")];

	async enumerateDevices(): Promise<MediaDeviceInfo[]> {
		return this.devices;
	}

	// Every capture attempt, including the ones that never produce a track. `tracks` can't stand in:
	// a missing device rejects without pushing one.
	attempts = 0;

	// How long the device stays busy after a capture on it is stopped. A browser finishes handing a
	// camera back to the OS well after `stop()` returns, and answers anything asking meanwhile with
	// "could not start video source".
	release = 0;
	#busyUntil = 0;

	// Held open to keep an attempt in flight, so a toggle can land while one is still running.
	hold: PromiseWithResolvers<void> | undefined;

	// Acquisitions and releases in the order they happened.
	order: ("acquire" | "release")[] = [];

	async getUserMedia(): Promise<MediaStream> {
		this.order.push("acquire");
		this.attempts += 1;
		if (this.hold) await this.hold.promise;
		if (this.denied) throw new DOMException("Permission denied", "NotAllowedError");
		if (this.missing) throw new Error("NotFoundError");
		if (Date.now() < this.#busyUntil) throw new DOMException("Could not start video source", "NotReadableError");

		const track = new FakeTrack();
		track.onstop = () => {
			this.order.push("release");
			this.#busyUntil = Date.now() + this.release;
		};
		if (this.bornDead) track.readyState = "ended";
		this.tracks.push(track);

		return {
			getTracks: () => [track],
			getAudioTracks: () => [track],
			getVideoTracks: () => [track],
		} as unknown as MediaStream;
	}

	/** The track handed to the most recent capture. */
	latest(): FakeTrack {
		const track = this.tracks.at(-1);
		if (!track) throw new Error("no track captured");
		return track;
	}

	/** Swap the device list and announce it, the way a replug does. */
	replug(devices: MediaDeviceInfo[]): void {
		this.devices = devices;
		this.dispatchEvent(new Event("devicechange"));
	}
}

// Screen capture hands back independent video and audio tracks, which can end separately.
class FakeScreenDevices extends EventTarget {
	readonly video = new FakeTrack();
	readonly audio = new FakeTrack();
	displays = 0;

	constructor(bornDead = false) {
		super();
		if (bornDead) this.video.readyState = "ended";
	}

	async getDisplayMedia(): Promise<MediaStream> {
		this.displays += 1;
		return {
			getTracks: () => [this.video, this.audio],
			getVideoTracks: () => [this.video],
			getAudioTracks: () => [this.audio],
		} as unknown as MediaStream;
	}
}

function device(deviceId: string): MediaDeviceInfo {
	return { deviceId, label: deviceId, groupId: deviceId, kind: "videoinput", toJSON: () => ({}) };
}

function install<T extends EventTarget>(media: T): T & Disposable {
	const originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
	Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: media });

	// Screen capture probes self.CaptureController.
	const originalSelf = Object.getOwnPropertyDescriptor(globalThis, "self");
	Object.defineProperty(globalThis, "self", { configurable: true, value: globalThis });

	return Object.assign(media, {
		[Symbol.dispose]() {
			if (originalMediaDevices) Object.defineProperty(navigator, "mediaDevices", originalMediaDevices);
			else Reflect.deleteProperty(navigator, "mediaDevices");

			if (originalSelf) Object.defineProperty(globalThis, "self", originalSelf);
			else Reflect.deleteProperty(globalThis, "self");
		},
	});
}

const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve));
async function settle(times = 20): Promise<void> {
	for (let i = 0; i < times; i++) await flush();
}

/**
 * Poll until `pred` holds, so a regression fails the test instead of hanging it.
 *
 * A reopen waits out {@link Retry.DELAY} on a real timer, so microtask flushing alone never
 * reaches it. Polling rather than sleeping for the exact delay keeps a loaded runner from
 * deciding the outcome.
 */
async function waitUntil(pred: () => boolean): Promise<void> {
	const deadline = Date.now() + WAIT_TIMEOUT;
	while (!pred()) {
		if (Date.now() > deadline) throw new Error("timed out waiting for condition");
		await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
	}
}

/**
 * Poll until the capture stops reopening, meaning the budget is spent.
 *
 * Watches for quiet rather than an exact attempt count: a device-list change can refund the budget
 * mid-cascade and buy another round. The window outlasts the largest backoff, so quiet here means
 * stopped rather than mid-wait.
 */
async function waitSpent(media: FakeMediaDevices): Promise<void> {
	const quiet = (Retry.DELAY.max ?? 0) + QUIET_MARGIN;

	let seen = -1;
	while (seen !== media.attempts) {
		seen = media.attempts;
		await new Promise((resolve) => setTimeout(resolve, quiet));
	}
	await settle();
}

/** How long a `waitUntil` polls before calling the condition unreachable. */
const WAIT_TIMEOUT = 10_000;
/** How often `waitUntil` re-checks; short, since everything it watches is in-process. */
const POLL_INTERVAL = 5;
/** Quiet time past the largest backoff that proves the capture really stopped reopening. */
const QUIET_MARGIN = 100;
/** Burning the whole budget waits out every backoff, which outlasts the default per-test timeout. */
const SPENT_TIMEOUT = 30_000;

/**
 * An upper bound on how long the whole budget takes to burn: the first attempt plus a full backoff
 * for each failure it tolerates.
 *
 * A device busy for this long outlives every attempt the budget pays for, which is what a camera
 * handed back to the OS looks like on the machine this was reported from.
 */
function budgetWindow(): number {
	let delay = Retry.DELAY.initial;
	let total = 0;
	for (let i = 0; i <= Retry.LIMIT; i++) {
		total += delay;
		delay = Math.min(delay * Retry.DELAY.multiplier, Retry.DELAY.max);
	}
	return total;
}

/** The track a source published, or undefined. */
function published(media: Media | undefined): unknown {
	const source = media?.audio ?? media?.video;
	if (!source) return undefined;
	return "track" in source ? source.track : source;
}

for (const [kind, create] of [
	["camera", (enabled: Signal<boolean>) => new Camera({ enabled })],
	["microphone", (enabled: Signal<boolean>) => new Microphone({ enabled })],
] as const) {
	test(`${kind} reports a refusal and stops retrying until capture is reset`, async () => {
		using media = install(new FakeMediaDevices());
		media.denied = true;
		const enabled = new Signal(true);
		const source = create(enabled);
		await settle();

		expect(source.out.error.peek()?.name).toBe("NotAllowedError");
		expect(source.out.source.peek()).toBeUndefined();
		await new Promise((resolve) => setTimeout(resolve, Retry.DELAY.max + QUIET_MARGIN));
		expect(media.attempts).toBe(1);

		media.denied = false;
		enabled.set(false);
		await settle();
		expect(source.out.error.peek()).toBeUndefined();
		enabled.set(true);
		await waitUntil(() => source.out.source.peek() !== undefined);
		expect(media.attempts).toBe(2);
		source.close();
	});
}

test("a microphone re-opens when its track dies", async () => {
	using media = install(new FakeMediaDevices());

	const mic = new Microphone({ enabled: true });
	await settle();
	expect(media.tracks).toHaveLength(1);

	media.latest().end();
	await waitUntil(() => media.tracks.length === 2);
	await settle();

	// A second capture happened, and the live replacement is what got published.
	expect(published(mic.out.source.peek())).toBe(media.latest());

	mic.close();
});

test("a camera re-opens when its track dies", async () => {
	using media = install(new FakeMediaDevices());

	const camera = new Camera({ enabled: true });
	await settle();
	expect(media.tracks).toHaveLength(1);

	media.latest().end();
	await waitUntil(() => media.tracks.length === 2);
	await settle();

	expect(published(camera.out.source.peek())).toBe(media.latest());

	camera.close();
});

test("running out of retries clears the source instead of publishing a corpse", async () => {
	using media = install(new FakeMediaDevices());

	const mic = new Microphone({ enabled: true });
	await settle();

	// Kill every replacement the moment it arrives; the budget allows one reopen per failure.
	for (let i = 0; i < Retry.LIMIT; i++) {
		const before = media.tracks.length;
		media.latest().end();
		await waitUntil(() => media.tracks.length > before);
	}

	// The budget is spent, so this death schedules nothing at all: a settle is enough to catch a
	// reopen that shouldn't happen.
	media.latest().end();
	await settle();

	// The first capture plus one retry per allowed failure, and nothing after.
	expect(media.tracks).toHaveLength(Retry.LIMIT + 1);

	// Critically, the dead track is not left published: encoders would get no frames while the UI
	// still reported a live source.
	expect(mic.out.source.peek()).toBeUndefined();

	// And it says why, so something other than silence can report it.
	expect(mic.out.error.peek()).toBeInstanceOf(Error);

	mic.close();
});

test("a track that arrives dead is not published", async () => {
	using media = install(new FakeMediaDevices());
	media.bornDead = true;

	const mic = new Microphone({ enabled: true });
	await settle();

	expect(mic.out.source.peek()).toBeUndefined();

	mic.close();
});

test(
	"a replug recovers a capture whose retries all failed",
	async () => {
		using media = install(new FakeMediaDevices());

		const camera = new Camera({ enabled: true });
		await settle();
		expect(media.tracks).toHaveLength(1);

		// Unplug the only camera: the track dies and every reopen finds nothing.
		media.missing = true;
		media.replug([]);
		media.latest().end();
		await waitSpent(media);

		const spent = media.tracks.length;
		expect(camera.out.source.peek()).toBeUndefined();

		// Plug it back in. Without the device-list refund this stays dead forever, because an unpinned
		// `requested` is undefined both before and after, so nothing else reruns the capture.
		media.missing = false;
		media.replug([device("cam")]);
		await waitUntil(() => media.tracks.length > spent);
		await settle();

		expect(media.tracks.length).toBeGreaterThan(spent);
		expect(published(camera.out.source.peek())).toBe(media.latest());

		camera.close();
	},
	SPENT_TIMEOUT,
);

test(
	"picking a different device revives a capture whose retries all failed",
	async () => {
		using media = install(new FakeMediaDevices());
		media.devices = [device("cam"), device("cam2")];

		const camera = new Camera({ enabled: true });
		await settle();

		// Burn the budget: every attempt hands back a dead track.
		media.bornDead = true;
		camera.device.preferred.set("cam");
		await waitSpent(media);

		const spent = media.tracks.length;
		expect(camera.out.source.peek()).toBeUndefined();

		// Selecting another device is the user's obvious recovery, and the device list has not changed,
		// so nothing else would rerun the capture.
		media.bornDead = false;
		camera.device.preferred.set("cam2");
		await waitUntil(() => media.tracks.length > spent);
		await settle();

		expect(media.tracks.length).toBeGreaterThan(spent);
		expect(published(camera.out.source.peek())).toBe(media.latest());

		camera.close();
	},
	SPENT_TIMEOUT,
);

test(
	"changing the constraints revives a capture whose retries all failed",
	async () => {
		using media = install(new FakeMediaDevices());

		const mic = new Microphone({ enabled: true, constraints: { channelCount: 99 } });
		await settle();

		// The fake ignores constraints, so `missing` causes a terminal failure. The next
		// constraint edit is new intent and reopens the capture.
		media.missing = true;
		mic.constraints.set({ channelCount: 98 });
		await waitSpent(media);

		const spent = media.tracks.length;
		expect(mic.out.source.peek()).toBeUndefined();

		// Editing a constraint is new intent rather than another go at the same thing, so it buys a
		// fresh budget. Nothing else here would rerun the capture: the device list never changed.
		media.missing = false;
		mic.constraints.set({ channelCount: 1 });
		await waitUntil(() => media.tracks.length > spent);
		await settle();

		expect(media.tracks.length).toBeGreaterThan(spent);
		expect(published(mic.out.source.peek())).toBe(media.latest());

		mic.close();
	},
	SPENT_TIMEOUT,
);

test("unrelated device churn does not disturb a healthy capture", async () => {
	using media = install(new FakeMediaDevices());

	const camera = new Camera({ enabled: true });
	await settle();
	expect(media.tracks).toHaveLength(1);

	// A second camera appears. Re-opening here would drop frames for no reason.
	media.replug([device("cam"), device("cam2")]);
	await settle(40);

	expect(media.tracks).toHaveLength(1);
	expect(published(camera.out.source.peek())).toBe(media.latest());

	camera.close();
});

test("screen capture releases every track when the video ends", async () => {
	using media = install(new FakeScreenDevices());

	const screen = new Screen({ enabled: true });
	await settle();
	expect(media.displays).toBe(1);
	expect(screen.out.source.peek()).toBeDefined();

	// Only the video track ends, as it does when the shared window closes. The audio track has to be
	// released too, or it keeps capturing invisibly.
	media.video.end();
	await settle();

	expect(screen.out.source.peek()).toBeUndefined();
	expect(media.audio.stopped).toBe(true);

	// getDisplayMedia needs a user gesture, so it must not re-prompt.
	expect(media.displays).toBe(1);

	screen.close();
});

test("screen capture releases every track when the audio ends", async () => {
	using media = install(new FakeScreenDevices());

	const screen = new Screen({ enabled: true });
	await settle();

	media.audio.end();
	await settle();

	expect(screen.out.source.peek()).toBeUndefined();
	expect(media.video.stopped).toBe(true);
	expect(media.displays).toBe(1);

	screen.close();
});

test("screen capture releases a share whose track arrives dead", async () => {
	using media = install(new FakeScreenDevices(true));

	const screen = new Screen({ enabled: true });
	await settle();

	// It fired "ended" before anything could listen, so publishing it would strand a dead share that
	// nothing clears.
	expect(screen.out.source.peek()).toBeUndefined();
	expect(media.audio.stopped).toBe(true);
	expect(media.displays).toBe(1);

	screen.close();
});

test("screen capture prompts again after being switched off and on", async () => {
	using media = install(new FakeScreenDevices());
	const enabled = new Signal(true);

	const screen = new Screen({ enabled });
	await settle();
	media.video.end();
	await settle();
	expect(media.displays).toBe(1);

	// Toggling the source off is the app's reset, so enabling it again is a fresh user action.
	enabled.set(false);
	await settle();
	enabled.set(true);
	await settle();

	expect(media.displays).toBe(2);

	screen.close();
});

for (const screenPixelRatio of [undefined, 2]) {
	test(`screen capture maps pixel ratio ${screenPixelRatio} into source scale`, async () => {
		using media = install(new FakeScreenDevices());
		const settings = spyOn(media.video, "getSettings").mockReturnValue({
			deviceId: "default",
			screenPixelRatio,
		} as MediaTrackSettings);
		const screen = new Screen({ enabled: true });
		try {
			await settle();
			const source = screen.out.source.peek()?.video;
			expect(source).toMatchObject({ track: media.video, scale: screenPixelRatio });
			settings.mockReturnValue({ deviceId: "default", screenPixelRatio: 1 } as MediaTrackSettings);
			expect(source).toMatchObject({ track: media.video, scale: 1 });
			expect(screen.out.source.peek()?.video).toBe(source);
		} finally {
			screen.close();
			settings.mockRestore();
		}
	});
}

// A capture that is busy is not a capture that is broken. The device is there and we are allowed to
// use it: something else has it, very often the capture we ourselves just stopped, because a browser
// finishes handing a device back well after `stop()` returns. Counting that window against the
// budget is what left the user's preview black after hiding video and showing it again.

/** What a browser rejects with while a device is still held. */
function busy(): DOMException {
	return new DOMException("Could not start video source", "NotReadableError");
}

test("a busy device waits instead of spending the budget", () => {
	const error = new Signal<Error | undefined>(undefined);
	const retry = new Retry(error);
	const effect = new Effect();

	try {
		// The first call is what the budget is keyed to; reuse the array so nothing looks like new intent.
		const settings = [undefined];
		expect(retry.begin(effect, settings)).toBe(true);

		// Far more failures than the budget tolerates.
		for (let i = 0; i < Retry.LIMIT * 3; i++) {
			retry.failed(busy());
			expect(retry.begin(effect, settings)).toBe(false); // paying the backoff
			expect(retry.begin(effect, settings)).toBe(true); // and still willing to try
		}

		// Loudly, the whole time.
		expect(error.peek()?.name).toBe("NotReadableError");
	} finally {
		effect.close();
	}
});

test("a device that refuses still spends the budget", () => {
	const error = new Signal<Error | undefined>(undefined);
	const retry = new Retry(error);
	const effect = new Effect();

	try {
		const settings = [undefined];
		expect(retry.begin(effect, settings)).toBe(true);

		for (let i = 0; i < Retry.LIMIT; i++) {
			retry.failed(new Error("no such device"));
			expect(retry.begin(effect, settings)).toBe(false);
			expect(retry.begin(effect, settings)).toBe(true);
		}

		retry.failed(new Error("no such device"));
		retry.begin(effect, settings);
		expect(retry.begin(effect, settings)).toBe(false);
		expect(error.peek()?.message).toBe("no such device");
	} finally {
		effect.close();
	}
});

test("a capture waits for the previous one to be released before asking again", async () => {
	using media = install(new FakeMediaDevices());
	media.hold = Promise.withResolvers<void>();

	const enabled = new Signal(true);
	const camera = new Camera({ enabled });

	try {
		// The first attempt is still in flight when the user hides video and shows it again.
		await waitUntil(() => media.attempts === 1);
		enabled.set(false);
		await settle();
		enabled.set(true);
		await settle(40);

		// Asking now would be asking for a device we have not let go of.
		expect(media.attempts).toBe(1);

		media.hold.resolve();
		await waitUntil(() => media.attempts === 2);
		await settle();

		expect(media.order).toEqual(["acquire", "release", "acquire"]);
	} finally {
		camera.close();
	}
});

test(
	"hiding video and showing it again survives a device that is still being released",
	async () => {
		using media = install(new FakeMediaDevices());
		media.release = budgetWindow();

		const enabled = new Signal(true);
		const camera = new Camera({ enabled });

		try {
			await waitUntil(() => camera.out.source.peek() !== undefined);

			// Three fast toggles, the way a user checks whether the button works at all.
			for (let i = 0; i < 3; i++) {
				enabled.set(false);
				await settle();
				enabled.set(true);
				await settle();
			}

			// It says why it is dark rather than leaving a black preview to speak for it.
			await waitUntil(() => camera.out.error.peek() !== undefined);
			expect(camera.out.error.peek()?.name).toBe("NotReadableError");

			// And it is still asking, so the camera comes back as soon as the device is free.
			await waitUntil(() => camera.out.source.peek() !== undefined);
			expect(published(camera.out.source.peek())).toBe(media.latest());
			expect(camera.out.error.peek()).toBeUndefined();
		} finally {
			camera.close();
		}
	},
	SPENT_TIMEOUT,
);

import { expect, mock, spyOn, test } from "bun:test";

// The element pulls in a worklet and a worker through Vite's `?worklet` / `?worker` imports, which
// only a bundler resolves. Neither runs here: nothing in these tests captures audio or encodes.
mock.module("./audio/capture-worklet.ts?worklet", () => ({ default: "blob:worklet" }));
mock.module("./video/capture-worker.ts?worker&inline", () => ({ default: class {} }));

class FakeTrack extends EventTarget {
	readyState: MediaStreamTrackState = "live";

	readonly kind: string;
	readonly deviceId: string;

	constructor(kind: string, deviceId = "default") {
		super();
		this.kind = kind;
		this.deviceId = deviceId;
	}

	getSettings(): MediaTrackSettings {
		return { deviceId: this.deviceId };
	}

	getConstraints(): MediaTrackConstraints {
		return {};
	}

	stop(): void {
		this.readyState = "ended";
	}
}

function stream(tracks: FakeTrack[]): MediaStream {
	return {
		getTracks: () => tracks,
		getVideoTracks: () => tracks.filter((t) => t.kind === "video"),
		getAudioTracks: () => tracks.filter((t) => t.kind === "audio"),
	} as unknown as MediaStream;
}

class FakeMediaDevices extends EventTarget {
	video: FakeTrack[] = [];

	// Cameras that answer `getUserMedia` with a track that is already over, which is how a device
	// that is enumerated but not actually there behaves.
	dead = new Set<string>();

	async enumerateDevices(): Promise<MediaDeviceInfo[]> {
		return ["cam", "cam2"].map((id) => ({
			deviceId: id,
			label: id,
			groupId: id,
			kind: "videoinput" as MediaDeviceKind,
			toJSON: () => ({}),
		}));
	}

	async getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream> {
		if (!constraints.video) return stream([new FakeTrack("audio")]);

		const requested = (constraints.video as MediaTrackConstraints).deviceId as { exact?: string } | undefined;
		const video = new FakeTrack("video", requested?.exact ?? "cam");
		if (this.dead.has(video.deviceId)) video.readyState = "ended";
		this.video.push(video);
		return stream([video]);
	}

	async getDisplayMedia(): Promise<MediaStream> {
		return stream([new FakeTrack("video"), new FakeTrack("audio")]);
	}
}

// Enough of a document for a custom element to be constructed and to look for its preview child.
class FakeHTMLElement {
	querySelector(): null {
		return null;
	}
}

const media = new FakeMediaDevices();
Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: FakeHTMLElement });
Object.defineProperty(globalThis, "HTMLVideoElement", { configurable: true, value: class {} });
Object.defineProperty(globalThis, "HTMLCanvasElement", { configurable: true, value: class {} });
Object.defineProperty(globalThis, "customElements", { configurable: true, value: { define: () => {} } });
Object.defineProperty(globalThis, "MutationObserver", {
	configurable: true,
	value: class {
		observe() {}
		disconnect() {}
	},
});
Object.defineProperty(globalThis, "self", { configurable: true, value: globalThis });
Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: media });

const { default: MoqPublish } = await import("./element");

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

// Each selected source wires its track into the capture inputs with a mirror effect. Registered on
// the element they outlive the source they read, so every switch leaves another one behind holding
// a closed source alive, and the newest is not the only one writing the input.
test("switching the source leaves no mirror behind", async () => {
	const el = new MoqPublish();

	// From here on, anything registered for the element's lifetime is something a switch leaked.
	const run = spyOn(el.signals, "run");

	try {
		// Audio needs a WebAudio graph that nothing here provides, and the camera is the subject.
		el.muted = true;

		el.source = "camera";
		await settle();
		expect(el.capture.in.source.peek()).toBe(media.video[0] as never);

		el.source = "screen";
		await settle();

		el.source = "camera";
		await settle();

		expect(run).not.toHaveBeenCalled();

		// And the surviving mirror is the live one.
		expect(media.video).toHaveLength(2);
		expect(el.capture.in.source.peek()).toBe(media.video[1] as never);
	} finally {
		run.mockRestore();
		el.signals.close();
	}
});

// Capture a camera, then hand back the camera source so a test can drive its device selection.
async function capture(el: InstanceType<typeof MoqPublish>) {
	media.video.length = 0;
	media.dead.clear();

	// Audio needs a WebAudio graph that nothing here provides, so the camera is the only source.
	el.muted = true;
	el.source = "camera";
	await settle();

	const camera = el.sources.video.peek();
	if (!camera || !("device" in camera)) throw new Error("the camera source never appeared");
	expect(el.broadcast.in.announce.peek()).toBe(true);
	return camera;
}

// A device change stops one track and opens another, so the element has no media for as long as the
// browser takes to answer. Announcing only while a track exists tore the whole broadcast down for
// that window: the relay dropped every subscription, catalog included, and re-announced a moment
// later as a different broadcast to everyone watching.
test("switching the camera keeps the broadcast announced", async () => {
	const el = new MoqPublish();

	try {
		const camera = await capture(el);

		const announced: boolean[] = [];
		const dispose = el.broadcast.in.announce.subscribe((value) => announced.push(value));

		camera.device.preferred.set("cam2");
		await settle();
		dispose();

		// The new device is serving, and nothing in between said the broadcast was gone.
		expect(media.video).toHaveLength(2);
		expect(el.capture.in.source.peek()).toBe(media.video[1] as never);
		expect((media.video[1] as FakeTrack).deviceId).toBe("cam2");
		expect(announced).toEqual([]);
		expect(el.broadcast.in.announce.peek()).toBe(true);
	} finally {
		el.signals.close();
	}
});

// The device picked may not be usable at all. That is one track's failure: everything else the
// broadcast serves (the catalog, the other rendition) has to keep going, and the reason has to be
// readable rather than a black preview.
test("a camera that cannot be opened keeps the broadcast announced and names the reason", async () => {
	const el = new MoqPublish();

	try {
		const camera = await capture(el);
		media.dead.add("cam2");

		camera.device.preferred.set("cam2");
		await settle();

		expect(el.capture.in.source.peek()).toBeUndefined();
		expect(el.errors.video.peek()?.message).toBe("the camera produced no live track");
		expect(el.broadcast.in.announce.peek()).toBe(true);
	} finally {
		el.signals.close();
	}
});

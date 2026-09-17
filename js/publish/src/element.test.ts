import { expect, mock, spyOn, test } from "bun:test";

// The element pulls in a worklet and a worker through Vite's `?worklet` / `?worker` imports, which
// only a bundler resolves. Neither runs here: nothing in these tests captures audio or encodes.
mock.module("./audio/capture-worklet.ts?worklet", () => ({ default: "blob:worklet" }));
mock.module("./video/capture-worker.ts?worker&inline", () => ({ default: class {} }));

class FakeTrack extends EventTarget {
	readyState: MediaStreamTrackState = "live";

	readonly kind: string;

	constructor(kind: string) {
		super();
		this.kind = kind;
	}

	getSettings(): MediaTrackSettings {
		return { deviceId: "default" };
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

	async enumerateDevices(): Promise<MediaDeviceInfo[]> {
		return [{ deviceId: "cam", label: "cam", groupId: "cam", kind: "videoinput", toJSON: () => ({}) }];
	}

	async getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream> {
		if (!constraints.video) return stream([new FakeTrack("audio")]);

		const video = new FakeTrack("video");
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

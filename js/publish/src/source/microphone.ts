import { Effect, type Getter, getter, type Inputs, type Readonlys, readonlys, Signal } from "@moq/signals";
import type * as Audio from "../audio";
import { Device, type DeviceProps } from "./device";
import { Retry } from "./retry";
import type { Media } from "./types";

// Signals the microphone reads.
export type MicrophoneInput = {
	// Whether to hold the microphone open. Defaults to true. When false the track is stopped and `out.source` clears.
	enabled: Getter<boolean>;
};

/** Constructor options: the wired inputs, the live-editable constraints, and the device seed. */
export interface MicrophoneProps extends Inputs<MicrophoneInput> {
	/** Seed the device selection; also live-editable via `microphone.device`. */
	device?: DeviceProps;
	/** Seed the capture constraints; also live-editable via `microphone.constraints`. */
	constraints?: Audio.Constraints | Signal<Audio.Constraints | undefined>;
}

type MicrophoneOutput = {
	// The live microphone track, or undefined while disabled or denied.
	source: Signal<Media | undefined>;
	/**
	 * Why there is no track while the microphone is enabled, or undefined while it is capturing: a
	 * refusal that stands until the settings, device list, or permission changes, or the failure it
	 * is retrying after.
	 */
	error: Signal<Error | undefined>;
};

// A capture attempt: the stream the browser handed over, or why it would not.
type Attempt = { stream: MediaStream; error?: undefined } | { stream?: undefined; error: unknown };

/** Captures audio from a microphone, tracking the available devices. */
export class Microphone {
	readonly in: Readonlys<MicrophoneInput>;

	/** The available microphones and which one to use. */
	readonly device: Device<"audio">;

	/** The live-editable capture constraints. */
	constraints: Signal<Audio.Constraints | undefined>;

	readonly #out: MicrophoneOutput = {
		source: new Signal<Media | undefined>(undefined),
		error: new Signal<Error | undefined>(undefined),
	};
	readonly out = readonlys(this.#out);

	#signals = new Effect();
	#retry = new Retry(this.#out.error);

	// The release of the capture the previous run held, awaited before the next attempt. See
	// `Camera` for why: a device we have not finished handing back rejects the next attempt.
	#released: Promise<void> = Promise.resolve();

	constructor(props?: MicrophoneProps) {
		this.in = {
			enabled: getter(props?.enabled ?? true),
		};
		this.device = new Device("audio", props?.device);
		this.constraints = Signal.from(props?.constraints);

		this.#signals.run(this.#run.bind(this));
	}

	#run(effect: Effect): void {
		const enabled = effect.get(this.in.enabled);
		if (!enabled) {
			// Being switched off is the app's reset, so a later enable starts with a full budget.
			this.#retry.refund();
			this.#out.error.set(undefined);
			return;
		}

		// Read the settings before checking the budget, so changing one both reruns this effect and
		// buys it a fresh budget.
		const device = effect.get(this.device.out.requested);
		const constraints = effect.get(this.constraints);

		if (!this.#retry.begin(effect, [device, constraints])) {
			// Waiting out a backoff, or out of budget entirely, with the same settings. Either way
			// a change to what is plugged in is new information worth acting on now, so watch the
			// device list here and not while healthy, where a rerun would restart a working capture
			// for unrelated device churn.
			const spent = this.device.out.available.peek();
			effect.subscribe(this.device.out.available, (available) => {
				if (available !== spent) this.#retry.refund();
			});
			const permitted = this.device.out.permission.peek();
			effect.subscribe(this.device.out.permission, (granted) => {
				if (granted && !permitted) this.#retry.refund();
			});
			return;
		}

		const finalConstraints: MediaTrackConstraints = {
			...constraints,
			deviceId: device ? { exact: device } : undefined,
		};

		effect.spawn(async () => {
			// Let go of the last capture before asking for a device again: the browser is still
			// holding it otherwise, and it answers that with a failure like any other.
			await Promise.race([this.#released, effect.cancel]);
			if (effect.abort.aborted) return;

			const media = navigator.mediaDevices
				.getUserMedia({ audio: finalConstraints })
				.then((stream): Attempt => ({ stream }))
				.catch((error: unknown): Attempt => ({ error }));

			// If the effect is cancelled for any reason (ex. cancel), stop any media that we got,
			// and keep the release for the next attempt to wait on.
			effect.cleanup(() => {
				this.#released = media.then(({ stream }) => {
					stream?.getTracks().forEach((track) => {
						track.stop();
					});
				});
			});

			const attempt = await Promise.race([media, effect.cancel]);

			// A torn-down run is not a failed attempt: whatever cancelled it reruns us.
			if (effect.abort.aborted || !attempt) return;

			// A refusal stands until something changes, unless the device was only busy.
			if (!attempt.stream) return this.#retry.refused(attempt.error);

			const track = attempt.stream.getAudioTracks()[0] as Audio.StreamTrack | undefined;
			const settings = track?.getSettings();

			// getUserMedia resolved, so we have permission even if no track came back.
			effect.cleanup(this.device.capture(settings?.deviceId));

			// A track that arrives dead already fired "ended", so nothing would ever rerun us.
			if (!track || track.readyState === "ended") {
				return this.#retry.failed(new Error("the microphone produced no live track"));
			}

			this.#retry.succeeded(effect, track);
			effect.set(this.#out.source, { audio: { track, kind: "voice" } });
		});
	}

	/** Stop the capture and release the device. */
	close() {
		this.#signals.close();
		this.device.close();
	}
}

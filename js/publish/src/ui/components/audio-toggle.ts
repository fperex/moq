import type { Effect } from "@moq/signals";
import type MoqPublish from "../../element";
import { icon, micOff, microphone } from "../icons";
import { controlButton } from "./button";

/** Toggles whether audio is published (publish.muted). Red when muted, or unmuted with no sound. */
export function audioToggle(parent: Effect, publish: MoqPublish): HTMLElement {
	const button = controlButton(microphone, "Mute");

	parent.run((effect) => {
		const hasSource = effect.get(publish.controls.source) !== undefined;
		const muted = effect.get(publish.controls.muted);

		// Unmuted but capturing nothing. Without this the button looks like any other working
		// control while the broadcast is silent.
		const error = muted ? undefined : effect.get(publish.errors.audio);

		button.disabled = !hasSource;
		button.classList.toggle("control--off", hasSource && muted);
		button.classList.toggle("control--error", !!error);
		button.title = error ? `Audio unavailable: ${error.message}` : muted ? "Unmute microphone" : "Mute microphone";
		button.setAttribute("aria-label", button.title);
		button.replaceChildren(icon(muted || error ? micOff : microphone));
	});

	parent.event(button, "click", () => {
		publish.muted = !publish.muted;
	});

	return button;
}

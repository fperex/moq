import type { Effect } from "@moq/signals";
import type MoqPublish from "../../element";
import { camera, cameraOff, icon } from "../icons";
import { controlButton } from "./button";

/** Toggles whether video is published (publish.invisible). Red when off, or on with no picture. */
export function videoToggle(parent: Effect, publish: MoqPublish): HTMLElement {
	const button = controlButton(camera, "Hide video");

	parent.run((effect) => {
		const hasSource = effect.get(publish.controls.source) !== undefined;
		const invisible = effect.get(publish.controls.invisible);

		// Video is switched on but there is nothing to publish. Without this the button looks like
		// any other working control while the preview sits black.
		const error = invisible ? undefined : effect.get(publish.errors.video);

		button.disabled = !hasSource;
		button.classList.toggle("control--off", hasSource && invisible);
		button.classList.toggle("control--error", !!error);
		button.title = error ? `Video unavailable: ${error.message}` : invisible ? "Show video" : "Hide video";
		button.setAttribute("aria-label", button.title);
		button.replaceChildren(icon(invisible || error ? cameraOff : camera));
	});

	parent.event(button, "click", () => {
		publish.invisible = !publish.invisible;
	});

	return button;
}

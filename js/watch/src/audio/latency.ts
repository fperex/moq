import { Time } from "@moq/net";
import type { Delay } from "../sync";

/** The inputs that determine whether audio needs a deeper playback cushion. */
export interface ReanchorFloor {
	/** How far playback trails the live edge. */
	delay: Delay;

	/** Additional delay required by the selected audio rendition. */
	audio?: Time.Milli;

	/** Additional delay required by the active or pending video rendition. */
	video?: Time.Milli;
}

/** The stable delay floor whose increase requires the audio ring to refill. */
export function reanchorFloor(props: ReanchorFloor): Time.Milli {
	// "auto" and "instant" contribute nothing: the adaptive RTT component is deliberately excluded
	// so an RTT wiggle doesn't re-anchor, and "instant" holds nothing at all.
	const target = typeof props.delay === "number" ? props.delay : Time.Milli.zero;
	const media = Time.Milli.max(props.audio ?? Time.Milli.zero, props.video ?? Time.Milli.zero);
	return Time.Milli.add(target, media);
}

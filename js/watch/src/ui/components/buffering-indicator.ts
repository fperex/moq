import type { Effect } from "@moq/signals";
import type MoqWatch from "../../element";

export function bufferingIndicator(parent: Effect, watch: MoqWatch): HTMLElement {
	const container = document.createElement("div");
	container.className = "buffering";
	const spinner = document.createElement("div");
	spinner.className = "buffering-spinner";
	container.appendChild(spinner);

	parent.run((effect) => {
		// Only what the viewer would call an interruption. Audio re-buffering once the ring has run
		// dry is just as much a stall as a video one, but the fill a cold start or an unmute costs
		// interrupts nothing: it is playback arriving, over video that never stopped painting.
		// Gate it on audio actually being downloaded, since a video-only broadcast has no ring to
		// speak for it.
		const audio = effect.get(watch.audio.in.enabled) && effect.get(watch.audio.source.out.config) !== undefined;
		const video = effect.get(watch.video.out.stalled) && !effect.get(watch.controls.paused);
		const buffering = video || (audio && effect.get(watch.audio.out.interrupted));
		const offline = effect.get(watch.broadcast.out.status) === "offline";
		const unsupported = effect.get(watch.video.source.out.error) === "unsupported";
		container.style.display = buffering && !offline && !unsupported ? "" : "none";

		// Which playhead everything is paced against, since a stall means something different for
		// each: the audio ring refilling parks playback, where the wall clock runs through it.
		const clock = effect.get(watch.sync.out.clock);
		container.title = clock ? `Buffering (${clock} clock)` : "Buffering";
	});

	return container;
}

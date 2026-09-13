/**
 * The page under measurement: the demo's player, nothing else.
 *
 * The DOM and the registration imports are the ones `demo/web/src/index.ts` uses, deliberately. A
 * harness page that builds its own audio graph measures the harness; this one measures what a viewer
 * would actually load, so a regression in the player chrome, the element's attribute handling, or
 * the worklet reaches these numbers the same way it reaches a viewer.
 *
 * Everything is driven from the query string, so one build serves every matrix row:
 *
 *     ?url=http://127.0.0.1:4499&broadcast=bbb.hang&delay=auto&tag=chromium-opus-48000-mild-plain
 *
 * @module
 */
import "@moq/watch/element"; // defines <moq-watch>
import "@moq/watch/ui"; // defines <moq-watch-ui>
import type MoqWatch from "@moq/watch/element";
import { beacon } from "./beacon.ts";
import { probe } from "./probe.ts";

const params = new URLSearchParams(location.search);
const required = (name: string): string => {
	const value = params.get(name);
	if (!value) throw new Error(`missing ?${name}`);
	return value;
};

const url = required("url");
const name = required("broadcast");
const tag = required("tag");
// "auto" is the adaptive path and what every profile but the control runs. A duration carries its
// unit because the element requires one: `delay="250"` is rejected, `delay="250ms"` is not.
const delay = params.get("delay") ?? "auto";
const sink = params.get("sink");

document.title = `moq audio quality: ${tag}`;

// The demo's exact nesting: <moq-watch-ui> finds its player with querySelector("moq-watch"), and
// <moq-watch> renders into a <canvas> child.
const watch = document.createElement("moq-watch") as MoqWatch;
watch.setAttribute("url", url);
watch.setAttribute("name", name);
watch.setAttribute("delay", delay);
// The window is never frontmost in a headless run, and the default visibility policy would stop
// downloading video and take the audio track's pacing with it.
watch.setAttribute("visible", "always");
watch.appendChild(document.createElement("canvas"));

const ui = document.createElement("moq-watch-ui");
ui.appendChild(watch);
document.body.appendChild(ui);

// Audio is the measurement, so it is on: muted would leave `emitter.out.enabled` false and nothing
// would ever reach the ring. Volume is set first because un-muting restores the stashed volume.
watch.volume = 1;
watch.muted = false;
watch.paused = false;

const collector = probe(watch);
const stop = sink
	? beacon({ url: sink, tag, drain: collector.drain, environment: collector.environment, notes: collector.notes })
	: undefined;

// The same batches the beacon posts, for a driver that pulls instead of being pushed to.
//
// The Safari lane has no sink: `safaridriver` is the only channel back, so its driver drains this
// through `execute/sync` on the same 250ms grid and writes the ndjson itself. One shape, one
// analyzer, whichever way the samples travelled.
(globalThis as unknown as { moqAudioQuality?: unknown }).moqAudioQuality = {
	tag,
	drain: () => collector.drain(),
	environment: () => collector.environment(),
	notes: () => collector.notes(),
};

// The driver reads the run off the DOM rather than out of the sink, so a row can be graded even if
// the sink never came up, and so a wait has something to poll.
const status = document.createElement("pre");
status.id = "status";
document.body.appendChild(status);
// Every read here goes through `peek`, which throws when an older build does not publish the signal
// at all. This status is what the driver waits on, so one missing counter must not be the reason a
// row never starts: the probe's own samples take the same care.
// A declaration rather than a generic arrow, whose `<T>` a JSX-aware parser reads as an element.
function peek<T>(read: () => T): T | undefined {
	try {
		return read();
	} catch {
		return undefined;
	}
}

setInterval(() => {
	const environment = collector.environment();
	status.dataset.ready = environment ? "1" : "0";
	status.textContent = JSON.stringify(
		{
			tag,
			delay,
			webSocket: typeof (globalThis as unknown as { WebSocket?: unknown }).WebSocket,
			crossOriginIsolated: globalThis.crossOriginIsolated === true,
			transport: environment?.transport,
			timestamp: peek(() => watch.audio.out.timestamp.peek()),
			stalled: peek(() => watch.audio.out.stalled.peek()),
			underruns: peek(() => watch.audio.out.underruns.peek()),
			resolved: peek(() => watch.sync.out.delay.peek()),
		},
		null,
		1,
	);
}, 250);

// Chromium runs with --autoplay-policy=no-user-gesture-required, but Safari and a human opening this
// by hand both need a real gesture before an AudioContext will start. The button is that gesture;
// `unlockOnGesture` inside the element is already listening for the pointerdown.
//
// Pinned to the corner above everything, because a WebDriver Element Click refuses an element the
// page has scrolled away or covered, and the player grows to fill the viewport the moment it has a
// frame to render. In flow it is clickable before the catalog arrives and "not interactable" after,
// which is the one moment the click has to work.
const start = document.createElement("button");
start.id = "start";
start.textContent = "start audio";
start.style.cssText = "position:fixed;top:0;left:0;z-index:2147483647";
start.addEventListener("click", () => {
	watch.muted = false;
	watch.paused = false;
});
document.body.appendChild(start);

// The driver closes the page to end a row, and `pagehide` is the last moment anything can be sent.
addEventListener("pagehide", () => {
	collector.stop();
	stop?.();
});

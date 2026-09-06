/**
 * Throwaway measurement harness (debug-findings/). Builds a bare <moq-publish> or <moq-watch>
 * from query params and polls the element's signals into window.__rt, which the console
 * overlay plugin drains to the beacon sink when ?beacon=<tag> is set.
 *
 *   harness.html?role=publish&url=<relay>&name=<broadcast>[&source=camera]
 *   harness.html?role=watch&url=<relay>&name=<broadcast>&delay=auto|100ms|...[&muted=1]
 */
import "@moq/publish/element";
import "@moq/watch/element";

// biome-ignore lint/suspicious/noExplicitAny: throwaway harness
type Any = any;
const params = new URLSearchParams(location.search);
const role = params.get("role");
const url = params.get("url") ?? "";
const name = params.get("name") ?? "";
const rt = (window as Any).__rt;
const push = (k: string, o: Record<string, unknown>) => rt?.push(k, o);
const info = document.getElementById("info") as HTMLDivElement;
const peek = (s: Any) => (s && typeof s.peek === "function" ? s.peek() : undefined);
const spanMs = (ranges: Any): number => {
	if (!Array.isArray(ranges)) return -1;
	let total = 0;
	// Ranges are Time.Milli; keep two decimals so a ~0 depth is visible.
	for (const r of ranges) total += Math.max(0, r.end - r.start);
	return Math.round(total * 100) / 100;
};

if (role === "publish") {
	await customElements.whenDefined("moq-publish");
	const el = document.createElement("moq-publish") as Any;
	el.id = "publish";
	el.setAttribute("url", url);
	el.setAttribute("name", name);
	el.setAttribute("source", params.get("source") ?? "camera");
	if (params.get("invisible")) el.setAttribute("invisible", ""); // audio-only publisher
	document.body.appendChild(el);
	console.log(`harness: publish url=${url} name=${name}`);
	setInterval(() => {
		const o = {
			transport: peek(el.connection?.transport),
			established: peek(el.connection?.established) !== undefined,
			audioFrames: peek(el.audio?.out?.stats)?.frames,
			audioBytes: peek(el.audio?.out?.stats)?.bytes,
			videoFrames: peek(el.video?.out?.stats)?.frames,
			keyframes: peek(el.video?.out?.stats)?.keyframes,
			audioCatalog: JSON.stringify(peek(el.audio?.out?.catalog) ?? null).slice(0, 300),
		};
		push("ppoll", o);
		info.textContent = JSON.stringify(o);
	}, 1000);
} else if (role === "watch") {
	await customElements.whenDefined("moq-watch");
	const el = document.createElement("moq-watch") as Any;
	el.id = "watch";
	el.setAttribute("url", url);
	el.setAttribute("name", name);
	const canvas = document.createElement("canvas");
	if (params.get("embed")) {
		// The exact DOM moq.watch renders for the demo: legacy `latency` attribute (the RTT mode
		// on main, coerced to auto on dev; a number is milliseconds), full volume, the default
		// 20% root margin so video gates on visibility, a 1280x720 canvas and an inert overlay.
		const preset = params.get("delay") ?? "auto";
		el.setAttribute("latency", preset === "auto" ? "real-time" : preset.replace(/ms$/, ""));
		el.setAttribute("volume", "1");
		el.setAttribute("visible", "20%");
		el.setAttribute("style", "display: block; position: relative; width: 100%;");
		canvas.setAttribute(
			"style",
			"max-width: 100%; height: auto; margin: 0px auto; border-radius: 1rem; width: 100%; max-height: 100%; object-fit: contain;",
		);
		canvas.width = 1280;
		canvas.height = 720;
		el.appendChild(canvas);
		const overlay = document.createElement("div");
		overlay.setAttribute("style", "position: absolute; inset: 0px; pointer-events: none; z-index: 1;");
		el.appendChild(overlay);
	} else {
		el.setAttribute("delay", params.get("delay") ?? "auto");
		// A render target makes <moq-watch> subscribe to and decode video; visible="always" drops
		// the viewport/tab gate so a background CDP tab still downloads.
		el.setAttribute("visible", "always");
		canvas.width = 640;
		canvas.height = 360;
		el.appendChild(canvas);
	}
	if (params.get("muted")) el.setAttribute("muted", "");
	document.body.appendChild(el);
	push("page", {
		isolated: (globalThis as Any).crossOriginIsolated === true,
		embed: !!params.get("embed"),
		ua: navigator.userAgent,
	});
	console.log(`harness: watch url=${url} name=${name} delay=${params.get("delay") ?? "auto"}`);
	// Safari/Firefox: the AudioContext only starts from a real gesture, which an AX click on this
	// button supplies (the element's unlockOnGesture listens for it). Chrome runs with autoplay off.
	if (params.get("gesture")) {
		const go = document.createElement("button");
		go.id = "go";
		go.textContent = "start audio";
		go.style.cssText = "position:fixed;left:0;top:0;width:100vw;height:40vh;font-size:48px;z-index:9";
		go.addEventListener("click", () => {
			push("gesture", { active: navigator.userActivation?.isActive ?? null });
			go.remove();
		});
		document.body.appendChild(go);
	}
	let lastCatalog = "";
	setInterval(() => {
		const audio = el.audio;
		const video = el.video;
		const o: Record<string, unknown> = {
			status: peek(el.broadcast?.out?.status),
			transport: peek(el.connection?.transport),
			rtt: peek(el.connection?.probe)?.rtt,
			jitter: peek(el.sync?.out?.jitter),
			delay: peek(el.sync?.out?.delay),
			maxAge: peek(el.sync?.out?.maxAge),
			ref: peek(el.sync?.out?.reference),
			astalled: peek(audio?.out?.stalled),
			abufMs: spanMs(peek(audio?.out?.buffered)),
			abytes: peek(audio?.out?.stats)?.bytesReceived,
			actx: peek(audio?.out?.context)?.state,
			arate: peek(audio?.out?.sampleRate),
			ajitter: peek(audio?.source?.out?.jitter),
			vstalled: peek(video?.out?.stalled),
			vframes: peek(video?.out?.stats)?.frameCount,
			vjitter: peek(video?.out?.jitter),
		};
		const cat = el.catalog;
		const now = cat?.audio ? JSON.stringify(cat.audio) : "";
		if (now && now !== lastCatalog) {
			o.catalogAudio = now.slice(0, 600);
			o.catalogVideo = JSON.stringify(cat.video).slice(0, 600);
			push("catalog", { audio: now.slice(0, 600), video: JSON.stringify(cat.video).slice(0, 600) });
			lastCatalog = now;
		}
		push("poll", o);
		info.textContent = JSON.stringify(o);
	}, 250);
} else {
	info.textContent = "usage: ?role=publish|watch&url=&name=[&delay=]";
}

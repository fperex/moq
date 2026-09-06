// Open a deployed moq.watch page in the CDP-driven Chrome and read what the unmodified build
// resolves: relay url/name, catalog audio (incl. jitter), Sync numbers, RTT, and poll the audio
// stalled/buffered signals for --seconds. bun inspect-moqwatch.mjs --cdp=9225 --url=https://moq.watch/demo/bbb.hang --seconds=60 --out=<file>
import { writeFileSync } from "node:fs";
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.match(/^--([^=]+)=(.*)$/)?.slice(1) ?? [a, true]));
const CDP = Number(args.cdp ?? 9225);
const URL_ = args.url ?? "https://moq.watch/demo/bbb.hang";
const SECONDS = Number(args.seconds ?? 60);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const info = await (await fetch(`http://127.0.0.1:${CDP}/json/new?${encodeURIComponent(URL_)}`, { method: "PUT" })).json();
const ws = new WebSocket(info.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const send = (method, params = {}) => new Promise((res) => {
	const myId = ++id;
	const h = (m) => { const msg = JSON.parse(m.data); if (msg.id === myId) { ws.removeEventListener("message", h); res(msg); } };
	ws.addEventListener("message", h);
	ws.send(JSON.stringify({ id: myId, method, params }));
});
const evalJson = async (expr) => {
	const r = await send("Runtime.evaluate", { expression: `JSON.stringify((() => { try { return ${expr}; } catch (e) { return { error: String(e) }; } })())`, returnByValue: true, awaitPromise: false });
	try { return JSON.parse(r.result?.result?.value ?? "null"); } catch { return r.result?.result?.value; }
};
await send("Page.bringToFront");
await sleep(8000);
const peek = "(s) => (s && typeof s.peek === 'function' ? s.peek() : undefined)";
const setup = `(() => { const el = document.querySelector('moq-watch'); const peek = ${peek}; return el ? {
	url: el.getAttribute('url'), name: el.getAttribute('name'), latencyAttr: el.getAttribute('latency'), delayAttr: el.getAttribute('delay'),
	bundle: [...document.scripts].map((s) => s.src).filter(Boolean),
	catalogAudio: el.catalog?.audio, catalogVideo: el.catalog?.video,
	sync: { jitter: peek(el.sync?.out?.jitter), buffer: peek(el.sync?.out?.buffer), delay: peek(el.sync?.out?.delay), maxBuffer: peek(el.sync?.out?.maxBuffer), maxAge: peek(el.sync?.out?.maxAge), latencyIn: peek(el.sync?.in?.latency), delayIn: peek(el.sync?.in?.delay) },
	ajitter: peek(el.audio?.source?.out?.jitter), vjitter: peek(el.video?.out?.jitter), rtt: peek(el.connection?.probe)?.rtt, transport: peek(el.connection?.transport),
	arate: peek(el.audio?.out?.sampleRate), actx: peek(el.audio?.out?.context)?.state, status: peek(el.broadcast?.out?.status),
} : { error: 'no moq-watch element' }; })()`;
const first = await evalJson(setup);
console.log("setup:", JSON.stringify(first, null, 1));
// Try to select the lowest chip the UI offers (Real-time on main, Auto on dev) by property.
const samples = [];
const t0 = Date.now();
while (Date.now() - t0 < SECONDS * 1000) {
	const s = await evalJson(`(() => { const el = document.querySelector('moq-watch'); const peek = ${peek}; const span = (r) => Array.isArray(r) ? r.reduce((a, x) => a + (x.end - x.start) / 1000, 0) : -1; return {
		t: Date.now(), astalled: peek(el.audio?.out?.stalled), abufMs: span(peek(el.audio?.out?.buffered)), abytes: peek(el.audio?.out?.stats)?.bytesReceived,
		vstalled: peek(el.video?.out?.stalled), vframes: peek(el.video?.out?.stats)?.frameCount, rtt: peek(el.connection?.probe)?.rtt,
		jitter: peek(el.sync?.out?.jitter), delay: peek(el.sync?.out?.delay) ?? peek(el.sync?.out?.buffer), ajitter: peek(el.audio?.source?.out?.jitter), catJitter: el.catalog?.audio?.renditions ? Object.values(el.catalog.audio.renditions)[0]?.jitter : el.catalog?.audio?.jitter,
	}; })()`);
	samples.push(s);
	await sleep(250);
}
const stalledPct = (100 * samples.filter((s) => s.astalled).length) / samples.length;
const vfr = samples.map((s) => s.vframes).filter((x) => x !== undefined);
const summary = { url: URL_, first, samples: samples.length, audioStalledPct: Math.round(stalledPct * 10) / 10, fps: vfr.length > 1 ? Math.round(((vfr.at(-1) - vfr[0]) / ((samples.at(-1).t - samples[0].t) / 1000)) * 10) / 10 : null, last: samples.at(-1), abufMsMin: Math.min(...samples.map((s) => s.abufMs)), abufMsP50: [...samples.map((s) => s.abufMs)].sort((a, b) => a - b)[Math.floor(samples.length / 2)] };
console.log("summary:", JSON.stringify(summary, null, 1));
if (args.out) writeFileSync(args.out, JSON.stringify({ summary, samples }, null, 1));
await fetch(`http://127.0.0.1:${CDP}/json/close/${info.id}`);
ws.close();

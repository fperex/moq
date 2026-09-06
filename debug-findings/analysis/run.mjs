// Measurement driver: opens an (optional) harness publisher and one harness watcher per delay
// preset in a CDP-driven Chrome, holding each for --hold seconds. The page-side probes stream
// events to the sink; this only records phase marks (with relay-log byte offsets) and run metadata.
//
// bun run.mjs --tag=e1 --run=<dir> --relay=http://localhost:4444 --vite=5174 --cdp=9224 \
//   --presets=auto,100ms,250ms,500ms,1000ms --hold=90 --publisher=harness|none --name=<broadcast>
import { execSync, spawn } from "node:child_process";
import { openSync } from "node:fs";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";

const args = Object.fromEntries(
	process.argv.slice(2).map((a) => {
		const m = a.match(/^--([^=]+)=(.*)$/);
		return m ? [m[1], m[2]] : [a, true];
	}),
);
const TAG = args.tag ?? `run-${Date.now()}`;
const RUNS = args.runs ?? new URL("../runs", import.meta.url).pathname;
const RUN = `${RUNS}/${TAG}`;
mkdirSync(RUN, { recursive: true });
const RELAY = args.relay ?? "http://localhost:4444";
const VITE = Number(args.vite ?? 5174);
const CDP = Number(args.cdp ?? 9224);
const PRESETS = String(args.presets ?? "auto,100ms,250ms,500ms,1000ms").split(",");
const HOLD = Number(args.hold ?? 90) * 1000;
const PUBLISHER = args.publisher ?? "harness";
const NAME = args.name ?? `rt/${TAG}.hang`;
const RELAY_LOG = args.relayLog ?? `${RUN}/relay.log`;
const RELAY_BIN = args.relayBin; // spawn a fresh relay per run when given (with --relayCwd)
const RELAY_PORT = Number(args.relayPort ?? 4443);
const WATCH_EXTRA = args.watchExtra ?? "";
const PUB_EXTRA = args.pubExtra ?? "";
const FOCUS = args.focus ?? "watch"; // which tab is foreground during the hold: watch | pub
const INJECT = args.inject ? readFileSync(`${import.meta.dir}/blackbox.js`, "utf8") : undefined; // black-box probe
const WATCH_URL = args.watchUrl; // full page URL template for a non-harness page ({preset} substituted)
const SET_LATENCY = args.setLatency; // on a non-harness page, set the legacy `latency` attribute from the preset

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const events = [];
function mark(event, extra = {}) {
	let offset = -1;
	try {
		offset = statSync(RELAY_LOG).size;
	} catch {}
	const e = { e: Date.now(), event, relayLogOffset: offset, ...extra };
	events.push(e);
	console.log(`[mark] ${new Date(e.e).toISOString()} ${event} offset=${offset} ${JSON.stringify(extra)}`);
	writeFileSync(`${RUN}/events.json`, JSON.stringify({ meta, events }, null, 1));
}

async function waitFor(desc, fn, timeoutMs = 45000, everyMs = 250) {
	const t0 = Date.now();
	for (;;) {
		try {
			const v = await fn();
			if (v) return v;
		} catch {}
		if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${desc}`);
		await sleep(everyMs);
	}
}

// ---------- CDP ----------
async function newTab(url) {
	const r = await fetch(`http://127.0.0.1:${CDP}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
	return await r.json();
}
async function listTabs() {
	return await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
}
async function closeTab(id) {
	await fetch(`http://127.0.0.1:${CDP}/json/close/${id}`);
}
class Tab {
	constructor(info) {
		this.info = info;
		this.seq = 0;
		this.pending = new Map();
	}
	async connect() {
		this.ws = new WebSocket(this.info.webSocketDebuggerUrl);
		await new Promise((res, rej) => {
			this.ws.onopen = res;
			this.ws.onerror = rej;
		});
		this.ws.onmessage = (m) => {
			const msg = JSON.parse(m.data);
			if (msg.id && this.pending.has(msg.id)) {
				this.pending.get(msg.id)(msg);
				this.pending.delete(msg.id);
			}
		};
	}
	send(method, params = {}) {
		const id = ++this.seq;
		return new Promise((res, rej) => {
			this.pending.set(id, res);
			this.ws.send(JSON.stringify({ id, method, params }));
			setTimeout(() => {
				if (this.pending.has(id)) {
					this.pending.delete(id);
					rej(new Error(`CDP timeout: ${method}`));
				}
			}, 20000);
		});
	}
	async eval(expr, awaitPromise = false) {
		const r = await this.send("Runtime.evaluate", { expression: expr, awaitPromise, returnByValue: true });
		if (r.result?.exceptionDetails) throw new Error(`page exception: ${JSON.stringify(r.result.exceptionDetails).slice(0, 300)}`);
		return r.result?.result?.value;
	}
	async state() {
		// Pages without the harness (the real site) have no #info: report null, never throw.
		const s = await this.eval("document.getElementById('info')?.textContent ?? ''");
		try {
			return JSON.parse(s || "null");
		} catch {
			return null;
		}
	}
	close() {
		try {
			this.ws.close();
		} catch {}
	}
}

const meta = {
	tag: TAG,
	relay: RELAY,
	name: NAME,
	presets: PRESETS,
	holdMs: HOLD,
	publisher: PUBLISHER,
	worktree: execSync("git rev-parse HEAD", { cwd: process.cwd() }).toString().trim(),
	branch: execSync("git rev-parse --abbrev-ref HEAD", { cwd: process.cwd() }).toString().trim(),
	chrome: await (await fetch(`http://127.0.0.1:${CDP}/json/version`)).json(),
	startedAt: new Date().toISOString(),
};

let relayProc;
let pubProc;
// --publisher=cmd runs --pubCmd through sh once the relay is up (e.g. the native bbb import) and
// kills it at the end. Its output goes to <run>/pub-cmd.log.
function startPubCmd() {
	if (PUBLISHER !== "cmd") return;
	const log = openSync(`${RUN}/pub-cmd.log`, "w");
	pubProc = spawn("sh", ["-c", args.pubCmd], { stdio: ["ignore", log, log], detached: true });
}
function stopPubCmd() {
	if (pubProc) {
		try {
			process.kill(-pubProc.pid, "SIGTERM");
		} catch {}
	}
}
async function startRelay() {
	if (!RELAY_BIN) return;
	const log = openSync(RELAY_LOG, "w");
	relayProc = spawn(RELAY_BIN, ["localhost.toml"], {
		cwd: args.relayCwd,
		stdio: ["ignore", log, log],
		env: { ...process.env, RUST_LOG: args.rustLog ?? "info,moq_net=debug" },
	});
	await waitFor("relay http", async () => (await fetch(`http://localhost:${RELAY_PORT}/certificate.sha256`)).ok, 30000, 500);
	if (args.relayWarm) await sleep(Number(args.relayWarm) * 1000);
}
function stopRelay() {
	if (relayProc) relayProc.kill("SIGTERM");
}

async function main() {
	await startRelay();
	startPubCmd();
	if (PUBLISHER === "cmd") await sleep(Number(args.pubWarm ?? 4) * 1000);
	// Stale-tab trap: every /json/new leaves the old tab running.
	for (const t of await listTabs()) if (t.type === "page" && t.url !== "about:blank") await closeTab(t.id);
	await sleep(500);
	mark("start", { meta });

	let pub;
	if (PUBLISHER === "harness") {
		const url = `http://localhost:${VITE}/harness.html?role=publish&url=${encodeURIComponent(RELAY)}&name=${encodeURIComponent(NAME)}&beacon=${TAG}.pub${PUB_EXTRA}`;
		pub = new Tab(await newTab(url));
		await pub.connect();
		await waitFor("publisher established", async () => typeof (await pub.state())?.transport === "string", 60000);
		mark("publisher-established");
	}

	const seen = new Map();
	for (const preset of PRESETS) {
		const n = (seen.get(preset) ?? 0) + 1;
		seen.set(preset, n);
		const label = n > 1 ? `${preset}-${n}` : preset;
		mark(`watch-open-${label}`, { preset });
		const url = WATCH_URL
			? WATCH_URL.replace("{preset}", preset).replace("{beacon}", `${TAG}.watch-${label}`)
			: `http://localhost:${VITE}/harness.html?role=watch&url=${encodeURIComponent(RELAY)}&name=${encodeURIComponent(NAME)}&delay=${preset}&beacon=${TAG}.watch-${label}${WATCH_EXTRA}`;
		const tab = new Tab(await newTab(url));
		await tab.connect();
		let first;
		try {
			first = await waitFor(
				"watcher live with audio",
				async () => {
					const i = await tab.state();
					if (i) return i.status === "live" && (i.abytes ?? 0) > 0 && i.actx === "running" ? i : null;
					if (!WATCH_URL) return null;
					const s = await tab.eval("(() => { const el = document.querySelector('moq-watch'); const peek = (x) => x && x.peek ? x.peek() : undefined; return el ? JSON.stringify({ status: peek(el.broadcast?.out?.status), abytes: peek(el.audio?.out?.stats)?.bytesReceived, actx: peek(el.audio?.out?.context)?.state }) : null; })()");
					const j = s ? JSON.parse(s) : null;
					return j && j.status === "live" && (j.abytes ?? 0) > 0 && j.actx === "running" ? j : null;
				},
				60000,
			);
		} catch (err) {
			mark(`watch-timeout-${label}`, { preset, last: await tab.state() });
			tab.close();
			await closeTab(tab.info.id);
			continue;
		}
		if (FOCUS === "pub" && pub) await pub.send("Page.bringToFront");
		else await tab.send("Page.bringToFront");
		if (SET_LATENCY) {
			const value = preset === "auto" ? "real-time" : preset.replace(/ms$/, "");
			// Main-lineage builds own `latency` through the UI wrapper; the property the chips use
			// is `latencyMin` (a Time.Milli or "real-time"). Fall back to the attribute elsewhere.
			mark(`set-latency-${label}`, { value, result: await tab.eval(`(() => { const el = document.querySelector('moq-watch'); if (!el) return 'no element'; if ('latencyMin' in el) { el.latencyMin = ${JSON.stringify(value)} === 'real-time' ? 'real-time' : Number(${JSON.stringify(value)}); return 'latencyMin=' + String(el.latencyMin); } el.setAttribute('latency', ${JSON.stringify(value)}); return el.getAttribute('latency'); })()`) });
		}
		if (INJECT) mark(`inject-${label}`, { result: await tab.eval(INJECT) });
		mark(`watch-live-${label}`, { preset, first, focus: FOCUS });
		const t0 = Date.now();
		while (Date.now() - t0 < HOLD) {
			await sleep(10000);
			mark(`watch-hold-${label}`, { preset, info: await tab.state(), bb: INJECT ? await tab.eval("JSON.stringify(window.__bb?.summary())") : undefined });
		}
		mark(`watch-close-${label}`, { preset, last: await tab.state(), bb: INJECT ? await tab.eval("JSON.stringify(window.__bb?.summary())") : undefined });
		tab.close();
		await closeTab(tab.info.id);
		await sleep(3000);
	}
	if (pub) {
		mark("publisher-close", { last: await pub.state() });
		pub.close();
		await closeTab(pub.info.id);
	}
	mark("done");
	stopPubCmd();
	stopRelay();
}

main().catch((err) => {
	mark("error", { error: String(err) });
	stopPubCmd();
	stopRelay();
	console.error(err);
	process.exit(1);
});

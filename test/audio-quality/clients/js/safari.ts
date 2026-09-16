/**
 * Plays one matrix row in real Safari and records what it heard.
 *
 * Safari is the second engine a viewer actually uses, and it is not Playwright's WebKit: different
 * network stack, different media pipeline, different AudioWorklet scheduling. So this row is driven
 * through `safaridriver` over plain W3C WebDriver ([`webdriver.ts`](webdriver.ts)), and the only
 * thing that differs from the Chromium lane below the driver is how the samples travel.
 *
 * Three things follow from the engine, and each one changes what this lane may claim:
 *
 * - **No WebTransport.** `@moq/net` refuses it on every WebKit engine, because WebKit's flow-control
 *   window never refills (quest/m0/webkit-webtransport-gate.md). The page keeps its WebSocket for
 *   this lane (`?fallback=1`) and the session is TCP.
 * - **No shaper, therefore.** A TCP session never traverses the UDP shaper, so there is no
 *   impairment to apply and none to claim. The row runs against the relay directly and records
 *   `shaper: none`; `run.sh` refuses every profile but the two controls for this runtime rather than
 *   labelling an unimpaired run `bursty`.
 * - **No autoplay flag.** Safari starts an `AudioContext` on a real user activation and nothing
 *   else, so the row opens with an Element Click on the page's start button.
 *
 * There is also no sink: the driver drains the page's probe on the same 250 ms grid through
 * `execute/sync` and writes the ndjson itself, in the beacon's shape, so `analyze.ts` reads it
 * without knowing which lane produced it.
 *
 *     bun safari.ts --url http://127.0.0.1:4443 --broadcast bbb-opus.hang --page dist \
 *         --delay auto --duration 40 --tag safari-opus-48000-near-zero-plain \
 *         --driver-port 4545 --out <run dir>
 *
 * @module
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { serve } from "../../../smoke/clients/js/harness.ts";
import { type Beacon, type Environment, type Ring, SAMPLE_INTERVAL_MS, type Sample, type Void } from "./src/schema.ts";
import { WebDriver } from "./webdriver.ts";

const { values } = parseArgs({
	options: {
		url: { type: "string" },
		broadcast: { type: "string" },
		page: { type: "string" },
		delay: { type: "string", default: "auto" },
		duration: { type: "string", default: "60" },
		tag: { type: "string" },
		out: { type: "string" },
		ring: { type: "string", default: "plain" },
		port: { type: "string", default: "0" },
		"driver-port": { type: "string" },
		binary: { type: "string", default: "/System/Cryptexes/App/usr/bin/safaridriver" },
	},
});

const durationSec = Number.parseFloat(values.duration);
const driverPort = Number.parseInt(values["driver-port"] ?? "", 10);
if (!values.url || !values.broadcast || !values.page || !values.tag || !values.out) {
	console.error(
		"usage: safari.ts --url U --broadcast B --page DIR --tag T --out DIR --driver-port N [--delay auto] [--duration 60] [--ring plain|isolated]",
	);
	process.exit(2);
}
if (!Number.isFinite(durationSec) || durationSec <= 0) {
	console.error(`error: --duration must be a positive number (got '${values.duration}')`);
	process.exit(2);
}
if (!Number.isInteger(driverPort) || driverPort <= 0) {
	console.error(`error: --driver-port must be a port number (got '${values["driver-port"]}')`);
	process.exit(2);
}
const ring = values.ring as Ring;
if (ring !== "plain" && ring !== "isolated") {
	console.error(`error: --ring must be plain or isolated (got '${values.ring}')`);
	process.exit(2);
}

const out = resolve(values.out);
mkdirSync(out, { recursive: true });
const ndjson = join(out, `${values.tag}.ndjson`);

/** The same build under both prefixes, so one server covers both rings. See `driver.ts`. */
const server = serve({
	root: resolve(values.page),
	port: Number.parseInt(values.port, 10),
	routes: [
		{
			prefix: "/isolated",
			headers: {
				"cross-origin-opener-policy": "same-origin",
				"cross-origin-embedder-policy": "require-corp",
			},
		},
		{ prefix: "/plain", headers: {} },
	],
});

const query = new URLSearchParams({
	url: values.url,
	broadcast: values.broadcast,
	delay: values.delay,
	tag: values.tag,
	// The page keeps its WebSocket only when asked, and this lane is the only thing that asks.
	fallback: "1",
});
const pageUrl = `${server.origin}/${ring}/?${query}`;
console.log(`endpoint: page ${pageUrl}`);

/** What the page publishes about itself, read off the DOM. The same shape `driver.ts` reads. */
type Status = {
	crossOriginIsolated: boolean;
	transport?: string;
	timestamp?: number;
	stalled?: boolean;
	underruns?: number;
	resolved?: number;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const voids: Void[] = [];
/** Whether the environment has been written to the ndjson yet; it goes in once. */
let sentEnvironment = false;
const note = (assertion: string, detail: string) => {
	console.error(`void: ${assertion}: ${detail}`);
	voids.push({ assertion, detail });
};

// Outside the try below only so the helpers can name it; a driver that never starts is a row that
// never ran, and it is reported as a void rather than as an unhandled rejection with a live server
// still bound behind it.
const driver = await WebDriver.start(values.binary, driverPort, join(out, `${values.tag}.safaridriver.log`)).catch(
	async (err: unknown) => {
		const message = err instanceof Error ? err.message : String(err);
		console.error(`FAIL ${values.tag}: ${message}`);
		note("driver", message);
		server.stop();
		// The same void file every other failure writes. Rethrowing here left the row with no
		// `.voids.json` at all, so a driver that never started read downstream as a row that was
		// never asked for rather than one that failed.
		await Bun.write(join(out, `${values.tag}.voids.json`), JSON.stringify(voids, null, 1));
		process.exit(1);
	},
);

let status = 0;
try {
	await driver.newSession();
	await driver.navigate(pageUrl);
	await frontmost();

	// The catalog is what says the session is up; without it there is nothing to measure and the
	// failure is the relay or the publisher, not the player.
	const deadline = Date.now() + 30_000;
	let ready: Status | undefined;
	while (Date.now() < deadline) {
		ready = await readStatus();
		if (ready?.transport) break;
		await sleep(200);
	}
	if (!ready?.transport) throw new Error(`session: no catalog within 30s: ${JSON.stringify(ready)}`);

	// The user activation. Safari keeps an AudioContext suspended without one, and a click
	// synthesized from `execute` is not one: it has to come from the driver.
	//
	// Clicked until the context is running rather than once, because the listener that resumes it is
	// armed when the context is built, which is when the first audio track is wired up: a single
	// click before that lands on nothing, and the row plays silence for a minute with every other
	// counter looking healthy. One click a second, and the state it is waiting for is the context's
	// own, not the button's.
	const start = await driver.findElement("#start");
	const activateBy = Date.now() + 30_000;
	let state = await readAudioState();
	while (state !== "running" && Date.now() < activateBy) {
		await frontmost();
		await driver.click(start);
		await sleep(500);
		state = await readAudioState();
	}
	const focused = await driver.execute<boolean>("return document.hasFocus();");
	console.log(`activation: AudioContext is ${state ?? "absent"}, document focus ${focused}`);
	if (!focused) {
		note("focus", "Safari is not the frontmost application, so no click reaches the page and no audio renders");
	}
	if (state !== "running") {
		note("activation", `the AudioContext is ${state ?? "absent"} after 30s of clicking the start button`);
	}

	// WebKit has no WebTransport this lane can use, so a row that somehow negotiated one measured a
	// different path from the one this lane describes. Named for what it is rather than passed
	// quietly: nothing else here would notice.
	if (ready.transport !== "websocket") {
		note("transport", `negotiated ${ready.transport}, and this lane is the WebSocket one`);
	}
	if (ready.crossOriginIsolated !== (ring === "isolated")) {
		note("ring", `asked for ${ring}, page reports crossOriginIsolated=${ready.crossOriginIsolated}`);
	}

	// Wait for the ring to actually be playing before the clock window opens: an AudioContext that
	// is still starting has a `currentTime` behind wall time, and measuring across the start reads
	// as a several-percent drift on a healthy run. See `driver.ts`.
	const playingBy = Date.now() + 30_000;
	while (Date.now() < playingBy) {
		const playing = await readStatus();
		if (playing && playing.stalled === false && typeof playing.timestamp === "number") break;
		await collect();
		await sleep(200);
	}

	const before = await readClock();
	const clockWindow = Date.now() + 10_000;
	while (Date.now() < clockWindow) {
		await collect();
		await sleep(SAMPLE_INTERVAL_MS);
	}
	const after = await readClock();
	if (before.audio !== null && after.audio !== null) {
		const wall = after.wall - before.wall;
		const media = after.audio - before.audio;
		const error = Math.abs(media - wall) / wall;
		console.log(
			`clock: audio advanced ${media.toFixed(1)}ms over ${wall.toFixed(1)}ms wall (${(100 * error).toFixed(2)}%)`,
		);
		if (error > 0.01)
			note("clock", `AudioContext.currentTime drifted ${(100 * error).toFixed(2)}% from wall clock over 10s`);
	} else {
		note("clock", "AudioContext.currentTime was never readable");
	}

	const until = Date.now() + Math.max(0, durationSec * 1000 - 10_000);
	while (Date.now() < until) {
		await collect();
		await sleep(SAMPLE_INTERVAL_MS);
	}

	const final = await readStatus();
	console.log(`final: ${JSON.stringify(final)}`);
	await collect(true);
} catch (err) {
	const message = err instanceof Error ? err.message : String(err);
	console.error(`FAIL ${values.tag}: ${message}`);
	note("driver", message);
	status = 1;
} finally {
	await driver.quit().catch(() => {});
	server.stop();
}

await Bun.write(join(out, `${values.tag}.voids.json`), JSON.stringify(voids, null, 1));

// The shaper's slot in the row, filled in with what actually happened rather than left empty: this
// lane runs on TCP, so the UDP shaper is not in the path at all and every counter is zero because
// nothing was offered to it. `analyze.ts` reads this the way it reads a real report.
await Bun.write(
	join(out, `shaper-${values.tag}.json`),
	JSON.stringify(
		{
			profile: "none",
			seed: 0,
			up: { delivered: 0, dropped: 0, delayed: 0, reordered: 0, rate_limited: 0, queue_max: 0 },
			down: { delivered: 0, dropped: 0, delayed: 0, reordered: 0, rate_limited: 0, queue_max: 0 },
		},
		null,
		1,
	),
);

process.exit(status);

/** Read the page's status block, which is a JSON document in a `<pre>`. */
async function readStatus(): Promise<Status | undefined> {
	const text = await driver.execute<string | null>(
		'return document.getElementById("status") ? document.getElementById("status").textContent : null;',
	);
	if (!text) return undefined;
	try {
		return JSON.parse(text) as Status;
	} catch {
		return undefined;
	}
}

/**
 * Bring Safari to the front, which is what makes this lane work at all.
 *
 * Measured: with the window unfocused, `document.hasFocus()` is false, an Element Click and a
 * WebDriver Actions sequence both answer `{"value":null}`, and neither delivers a `pointerdown`. The
 * page's own counters stay at zero and the AudioContext sits in WebKit's `interrupted` state, so the
 * row records a full minute of plausible counters and total silence. Focused, the same click lands,
 * the context reaches `running` and `currentTime` advances.
 *
 * `open -a` rather than AppleScript: it needs no Automation permission, so nothing prompts and there
 * is no manual step. It moves the frontmost application on the desktop, which is why the lane is
 * local and serial, and why it is not in CI.
 */
async function frontmost(): Promise<void> {
	await Bun.spawn(["/usr/bin/open", "-a", "Safari"], { stdout: "ignore", stderr: "ignore" }).exited;
	await sleep(500);
}

/** The AudioContext's own state, or null while there is no context yet. Safari adds "interrupted". */
async function readAudioState(): Promise<string | null> {
	return await driver.execute<string | null>(`
		var watch = document.querySelector("moq-watch");
		try { return watch.audio.out.context.peek().state; } catch (err) { return null; }
	`);
}

/** Wall time and `AudioContext.currentTime` in one round trip, so they cannot drift apart between. */
async function readClock(): Promise<{ wall: number; audio: number | null }> {
	const text = await driver.execute<string>(`
		var watch = document.querySelector("moq-watch");
		var context = null;
		try { context = watch.audio.out.context.peek(); } catch (err) { context = null; }
		return JSON.stringify({ wall: performance.now(), audio: context ? context.currentTime * 1000 : null });
	`);
	return JSON.parse(text) as { wall: number; audio: number | null };
}

/**
 * Drain the page's probe into the ndjson, in the beacon's shape.
 *
 * Stringified in the page rather than returned as an object: `stats` is whatever the build happens
 * to publish, and handing an arbitrary object graph to WebDriver's own serialiser would make what
 * reaches the file depend on the driver rather than on the page.
 */
async function collect(final = false): Promise<void> {
	const text = await driver.execute<string>(`
		var probe = window.moqAudioQuality;
		if (!probe) return JSON.stringify({ samples: [] });
		return JSON.stringify({
			tag: probe.tag,
			environment: probe.environment() || undefined,
			samples: probe.drain(),
			notes: ${final ? "probe.notes()" : "undefined"},
		});
	`);

	const drained = JSON.parse(text) as { samples?: Sample[]; environment?: Environment; notes?: string[] };

	// Once, the way the beacon sends it, so the file is samples rather than a copy of the
	// environment every quarter second.
	const environment = sentEnvironment ? undefined : drained.environment;
	if (environment) sentEnvironment = true;

	const batch: Beacon = {
		tag: values.tag as string,
		environment,
		samples: drained.samples ?? [],
		notes: drained.notes,
	};
	if (!final && batch.samples.length === 0 && !environment) return;
	appendFileSync(ndjson, `${JSON.stringify(batch)}\n`);
}

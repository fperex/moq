/**
 * Plays one matrix row in headless Chromium and records what it heard.
 *
 * One row is one page, opened for `--duration` seconds against a relay reached through the shaper.
 * The driver's own job is small: stand the page up, wait for it to actually be playing, let it run,
 * and then decide whether what it measured is allowed to count. That last part is the point. A row
 * that ran on the WebSocket fallback never went through the UDP shaper, and a row whose document was
 * not isolated the way the matrix asked for ran the other ring; both would otherwise pass quietly
 * against a budget written for something else, which is worse than failing.
 *
 *     bun driver.ts --url http://127.0.0.1:4499 --broadcast bbb.hang --page dist \
 *         --delay auto --duration 60 --tag chromium-opus-48000-mild-plain \
 *         --sink http://127.0.0.1:5001/log --out <run dir>
 *
 * @module
 */
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Page } from "playwright";
import { Failure, launch, open, saveTrace, serve } from "../../../interop/clients/js/harness.ts";
import { type Ring, type Thread, threadVoid, type Void } from "./src/schema.ts";

const { values } = parseArgs({
	options: {
		url: { type: "string" },
		broadcast: { type: "string" },
		page: { type: "string" },
		delay: { type: "string", default: "auto" },
		duration: { type: "string", default: "60" },
		tag: { type: "string" },
		sink: { type: "string" },
		out: { type: "string" },
		ring: { type: "string", default: "plain" },
		port: { type: "string", default: "0" },
	},
});

const durationSec = Number.parseFloat(values.duration);
if (!values.url || !values.broadcast || !values.page || !values.tag || !values.out) {
	console.error(
		"usage: driver.ts --url U --broadcast B --page DIR --tag T --out DIR [--delay auto] [--duration 60] [--sink URL] [--ring plain|isolated]",
	);
	process.exit(2);
}
if (!Number.isFinite(durationSec) || durationSec <= 0) {
	console.error(`error: --duration must be a positive number (got '${values.duration}')`);
	process.exit(2);
}
const ring = values.ring as Ring;
if (ring !== "plain" && ring !== "isolated") {
	console.error(`error: --ring must be plain or isolated (got '${values.ring}')`);
	process.exit(2);
}

const out = resolve(values.out);
mkdirSync(out, { recursive: true });

/**
 * The two prefixes the same build is served under.
 *
 * Cross-origin isolation is a property of the document, not of the bundle, so one build served twice
 * is all it takes to run both rings. `/plain` is the production path: most viewers are not isolated,
 * and the postMessage ring is what they get.
 */
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
});
if (values.sink) query.set("sink", values.sink);
const pageUrl = `${server.origin}/${ring}/?${query}`;
console.log(`endpoint: page ${pageUrl}`);

/** What the page publishes about itself, read off the DOM rather than out of the sink. */
type Status = {
	crossOriginIsolated: boolean;
	transport?: string;
	thread?: Thread;
	timestamp?: number;
	stalled?: boolean;
	underruns?: number;
	resolved?: number;
};

const readStatus = async (page: Page): Promise<Status | undefined> => {
	const text = await page.evaluate(() => document.getElementById("status")?.textContent ?? undefined);
	if (!text) return undefined;
	try {
		return JSON.parse(text) as Status;
	} catch {
		return undefined;
	}
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const voids: Void[] = [];
const note = (assertion: string, detail: string) => {
	console.error(`void: ${assertion}: ${detail}`);
	voids.push({ assertion, detail });
};

// The audio's own path, which the page's transport cannot show: the page hands its audio to a worker whose
// session is a second one, and takes it back for good when the worker cannot play it. So it is checked
// once the audio plays and again at the end.
const checkThread = (status: Status | undefined) => {
	const found = threadVoid(status?.thread, "webtransport");
	if (found && !voids.some((v) => v.assertion === found.assertion && v.detail === found.detail)) {
		note(found.assertion, found.detail);
	}
};

// --autoplay-policy so an AudioContext starts without a click; the page still offers the button for
// a human. No fake devices: nothing here captures, and a fake one would only add a clock.
const browser = await launch(["--autoplay-policy=no-user-gesture-required"]);

let status = 0;
let page: Page | undefined;
try {
	[page] = await open(browser, pageUrl, values.tag, true);

	// The catalog is what says the session is up; without it there is nothing to measure and the
	// failure is the relay or the publisher, not the player.
	const deadline = Date.now() + 30_000;
	let ready: Status | undefined;
	while (Date.now() < deadline) {
		ready = await readStatus(page);
		if (ready?.transport) break;
		await sleep(200);
	}
	if (!ready?.transport) throw new Failure("session", `no catalog within 30s: ${JSON.stringify(ready)}`);

	// Both of these decide whether the row counts, and both are knowable now rather than after a
	// minute of playing, so they are checked before the clock starts.
	if (ready.transport !== "webtransport") {
		note("transport", `negotiated ${ready.transport}, which does not traverse the UDP shaper`);
	}
	if (ready.crossOriginIsolated !== (ring === "isolated")) {
		note("ring", `asked for ${ring}, page reports crossOriginIsolated=${ready.crossOriginIsolated}`);
	}

	// The device clock has to be real. A headless run that was throttled, or one whose AudioContext
	// never actually rendered, still produces a full set of plausible counters: `currentTime` simply
	// stops advancing, every quantum-based number goes quiet, and the row reads as flawless. One
	// percent over ten seconds is far looser than any real drift and far tighter than a stall.
	//
	// The window starts once the ring is actually playing, not once the catalog arrived. An
	// AudioContext that is still starting has a `currentTime` that has not caught up with wall time
	// yet, and measuring across that start reads as a several-percent drift on a perfectly healthy
	// run: the first ten seconds of playback is the claim, not the first ten seconds of the page.
	const playingBy = Date.now() + 30_000;
	while (Date.now() < playingBy) {
		const state = await readStatus(page);
		if (state && state.stalled === false && typeof state.timestamp === "number") break;
		await sleep(200);
	}
	const playing = await readStatus(page);
	console.log(`thread: ${JSON.stringify(playing?.thread ?? null)}`);
	checkThread(playing);

	const clock0 = await page.evaluate(() => performance.now());
	const audio0 = await contextTime(page);
	await sleep(10_000);
	const clock1 = await page.evaluate(() => performance.now());
	const audio1 = await contextTime(page);
	if (audio0 !== undefined && audio1 !== undefined) {
		const wall = clock1 - clock0;
		const media = audio1 - audio0;
		const error = Math.abs(media - wall) / wall;
		console.log(
			`clock: audio advanced ${media.toFixed(1)}ms over ${wall.toFixed(1)}ms wall (${(100 * error).toFixed(2)}%)`,
		);
		if (error > 0.01)
			note("clock", `AudioContext.currentTime drifted ${(100 * error).toFixed(2)}% from wall clock over 10s`);
	} else {
		note("clock", "AudioContext.currentTime was never readable");
	}

	const remaining = durationSec * 1000 - 10_000;
	if (remaining > 0) await sleep(remaining);

	const final = await readStatus(page);
	console.log(`final: ${JSON.stringify(final)}`);
	checkThread(final);

	// Closing the page is what fires `pagehide`, which is what flushes the last batch. Without this
	// the run's final seconds are the ones that never arrive.
	await page.close();
	await sleep(500);
} catch (err) {
	const message = err instanceof Error ? err.message : String(err);
	console.error(`FAIL ${values.tag}: ${message}`);
	if (page) await saveTrace(page, join(out, `${values.tag}.trace.zip`));
	note("driver", message);
	status = 1;
} finally {
	await browser.close().catch(() => {});
	server.stop();
}

await Bun.write(join(out, `${values.tag}.voids.json`), JSON.stringify(voids, null, 1));
process.exit(status);

/** `AudioContext.currentTime` in ms, from the most recent sample the page took. */
async function contextTime(p: Page): Promise<number | undefined> {
	return await p.evaluate(() => {
		const context = (
			document.querySelector("moq-watch") as {
				audio?: { out?: { context?: { peek(): AudioContext | undefined } } };
			} | null
		)?.audio?.out?.context?.peek();
		return context ? context.currentTime * 1000 : undefined;
	});
}

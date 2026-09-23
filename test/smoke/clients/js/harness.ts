/**
 * Shared Playwright plumbing for the browser clients: serve the built page, launch Chromium, and
 * read back the state each role mirrors onto the DOM.
 *
 * Used by `driver.ts` (the interop matrix) and `media.ts` (the media-output and lifecycle checks).
 *
 * @module
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import { CONTROL, type FixtureState, type Resources, type Sample, type SmokeControl } from "./src/contract";

/**
 * A failed check, named after the property it was measuring.
 *
 * The name is the contract a negative control matches on: injecting a defect has to break the
 * assertion that claims to cover it, not some unrelated wait further down.
 */
export class Failure extends Error {
	readonly assertion: string;

	constructor(assertion: string, detail: string) {
		super(`${assertion}: ${detail}`);
		this.name = "Failure";
		this.assertion = assertion;
	}
}

/** Throw a named {@link Failure} unless `ok`. The detail is only built when it fails. */
export function check(ok: boolean, assertion: string, detail: () => string): void {
	if (!ok) throw new Failure(assertion, detail());
}

/** The page's own measurements plus the player chrome, which lives in a shadow root. */
export type PlayerState = Sample & {
	/** `aria-label` of the primary control button: "Pause" while playing, "Play" while paused. */
	controlLabel?: string;
	/** Whether the big center play button is showing. */
	centerPlayVisible: boolean;
};

/** Errors the page reported, collected so any wait can fail on them instead of timing out. */
export type BrowserErrors = {
	page: string[];
	console: string[];
};

/** Keep the UI contract in one place so player markup changes fail clearly. */
export const SELECTORS = {
	watch: "moq-watch",
	ui: "moq-watch-ui",
	control: "button.control[aria-label]",
	pauseControl: 'button.control[aria-label="Pause"]',
	centerPlay: "button.center-play",
	fixture: "#fixture",
} as const;

/** How often a wait re-reads the page. */
export const POLL_INTERVAL_MS = 100;

/** Sleep for `ms`. */
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A path prefix served with extra response headers.
 *
 * The prefix is stripped before the file lookup, so the same built page is reachable under several
 * of them. That is how one build gets served both cross-origin isolated and not: the headers decide
 * which ring the page can use, and serving them from two prefixes lets one run exercise both without
 * rebuilding or restarting anything.
 */
export type Route = {
	/** Path prefix to match, without a trailing slash: `/isolated`. */
	prefix: string;
	/** Headers added to every response under the prefix. */
	headers: Record<string, string>;
};

/** Where to serve from, on what port, and under which prefixes. */
export type ServeProps = {
	/** Directory of the built page. Defaults to this file's own `dist`, which is the smoke client's. */
	root?: string;
	/** Port to bind. Defaults to 0, an OS-assigned one. */
	port?: number;
	/** Prefixes served with extra headers. Matched longest first; anything else is served plain. */
	routes?: Route[];
};

/**
 * Serve the prebuilt page on localhost, a secure context so WebTransport and WebCodecs are enabled.
 *
 * The no-argument call serves the smoke client's own build with no extra headers, which is what its
 * two drivers want.
 */
export function serve(props: ServeProps = {}): { origin: string; stop: () => void } {
	const root = props.root ?? join(new URL(".", import.meta.url).pathname, "dist");
	const ordered = [...(props.routes ?? [])].sort((a, b) => b.prefix.length - a.prefix.length);
	const server = Bun.serve({
		port: props.port ?? 0,
		async fetch(req) {
			let path = new URL(req.url).pathname;
			const route = ordered.find((r) => path === r.prefix || path.startsWith(`${r.prefix}/`));
			if (route) path = path.slice(route.prefix.length);
			if (path === "" || path === "/") path = "/index.html";
			const headers = route?.headers;
			const file = Bun.file(join(root, path));
			if (await file.exists()) return new Response(file, { headers });
			return new Response(Bun.file(join(root, "index.html")), { headers }); // SPA fallback
		},
	});
	return { origin: `http://localhost:${server.port}`, stop: () => server.stop(true) };
}

/** Build a page URL for a role, with everything after `role` passed through as query parameters. */
export function pageUrl(origin: string, role: string, params: Record<string, string>): string {
	const query = new URLSearchParams({ role, ...params });
	return `${origin}/?${query}`;
}

/**
 * Launch headless Chromium.
 *
 * The "chromium" channel is full Chromium (new headless); the headless shell lacks WebTransport and
 * WebCodecs. `args` is empty by default: the media checks deliberately run without the fake-device
 * and autoplay overrides, so those belong to the caller that needs them.
 */
export function launch(args: string[] = []): Promise<Browser> {
	return chromium.launch({ channel: "chromium", headless: true, args });
}

/** Contexts tracing this process, saved by {@link finishTraces} when the run fails. */
const traces: Array<{ context: BrowserContext; name: string }> = [];

/**
 * Start a Playwright trace on the page's context, before it navigates.
 *
 * A no-op outside a harness run: without `MOQ_TEST_RUN` there is no directory to write to, and a
 * trace only survives a failure anyway. See {@link finishTraces}.
 */
export async function startTrace(page: Page, name: string): Promise<void> {
	if (!process.env.MOQ_TEST_RUN) return;
	await page.context().tracing.start({ screenshots: true, snapshots: true });
	traces.push({ context: page.context(), name: `${name}-${randomUUID()}` });
}

/** Save a trace per started context into the run directory when `failed`, and discard it otherwise. */
export async function finishTraces(failed: boolean): Promise<void> {
	const run = process.env.MOQ_TEST_RUN;
	for (const { context, name } of traces) {
		try {
			// `path` is what writes the trace; without it, stop only frees the buffers.
			if (run && failed) await context.tracing.stop({ path: join(run, `${name}.trace.zip`) });
			else await context.tracing.stop();
		} catch {
			// A trace is evidence, never the verdict: a broken context must not mask the failure.
		}
	}
	traces.length = 0;
}

/** Open a page and start collecting its errors, echoing everything it logs.
 *
 * `trace` starts a Playwright trace before the navigation, so a failed run can save it with
 * {@link finishTraces}. The caller decides which pages are worth tracing: a page that streams for
 * the whole run holds its trace in memory, so it is not one.
 */
export async function open(
	browser: Browser,
	url: string,
	label = "page",
	trace = false,
): Promise<[Page, BrowserErrors]> {
	const page = await browser.newPage();
	const errors: BrowserErrors = { page: [], console: [] };
	page.on("console", (message) => {
		console.error(`[${label}] ${message.text()}`);
		if (message.type() === "error") errors.console.push(message.text());
	});
	page.on("pageerror", (error) => {
		console.error(`[${label} error] ${error.message}`);
		errors.page.push(error.message);
	});
	if (trace) await startTrace(page, label);
	await page.goto(url, { waitUntil: "load" });
	return [page, errors];
}

/**
 * Write the trace of a page opened with `trace` to `file`, and say where it went.
 *
 * For a driver that names its own trace rather than leaving it to {@link finishTraces}. Only worth
 * calling on the way out of a failure: a trace is large, and a passing run's is noise. Never throws,
 * because it runs from a failure path and the failure is the thing worth reporting.
 */
export async function saveTrace(page: Page, file: string): Promise<void> {
	try {
		await page.context().tracing.stop({ path: file });
		console.error(`trace: ${file}`);
		console.error(`view it with: bunx playwright show-trace ${file}`);
	} catch (err) {
		console.error(`trace: not saved (${err instanceof Error ? err.message : String(err)})`);
	}
}

/** Throw everything the page has reported so far, if anything. */
export function throwPageErrors(errors: BrowserErrors): void {
	const messages = [
		...errors.page.map((error) => `page: ${error}`),
		...errors.console.map((error) => `console: ${error}`),
	];
	if (messages.length > 0) throw new Error(messages.join("\n"));
}

/** Wait until the player element exists and has published its first sample. */
export async function waitForWatch(page: Page): Promise<void> {
	await page.evaluate((tag) => customElements.whenDefined(tag), SELECTORS.watch);
	await page.locator(`${SELECTORS.watch}[data-smoke-ready]`).waitFor({ state: "attached" });
}

/** Read one sample plus the player chrome. Throws until the page has sampled at least once. */
export async function readPlayerState(page: Page): Promise<PlayerState> {
	const state = await page.evaluate((selectors) => {
		const watch = document.querySelector<HTMLElement>(selectors.watch);
		const ui = document.querySelector(selectors.ui);
		const control = ui?.shadowRoot?.querySelector<HTMLButtonElement>(selectors.control);
		const centerPlay = ui?.shadowRoot?.querySelector<HTMLButtonElement>(selectors.centerPlay);

		return {
			sample: watch?.dataset.smokeState,
			controlLabel: control?.getAttribute("aria-label") ?? undefined,
			centerPlayVisible: centerPlay ? getComputedStyle(centerPlay).display !== "none" : false,
		};
	}, SELECTORS);

	if (!state.sample) throw new Error("the player has not published a sample");
	return {
		...(JSON.parse(state.sample) as Sample),
		controlLabel: state.controlLabel,
		centerPlayVisible: state.centerPlayVisible,
	};
}

/** Read what the fixture publisher says about itself. Throws until it has published anything. */
export async function readFixtureState(page: Page): Promise<FixtureState> {
	const state = await page.evaluate(
		(selector) => document.querySelector<HTMLElement>(selector)?.dataset.smokeFixture,
		SELECTORS.fixture,
	);
	if (!state) throw new Error("the fixture publisher has not published its state");
	return JSON.parse(state) as FixtureState;
}

/** Invoke one of the page's {@link SmokeControl} commands. */
export async function command(page: Page, name: keyof SmokeControl): Promise<void> {
	await page.evaluate(
		([key, fn]) => {
			const control = (window as unknown as Record<string, Record<string, () => void> | undefined>)[key];
			if (!control?.[fn]) throw new Error(`the page exposes no ${fn} command`);
			control[fn]();
		},
		[CONTROL, name] as const,
	);
}

/** Read the page's live resource counts, which outlive the player element. */
export async function readResources(page: Page): Promise<Resources> {
	const state = await page.evaluate(() => document.body.dataset.smokeResources);
	if (!state) throw new Error("the page has not published resource counts");
	return JSON.parse(state) as Resources;
}

/** What to wait for: a predicate over the page state, plus what to say when it never happens. */
export type WaitProps<T> = {
	deadline: number;
	description: string;
	predicate: (state: T) => boolean;
	/** Assertion name for the timeout, when the wait itself is the check. Defaults to "timeout". */
	assertion?: string;
};

/** Poll `read` until `predicate` holds, the deadline passes, or the page reports an error. */
export async function waitFor<T>(
	page: Page,
	errors: BrowserErrors,
	read: (page: Page) => Promise<T>,
	props: WaitProps<T>,
): Promise<T> {
	let last: T | undefined;
	while (Date.now() < props.deadline) {
		throwPageErrors(errors);
		// The page may not have sampled yet; that is indistinguishable from "not there yet" and the
		// deadline is what decides, so keep polling rather than failing on the first read.
		last = await read(page).catch(() => undefined);
		if (last !== undefined && props.predicate(last)) return last;
		await sleep(POLL_INTERVAL_MS);
	}
	throwPageErrors(errors);
	throw new Failure(props.assertion ?? "timeout", `waiting for ${props.description}: ${JSON.stringify(last)}`);
}

/** Poll the player until `predicate` holds. See {@link waitFor}. */
export function waitForState(page: Page, errors: BrowserErrors, props: WaitProps<PlayerState>): Promise<PlayerState> {
	return waitFor(page, errors, readPlayerState, props);
}

/** Poll the fixture publisher until `predicate` holds. See {@link waitFor}. */
export function waitForFixture(
	page: Page,
	errors: BrowserErrors,
	props: WaitProps<FixtureState>,
): Promise<FixtureState> {
	return waitFor(page, errors, readFixtureState, props);
}

/** Poll the page's resource counts until `predicate` holds. See {@link waitFor}. */
export function waitForResources(page: Page, errors: BrowserErrors, props: WaitProps<Resources>): Promise<Resources> {
	return waitFor(page, errors, readResources, props);
}

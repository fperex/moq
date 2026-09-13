/**
 * A W3C WebDriver client, with no dependencies, for the one browser Playwright cannot drive.
 *
 * Playwright's WebKit is a build of WebKit, not Safari: it ships its own network stack, its own
 * media pipeline, and its own AudioWorklet scheduling. Grading it would say something about WebKit
 * and nothing about what a viewer on macOS hears. `safaridriver` drives the real thing, and it
 * speaks plain W3C WebDriver over HTTP, so the whole client is the seven calls below.
 *
 * The one thing that matters beyond transport: an Element Click is a real user activation. Safari
 * refuses to start an `AudioContext` without one, and no amount of autoplay flags substitutes,
 * which is why `driver.ts`'s `--autoplay-policy` approach has no Safari equivalent.
 *
 *     const driver = await WebDriver.start("/usr/bin/safaridriver", 4545);
 *     await driver.newSession();
 *     await driver.navigate(url);
 *     await driver.click(await driver.findElement("#start"));
 *     const status = await driver.execute<string>("return document.title");
 *     await driver.quit();
 *
 * @module
 */

/** A WebDriver command that came back as an error, named by the error code the spec defines. */
export class WebDriverError extends Error {
	/** The spec's error code, such as `no such element` or `javascript error`. */
	readonly code: string;

	constructor(code: string, message: string) {
		super(`${code}: ${message}`);
		this.name = "WebDriverError";
		this.code = code;
	}
}

/** The key a web element is wrapped in on the wire, fixed by the specification. */
const ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf";

/** How long any one command may take before it is reported as a hang rather than waited on. */
const COMMAND_TIMEOUT_MS = 30_000;

/** A running `safaridriver` and, once {@link WebDriver.newSession} is called, one session on it. */
export class WebDriver {
	/** Where the driver process is listening. */
	readonly origin: string;

	readonly #process: Bun.Subprocess;
	#session?: string;

	private constructor(origin: string, process: Bun.Subprocess) {
		this.origin = origin;
		this.#process = process;
	}

	/**
	 * Spawn `binary` on `port` and wait for it to answer, so a caller never races the first command.
	 *
	 * The process is spawned as a child of this one, which is what puts it in the process group
	 * `harness_spawn` gave this script: the harness reaps the group, so a driver that outlives a
	 * cancelled run is impossible without anything here tracking it.
	 */
	static async start(binary: string, port: number, log?: string): Promise<WebDriver> {
		const output = log ? Bun.file(log) : "inherit";
		const process = Bun.spawn([binary, "-p", String(port)], {
			stdin: "ignore",
			stdout: output,
			stderr: output,
		});

		const origin = `http://127.0.0.1:${port}`;
		const deadline = Date.now() + 20_000;
		for (;;) {
			if (process.exitCode !== null) {
				throw new Error(`${binary} exited with ${process.exitCode} before it was ready`);
			}
			try {
				const status = (await request(origin, "GET", "/status")) as { ready?: boolean };
				if (status.ready !== false) break;
			} catch {
				// Not listening yet. The deadline below is what decides, not the first refusal.
			}
			if (Date.now() > deadline) {
				process.kill();
				throw new Error(`${binary} never answered /status on ${origin} within 20s`);
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		return new WebDriver(origin, process);
	}

	/** Open a session. Safari hosts one at a time, which is why the matrix runs its rows serially. */
	async newSession(): Promise<string> {
		const value = (await request(this.origin, "POST", "/session", {
			capabilities: { alwaysMatch: { browserName: "safari" } },
		})) as { sessionId: string };
		this.#session = value.sessionId;
		return value.sessionId;
	}

	/** Navigate the session's window, returning once the document has loaded. */
	async navigate(url: string): Promise<void> {
		await this.#command("POST", "/url", { url });
	}

	/** The first element matching `selector`, as the opaque id every element command takes. */
	async findElement(selector: string): Promise<string> {
		const value = (await this.#command("POST", "/element", {
			using: "css selector",
			value: selector,
		})) as Record<string, string>;
		const element = value[ELEMENT_KEY];
		if (!element) throw new WebDriverError("no such element", `${selector} returned ${JSON.stringify(value)}`);
		return element;
	}

	/**
	 * Click an element found by {@link findElement}.
	 *
	 * This is the user activation. A synthesized `click()` from `execute` is not one, and Safari
	 * will keep the `AudioContext` suspended for it.
	 */
	async click(element: string): Promise<void> {
		await this.#command("POST", `/element/${element}/click`, {});
	}

	/** Run `script` as a function body in the page and return what it returns, serialised as JSON. */
	async execute<T>(script: string, args: unknown[] = []): Promise<T> {
		return (await this.#command("POST", "/execute/sync", { script, args })) as T;
	}

	/** End the session and stop the driver. Safe to call twice, because teardown paths call it. */
	async quit(): Promise<void> {
		if (this.#session) {
			const session = this.#session;
			this.#session = undefined;
			await request(this.origin, "DELETE", `/session/${session}`).catch(() => undefined);
		}
		this.#process.kill();
		await this.#process.exited.catch(() => undefined);
	}

	/** Send a command scoped to the open session. */
	async #command(method: "POST" | "GET" | "DELETE", path: string, body?: unknown): Promise<unknown> {
		if (!this.#session) throw new Error("no session: call newSession() first");
		return await request(this.origin, method, `/session/${this.#session}${path}`, body);
	}
}

/**
 * One WebDriver request, unwrapping the `value` envelope every response carries.
 *
 * An error response carries the same envelope with `error` and `message` inside it, so the status
 * code alone is not the report: the code is what names which thing went wrong.
 */
async function request(origin: string, method: string, path: string, body?: unknown): Promise<unknown> {
	const response = await fetch(`${origin}${path}`, {
		method,
		headers: body === undefined ? undefined : { "content-type": "application/json; charset=utf-8" },
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: AbortSignal.timeout(COMMAND_TIMEOUT_MS),
	});

	const text = await response.text();
	let payload: { value?: unknown };
	try {
		payload = JSON.parse(text) as { value?: unknown };
	} catch {
		throw new Error(`${method} ${path}: ${response.status} with an unreadable body: ${text.slice(0, 200)}`);
	}

	const value = payload.value;
	if (value && typeof value === "object" && "error" in value) {
		const error = value as { error: string; message?: string };
		throw new WebDriverError(error.error, error.message ?? "");
	}
	if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text.slice(0, 200)}`);
	return value;
}

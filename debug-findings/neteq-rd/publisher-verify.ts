/** Run synthetic publisher timing checks with the existing smoke browser launcher. */
import assert from "node:assert/strict";
import { join } from "node:path";
import { launch } from "../../test/smoke/clients/js/harness";

const build = await Bun.build({
	entrypoints: [join(import.meta.dir, "publisher-browser.ts")],
	target: "browser",
	format: "esm",
});
if (!build.success) throw new Error(build.logs.join("\n"));
const script = await build.outputs[0].text();
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch(request) {
		const path = new URL(request.url).pathname;
		if (path === "/")
			return new Response('<script type="module" src="/publisher.js"></script>', {
				headers: { "Content-Type": "text/html" },
			});
		if (path === "/publisher.js")
			return new Response(script, { headers: { "Content-Type": "text/javascript" } });
		return new Response("not found", { status: 404 });
	},
});
const origin = `http://127.0.0.1:${server.port}`;
try {
	const browser = await launch();
	try {
		const page = await browser.newPage();
		await page.route("**/*", (route) =>
			new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
		);
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(error.message));
		await page.goto(origin);
		await page.waitForFunction(() => Reflect.has(globalThis, "result"), undefined, { timeout: 30_000 });
		const result = await page.evaluate(() => Reflect.get(globalThis, "result"));
		assert.deepEqual(errors, []);
		assert.equal(result?.ok, true, JSON.stringify(result));
		console.log(JSON.stringify({ browser: await browser.version(), ...result }, null, 2));
	} finally {
		await browser.close();
	}
} finally {
	server.stop(true);
}

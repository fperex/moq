/** Run synthetic HE-AAC file format checks through the existing browser launcher. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { build } from "vite";
import { workletInline } from "../../js/common/vite-plugin-worklet";
import { launch } from "../../test/smoke/clients/js/harness";
import fixtures from "./file-format-fixtures.json";

const media = new Map<string, Uint8Array<ArrayBuffer>>();
for (const fixture of fixtures.fixtures) {
	const bytes = Buffer.from(fixture.base64, "base64");
	assert.equal(createHash("sha256").update(bytes).digest("hex"), fixture.sha256);
	media.set(`/${fixture.name}`, bytes);
}
const result = await build({
	configFile: false,
	logLevel: "error",
	plugins: [workletInline()],
	build: {
		write: false,
		minify: false,
		lib: { entry: join(import.meta.dir, "file-format-browser.ts"), formats: ["es"], fileName: "file-format" },
		rollupOptions: { output: { inlineDynamicImports: true } },
	},
});
if ("on" in result) throw new Error("expected a completed browser build");
const output = Array.isArray(result) ? result[0].output : result.output;
const code = output.find((file) => file.type === "chunk");
assert.ok(code);
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch(request) {
		const path = new URL(request.url).pathname;
		if (path === "/")
			return new Response('<script type="module" src="/probe.js"></script>', {
				headers: { "content-type": "text/html" },
			});
		if (path === "/probe.js") return new Response(code.code, { headers: { "content-type": "text/javascript" } });
		if (path === "/fixtures")
			return Response.json(fixtures.fixtures.map(({ name, metadata }) => ({ name, metadata })));
		const bytes = media.get(path);
		return bytes ? new Response(bytes) : new Response("not found", { status: 404 });
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
		await page.waitForFunction(() => Reflect.has(globalThis, "fileFormatResult"), undefined, { timeout: 30_000 });
		const result = await page.evaluate(() => Reflect.get(globalThis, "fileFormatResult"));
		assert.deepEqual(errors, []);
		assert.equal(result.error, undefined, result.error);
		assert.ok(Array.isArray(result.cells));
		console.log(JSON.stringify({ browser: browser.version(), ...result }, null, 2));
	} finally {
		await browser.close();
	}
} finally {
	server.stop(true);
}

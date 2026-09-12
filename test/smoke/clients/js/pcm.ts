/** Run actual buffered PCM through the browser worklet without a relay. */
import { join } from "node:path";
import { parseArgs } from "node:util";
import { launch } from "./harness";

const { values } = parseArgs({
	options: {
		case: { type: "string" },
		rate: { type: "string" },
		transport: { type: "string" },
	},
});
const cases = [
	"finite",
	"reset",
	"truncate",
	"pressure",
	"takeover",
	"takeover-gap",
	"graph",
	"large",
	"large-reset",
	"large-truncate",
	"large-end",
];
if (values.case && !cases.includes(values.case)) throw new Error("invalid --case");
if (values.rate && !["44100", "48000"].includes(values.rate)) throw new Error("invalid --rate");
if (values.transport && !["post", "shared"].includes(values.transport)) throw new Error("invalid --transport");
const root = join(import.meta.dir, "dist");
if (!(await Bun.file(join(root, "pcm.html")).exists())) throw new Error("PCM page is not built; run bunx vite build");
const browser = await launch();
try {
	for (const shared of [false, true]) {
		if (values.transport && values.transport !== (shared ? "shared" : "post")) continue;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				const path = new URL(request.url).pathname;
				const file = Bun.file(join(root, path));
				if (!(await file.exists())) return new Response("not found", { status: 404 });

				return new Response(file, {
					headers: shared
						? {
								"Cross-Origin-Opener-Policy": "same-origin",
								"Cross-Origin-Embedder-Policy": "require-corp",
							}
						: {},
				});
			},
		});
		try {
			for (const rate of [44100, 48000])
				for (const kind of cases) {
					if ((values.rate && Number(values.rate) !== rate) || (values.case && values.case !== kind))
						continue;
					const page = await browser.newPage();
					const errors: string[] = [];
					const diagnostics: string[] = [];
					page.on("pageerror", (error) => errors.push(error.message));
					page.on("console", (message) => diagnostics.push(message.text()));
					try {
						const response = await page.goto(
							`http://127.0.0.1:${server.port}/pcm.html?rate=${rate}&case=${kind}`,
						);
						if (!response?.ok()) throw new Error(`PCM page failed to load: ${response?.status()}`);
						await page.waitForFunction(() => document.body.dataset.ready === "true");
						await page.click("button");
						await page.waitForFunction(() => document.body.dataset.pcm !== undefined, undefined, {
							timeout: 15000,
						});
						const result = await page.evaluate(() => JSON.parse(document.body.dataset.pcm ?? "null"));
						if (errors.length || !result?.ok || result.shared !== shared)
							throw new Error(JSON.stringify({ shared, rate, kind, errors, diagnostics, result }));
						console.log(JSON.stringify(result));
					} finally {
						await page.close();
					}
				}
		} finally {
			server.stop(true);
		}
	}
} finally {
	await browser.close();
}

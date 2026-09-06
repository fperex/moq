// Beacon sink: a beacon tag "<run>.<stream>" lands in $RT_RUN_DIR/<run>/<stream>.ndjson, one JSON
// batch per line. Run: RT_RUN_DIR=<runs dir> bun sink.ts
import { appendFileSync, mkdirSync } from "node:fs";

const DIR = process.env.RT_RUN_DIR ?? `${process.env.HOME}/rt-runs`;
mkdirSync(DIR, { recursive: true });
const safe = (s: string) => String(s).replace(/[^a-zA-Z0-9._-]/g, "_");

Bun.serve({
	port: 18787,
	hostname: "127.0.0.1",
	async fetch(req) {
		const url = new URL(req.url);
		if (req.method === "POST" && url.pathname === "/log") {
			const body = await req.text();
			let tag = "untagged.untagged";
			try {
				tag = JSON.parse(body).tag ?? tag;
			} catch {}
			const dot = tag.indexOf(".");
			const run = dot < 0 ? "untagged" : tag.slice(0, dot);
			const stream = dot < 0 ? tag : tag.slice(dot + 1);
			mkdirSync(`${DIR}/${safe(run)}`, { recursive: true });
			appendFileSync(`${DIR}/${safe(run)}/${safe(stream)}.ndjson`, `${body}\n`);
			return new Response("ok", { headers: { "access-control-allow-origin": "*" } });
		}
		if (url.pathname === "/health") return new Response("up");
		return new Response("nope", { status: 404 });
	},
});
console.log(`sink listening on 127.0.0.1:18787 -> ${DIR}/<run>/<stream>.ndjson`);

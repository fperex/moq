/**
 * Collects the pages' beacons into one ndjson file per row.
 *
 * One line per batch, appended as it arrives, so a run that dies halfway still has everything up to
 * the moment it died. The row's tag names the file, which is why the tag is sanitised here rather
 * than trusted: it arrives from a page, and a page is not the harness.
 *
 *     bun sink.ts --dir <run dir> [--port 0]
 *
 * Adapted from `debug-findings/analysis/sink.ts` on the reporter's fork (`fperex/moq`, branch
 * `debug/rt-audio`). See ../../README.md.
 *
 * @module
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
	options: {
		dir: { type: "string" },
		port: { type: "string", default: "0" },
	},
});

if (!values.dir) {
	console.error("usage: sink.ts --dir <run dir> [--port N]");
	process.exit(2);
}

const dir = values.dir;
mkdirSync(dir, { recursive: true });

/** A tag becomes a filename, so it may only be what a row key can be. */
const safe = (tag: string) => tag.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "untagged";

const server = Bun.serve({
	port: Number.parseInt(values.port, 10),
	hostname: "127.0.0.1",
	async fetch(req) {
		const path = new URL(req.url).pathname;
		// The page posts cross-origin (it is served from its own port), and sendBeacon cannot answer
		// a preflight once the document is gone, so the response is simple and permissive.
		const cors = { "access-control-allow-origin": "*" };
		if (path === "/health") return new Response("up", { headers: cors });
		if (req.method !== "POST" || path !== "/log") return new Response("not found", { status: 404, headers: cors });

		const body = await req.text();
		let tag = "untagged";
		try {
			tag = (JSON.parse(body) as { tag?: string }).tag ?? tag;
		} catch {
			// A batch that will not parse is still evidence of something, so it is filed rather than
			// dropped; the analyzer skips lines it cannot read and says how many.
		}
		appendFileSync(join(dir, `${safe(tag)}.ndjson`), `${body}\n`);
		return new Response("ok", { headers: cors });
	},
});

// The port is OS-assigned when it is 0, and run.sh reads this line to find it.
console.log(`sink: http://127.0.0.1:${server.port}/log -> ${dir}/<tag>.ndjson`);

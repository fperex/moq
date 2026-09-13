/**
 * Prints a before/after table across two run directories.
 *
 * The row key has to match on both sides, so a cell is only ever compared with the same codec, rate,
 * profile, and ring. A row present in one run and not the other is shown as missing rather than
 * dropped: a matrix that shrank between the two is exactly the thing a before/after table should not
 * hide.
 *
 *     bun compare.ts --before <run dir> --after <run dir> [--out table.md]
 *
 * Adapted from `debug-findings/analysis/compare.mjs` on the reporter's fork (`fperex/moq`, branch
 * `debug/rt-audio`). See ../../README.md.
 *
 * @module
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { rowKey, type Summary } from "./src/schema.ts";

const { values } = parseArgs({
	options: {
		before: { type: "string" },
		after: { type: "string" },
		out: { type: "string" },
	},
});

if (!values.before || !values.after) {
	console.error("usage: compare.ts --before <run dir> --after <run dir> [--out table.md]");
	process.exit(2);
}

const load = (dir: string): Map<string, Summary> => {
	const out = new Map<string, Summary>();
	for (const file of readdirSync(dir).filter((f) => f.endsWith(".summary.json"))) {
		const summary = JSON.parse(readFileSync(join(dir, file), "utf8")) as Summary;
		out.set(rowKey(summary.row), summary);
	}
	return out;
};

const before = load(values.before);
const after = load(values.after);
const rows = [...new Set([...before.keys(), ...after.keys()])].sort();

/** The columns a before/after table is read for: what the listener would have noticed. */
const COLUMNS: { label: string; key: string }[] = [
	{ label: "underrun ep/min", key: "underrun_episodes_per_min" },
	{ label: "underrun ms/min", key: "underrun_samples_per_min" },
	{ label: "skips/min", key: "skip_aheads_per_min" },
	{ label: "skipped ms/min", key: "skipped_samples_per_min" },
	{ label: "silence", key: "silence_share_share" },
	{ label: "target p95", key: "target_ms_p95" },
];

const cell = (summary: Summary | undefined, key: string): string => {
	if (!summary) return "-";
	if (summary.voids.length > 0) return `void:${summary.voids[0]?.assertion}`;
	const value = summary.metrics[key];
	return value === null || value === undefined ? "n/a" : String(value);
};

const lines: string[] = [];
lines.push(`| row | ${COLUMNS.map((c) => `${c.label} (before -> after)`).join(" | ")} |`);
lines.push(`|---|${COLUMNS.map(() => "---").join("|")}|`);
for (const row of rows) {
	const b = before.get(row);
	const a = after.get(row);
	lines.push(`| ${row} | ${COLUMNS.map((c) => `${cell(b, c.key)} -> ${cell(a, c.key)}`).join(" | ")} |`);
}

const missing = rows.filter((r) => !before.has(r) || !after.has(r));
if (missing.length > 0) {
	lines.push("", `rows present in only one run: ${missing.join(", ")}`);
}
const voided = rows.filter((r) => (before.get(r)?.voids.length ?? 0) > 0 || (after.get(r)?.voids.length ?? 0) > 0);
for (const row of voided) {
	const reasons = [...(before.get(row)?.voids ?? []), ...(after.get(row)?.voids ?? [])];
	lines.push(`- void ${row}: ${reasons.map((v) => `${v.assertion} (${v.detail})`).join("; ")}`);
}

const table = lines.join("\n");
console.log(table);
if (values.out) await Bun.write(values.out, `${table}\n`);

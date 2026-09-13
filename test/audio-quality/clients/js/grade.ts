/**
 * Grades a run's summaries against `budgets.json` and prints the table.
 *
 * Every budget value is a ceiling, and a row with no budget is a failure rather than a pass: a
 * matrix that grows a cell nobody wrote a budget for would otherwise quietly grade nothing.
 *
 * In this stage the budgets are **recorded, not enforced**. The table prints, the results are
 * written, and the exit status is zero unless `--enforce` is passed. The numbers in `budgets.json`
 * are what this machine measured, not what the player is required to achieve, and grading against
 * them before the fix lands would only encode the bug.
 *
 *     bun grade.ts --run <run dir> --budgets ../../budgets.json [--enforce]
 *
 * @module
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { type Budget, type Budgets, METRICS, type Row, rowKey, type Summary } from "./src/schema.ts";

const { values } = parseArgs({
	options: {
		run: { type: "string" },
		budgets: { type: "string" },
		enforce: { type: "boolean", default: false },
	},
});

if (!values.run || !values.budgets) {
	console.error("usage: grade.ts --run <run dir> --budgets <budgets.json> [--enforce]");
	process.exit(2);
}

const budgets = JSON.parse(readFileSync(values.budgets, "utf8")) as Budgets;

const summaries = readdirSync(values.run)
	.filter((f) => f.endsWith(".summary.json"))
	.sort()
	.map((f) => JSON.parse(readFileSync(join(values.run as string, f), "utf8")) as Summary);

if (summaries.length === 0) {
	console.error(`error: no summaries in ${values.run}`);
	process.exit(2);
}

/** A budget applies to exactly one matrix cell, matched on the whole row. */
const budgetFor = (row: Row): Budget | undefined =>
	budgets.rows.find(
		(b) =>
			b.runtime === row.runtime &&
			b.codec === row.codec &&
			b.rate === row.rate &&
			b.profile === row.profile &&
			b.ring === row.ring,
	);

/** Every graded key a budget may name, in schema order, so the table reads the same every run. */
const keys = Object.entries(METRICS).flatMap(([name, spec]) => spec.aggregations.map((a) => `${name}_${a}`));

type Verdict = { row: string; key: string; value: number | null; ceiling: number; over: boolean };

const verdicts: Verdict[] = [];
const voided: string[] = [];
const unbudgeted: string[] = [];

for (const summary of summaries) {
	const key = rowKey(summary.row);
	if (summary.voids.length > 0) {
		voided.push(`${key}: ${summary.voids.map((v) => `${v.assertion} (${v.detail})`).join("; ")}`);
		continue;
	}
	const budget = budgetFor(summary.row);
	if (!budget) {
		unbudgeted.push(key);
		continue;
	}
	for (const metric of keys) {
		const ceiling = budget[metric];
		if (typeof ceiling !== "number") continue;
		const value = summary.metrics[metric] ?? null;
		verdicts.push({ row: key, key: metric, value, ceiling, over: value !== null && value > ceiling });
	}
}

// ── the table ───────────────────────────────────────────────────────────────

const lines: string[] = [];
lines.push(
	"| row | underrun ep/min | underrun ms/min | skips/min | skipped ms/min | groups/min | silence | stalled | target p95 | converge s | void |",
);
lines.push("|---|---|---|---|---|---|---|---|---|---|---|");
const cell = (x: number | null | undefined) => (x === null || x === undefined ? "n/a" : String(x));
for (const summary of summaries) {
	const m = summary.metrics;
	lines.push(
		`| ${rowKey(summary.row)} | ${cell(m.underrun_episodes_per_min)} | ${cell(m.underrun_samples_per_min)} | ${cell(m.skip_aheads_per_min)} | ${cell(m.skipped_samples_per_min)} | ${cell(m.skipped_groups_per_min)} | ${cell(m.silence_share_share)} | ${cell(m.stalled_quanta_share)} | ${cell(m.target_ms_p95)} | ${cell(m.converge_s_seconds)} | ${summary.voids.map((v) => v.assertion).join(",") || "-"} |`,
	);
}

const over = verdicts.filter((v) => v.over);
lines.push("");
if (over.length > 0) {
	lines.push("over budget:");
	for (const v of over) lines.push(`- ${v.row} ${v.key}: ${v.value} > ${v.ceiling}`);
} else {
	lines.push(`within budget: ${verdicts.length} checks across ${summaries.length - voided.length} rows`);
}
if (voided.length > 0) {
	lines.push("", "void rows (not graded):");
	for (const v of voided) lines.push(`- ${v}`);
}
if (unbudgeted.length > 0) {
	lines.push("", "rows with no budget:");
	for (const u of unbudgeted) lines.push(`- ${u}`);
}

const report = lines.join("\n");
console.log(report);
await Bun.write(join(values.run, "grade.md"), `${report}\n`);
await Bun.write(
	join(values.run, "grade.json"),
	JSON.stringify({ enforced: values.enforce, verdicts, voided, unbudgeted }, null, 1),
);

if (!values.enforce) {
	console.log("\nrecording only: budgets are not enforced in this stage (pass --enforce to fail on them)");
	process.exit(0);
}

const failed = over.length > 0 || unbudgeted.length > 0;
if (failed) console.error(`FAIL: ${over.length} over budget, ${unbudgeted.length} unbudgeted`);
process.exit(failed ? 1 : 0);

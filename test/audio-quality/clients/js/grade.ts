/**
 * Grades a run's summaries against `budgets.json` and prints the table.
 *
 * Every budget value is a ceiling, and a row with no budget is a failure rather than a pass: a
 * matrix that grows a cell nobody wrote a budget for would otherwise quietly grade nothing. A void
 * row fails the same way, for the same reason: its numbers are the ones that cannot be trusted.
 *
 * A row marked `recorded` in `budgets.json` is graded and its breaches are printed, but it does not
 * fail the run: its ceilings are what a machine measured rather than what the player is required to
 * achieve. Every other row is enforced.
 *
 * The table prints and the results are written either way; the exit status is zero unless
 * `--enforce` is passed, which the nightly job does. `budgets.json` says how each ceiling in it was
 * arrived at.
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

type Verdict = {
	row: string;
	key: string;
	value: number | null;
	ceiling: number;
	over: boolean;
	/** Whether a breach fails the run, or is only reported. */
	enforced: boolean;
};

const verdicts: Verdict[] = [];
const voided: string[] = [];
const reportedVoid: string[] = [];
const unbudgeted: string[] = [];

for (const summary of summaries) {
	const key = rowKey(summary.row);
	const budget = budgetFor(summary.row);
	if (!budget) {
		unbudgeted.push(key);
		continue;
	}
	if (summary.voids.length > 0) {
		const reason = `${key}: ${summary.voids.map((v) => `${v.assertion} (${v.detail})`).join("; ")}`;
		// A recorded row has nothing to enforce, so a run of it that cannot be trusted is reported
		// rather than failed. An enforced row's void is a failure: the alternative is a green matrix
		// over a cell that measured the WebSocket fallback, the other ring, or a throttled clock.
		if (budget.recorded === true) reportedVoid.push(reason);
		else voided.push(reason);
		continue;
	}
	for (const metric of keys) {
		const ceiling = budget[metric];
		if (typeof ceiling !== "number") continue;
		const value = summary.metrics[metric] ?? null;
		verdicts.push({
			row: key,
			key: metric,
			value,
			ceiling,
			over: value !== null && value > ceiling,
			enforced: budget.recorded !== true,
		});
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

const over = verdicts.filter((v) => v.over && v.enforced);
const reported = verdicts.filter((v) => v.over && !v.enforced);
lines.push("");
if (over.length > 0) {
	lines.push("over budget:");
	for (const v of over) lines.push(`- ${v.row} ${v.key}: ${v.value} > ${v.ceiling}`);
} else {
	lines.push(
		`within budget: ${verdicts.filter((v) => v.enforced).length} enforced checks across ${summaries.length - voided.length} rows`,
	);
}
if (reported.length > 0) {
	lines.push("", "over a recorded ceiling (reported, not enforced):");
	for (const v of reported) lines.push(`- ${v.row} ${v.key}: ${v.value} > ${v.ceiling}`);
}
if (voided.length > 0) {
	lines.push("", "void rows (not graded):");
	for (const v of voided) lines.push(`- ${v}`);
}
if (reportedVoid.length > 0) {
	lines.push("", "void rows on a recorded budget (reported, not enforced):");
	for (const v of reportedVoid) lines.push(`- ${v}`);
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
	JSON.stringify({ enforced: values.enforce, verdicts, voided, reportedVoid, unbudgeted }, null, 1),
);

if (!values.enforce) {
	console.log("\nreporting only: pass --enforce to fail the run on these budgets");
	process.exit(0);
}

const failed = over.length > 0 || unbudgeted.length > 0 || voided.length > 0;
if (failed) {
	console.error(`FAIL: ${over.length} over budget, ${unbudgeted.length} unbudgeted, ${voided.length} void`);
}
process.exit(failed ? 1 : 0);

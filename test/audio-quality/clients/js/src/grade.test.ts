import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Summary } from "./schema.ts";

test("replay keeps independent skip and writer-discard limits while reporting observed jumps", () => {
	const out = mkdtempSync(join(tmpdir(), "moq-audio-grade-"));
	try {
		const replay = spawnSync(
			process.execPath,
			[
				new URL("../replay.ts", import.meta.url).pathname,
				"--out",
				out,
				"--fixtures",
				"mic-firefox",
				"--rings",
				"plain",
			],
			{ encoding: "utf8" },
		);
		expect(replay.status, replay.stderr).toBe(0);
		const path = join(out, "replay-opus-48000-mic-firefox-plain.summary.json");
		const summary: Summary = JSON.parse(readFileSync(path, "utf8"));
		expect(summary.metrics.skip_aheads_per_min).toBe(0);
		expect(summary.metrics.skipped_samples_per_min).toBe(0);
		expect(summary.metrics.discarded_samples_per_min).toBe(13127.3);
		expect(summary.metrics.observed_skipped_samples_per_min).toBeGreaterThan(0);

		const grade = (changed: Record<string, number> = {}) => {
			writeFileSync(path, JSON.stringify({ ...summary, metrics: { ...summary.metrics, ...changed } }));
			return spawnSync(
				process.execPath,
				[
					new URL("../grade.ts", import.meta.url).pathname,
					"--run",
					out,
					"--budgets",
					new URL("../../../budgets.json", import.meta.url).pathname,
					"--enforce",
				],
				{ encoding: "utf8" },
			);
		};
		expect(grade().status).toBe(0);
		expect(grade({ observed_jumps_per_min: 1e6, observed_skipped_samples_per_min: 1e6 }).status).toBe(0);
		expect(grade({ skip_aheads_per_min: 1, discarded_samples_per_min: 0 }).status).toBe(1);
		expect(grade({ skipped_samples_per_min: 1, discarded_samples_per_min: 0 }).status).toBe(1);
		expect(grade({ discarded_samples_per_min: 13128.3 }).status).toBe(1);
	} finally {
		rmSync(out, { recursive: true, force: true });
	}
});

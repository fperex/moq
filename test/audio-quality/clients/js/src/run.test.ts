import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../../../run.sh", import.meta.url));

test("replay refuses an occupied output directory without changing its files", () => {
	const out = mkdtempSync(join(tmpdir(), "moq-audio-output-"));
	try {
		writeFileSync(join(out, "marker"), "keep this run");
		const result = spawnSync("bash", [script, "--runtime", "replay", "--out", out], { encoding: "utf8" });
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("is not empty; remove it or name a new directory");
		expect(readFileSync(join(out, "marker"), "utf8")).toBe("keep this run");
		expect(readdirSync(out)).toEqual(["marker"]);
		const listed = spawnSync("bash", [script, "--runtime", "replay", "--list", "--out", out], { encoding: "utf8" });
		expect(listed.status).toBe(0);
		expect(listed.stdout).toContain("replay-aac-44100-lan-bbb-isolated");
		expect(readdirSync(out)).toEqual(["marker"]);
	} finally {
		rmSync(out, { recursive: true, force: true });
	}
});

test("replay saves results into empty and missing output directories", () => {
	const root = mkdtempSync(join(tmpdir(), "moq-audio-output-"));
	try {
		mkdirSync(join(root, "empty"));
		for (const name of ["empty", "missing"]) {
			const out = join(root, name);
			const result = spawnSync(
				"bash",
				[script, "--runtime", "replay", "--profiles", "mic-local", "--rings", "plain", "--out", out],
				{
					encoding: "utf8",
					env: { ...process.env, MOQ_TEST_RUNS: join(root, "runs") },
				},
			);
			expect(result.status).toBe(0);
			expect(readdirSync(out)).toContain("replay-opus-48000-mic-local-plain.summary.json");
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}, 20_000);

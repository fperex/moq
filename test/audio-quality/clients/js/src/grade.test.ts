import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Budgets, QuietProof, Summary } from "./schema.ts";
import { graded, reference, samples, share, source } from "./silence.fixture.ts";
import { prove } from "./silence.ts";

const budgets = new URL("../../../budgets.json", import.meta.url).pathname;

/** Grade one enforced AAC fixed-250 row whose every other metric sits at zero, under `--enforce`. */
function gradeSilence(silence: number, proof: QuietProof | undefined) {
	const out = mkdtempSync(join(tmpdir(), "moq-audio-silence-"));
	try {
		const row = { runtime: "chromium", codec: "aac", rate: 44100, profile: "fixed-250", ring: "plain" } as const;
		const budget = (JSON.parse(readFileSync(budgets, "utf8")) as Budgets).rows.find(
			(b) =>
				b.runtime === row.runtime && b.codec === row.codec && b.profile === row.profile && b.ring === row.ring,
		);
		if (!budget || budget.recorded === true) throw new Error("the AAC fixed-250 plain row is no longer enforced");
		const metrics: Record<string, number> = {};
		for (const [key, value] of Object.entries(budget))
			if (typeof value === "number" && key !== "rate") metrics[key] = 0;
		metrics.silence_share_share = silence;
		const summary = { version: 1, row, voids: [], metrics, silence: proof } as unknown as Summary;
		writeFileSync(join(out, "chromium-aac-44100-fixed-250-plain.summary.json"), JSON.stringify(summary));
		const result = spawnSync(
			process.execPath,
			[new URL("../grade.ts", import.meta.url).pathname, "--run", out, "--budgets", budgets, "--enforce"],
			{ encoding: "utf8" },
		);
		return {
			status: result.status,
			stdout: result.stdout,
			grade: JSON.parse(readFileSync(join(out, "grade.json"), "utf8")),
		};
	} finally {
		rmSync(out, { recursive: true, force: true });
	}
}

const film = source();

test("authored quiet over the raw silence ceiling passes, and shows the raw share next to its proof", () => {
	const all = samples(film);
	const window = graded(all);
	const raw = share(window);
	expect(raw).toBeGreaterThan(0.191);
	const proof = prove(all, window, reference(film));

	const { status, stdout, grade } = gradeSilence(raw, proof);
	expect(status, stdout).toBe(0);
	expect(stdout).toContain(`silence_share_share: ${raw} > 0.191`);
	expect(stdout).toContain(`${proof.quiet}/${proof.quiet} quiet windows over quiet source`);
	const verdict = grade.verdicts.find((v: { key: string }) => v.key === "silence_share_share");
	expect(verdict).toMatchObject({ value: raw, over: true, authored: true });
});

test("one quiet window over audible source keeps the raw silence failure", () => {
	const all = samples(film);
	const window = graded(all);
	const gap = window.findIndex((s) => (s.rms ?? 0) > 0.01);
	window[gap].rms = 0.0002;

	const { status, stdout } = gradeSilence(share(window), prove(all, window, reference(film)));
	expect(status).toBe(1);
	expect(stdout).toContain("over budget:");
	expect(stdout).toContain("audible source");
});

test("a missing or misaligned reference keeps the raw silence failure", () => {
	const all = samples(film);
	const window = graded(all);
	const raw = share(window);
	expect(gradeSilence(raw, prove(all, window, undefined)).status).toBe(1);
	expect(gradeSilence(raw, prove(all, window, reference(source(85, [4.1, 2.9])))).status).toBe(1);
	// A summary written before the proof existed carries none.
	expect(gradeSilence(raw, undefined).status).toBe(1);
});

test("a proof whose counts disagree with the raw share cannot excuse it", () => {
	const all = samples(film);
	const window = graded(all);
	const proof = prove(all, window, reference(film));
	expect(gradeSilence(0.5, proof).status).toBe(1);
});

test("a row within the raw silence ceiling keeps today's verdict", () => {
	const all = samples(film);
	const window = graded(all);
	const unproven = prove(all, window, undefined);
	expect(gradeSilence(0.15, unproven).status).toBe(0);
	expect(gradeSilence(0.191, undefined).status).toBe(0);
});

test("a timeline change inside a quiet window keeps the raw silence failure", () => {
	const all = samples(film);
	const window = graded(all);
	const quiet = window.find((s) => (s.rms ?? 1) < 0.001);
	if (!quiet?.playout) throw new Error("the fixture has no quiet window");
	quiet.playout = { ...quiet.playout, anchor: 1 };

	const { status, stdout } = gradeSilence(share(window), prove(all, window, reference(film)));
	expect(status).toBe(1);
	expect(stdout).toContain("timeline");
});

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

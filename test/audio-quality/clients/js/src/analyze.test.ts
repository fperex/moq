import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Sample, Summary } from "./schema.ts";

const tag = "chromium-aac-44100-fixed-250-plain";
const diagnostic = {
	generation: 1,
	rate: 44100,
	anchor: 44100,
	skips: 0,
	skipped: 0,
	discarded: 0,
	trimmed: 0,
	buffered: 11025,
	target: 11025,
	chunk: 1024,
	skip: 3308,
	stalled: false,
	fresh: false,
	underruns: 0,
	queued: 0,
	stretched: 0,
	output: 0,
	concealed: 0,
	accelerates: 0,
	expands: 0,
	merges: 0,
	short: 0,
	budget: 250,
};

function analyze(change: (sample: Sample) => Sample): Summary {
	const out = mkdtempSync(join(tmpdir(), "moq-audio-analysis-"));
	try {
		const samples = Array.from({ length: 241 }, (_, i) => {
			const at = i * 250;
			return change({
				at,
				timestamp: 1000 + at,
				stalled: false,
				underruns: 0,
				skipped: 0,
				buffered: 250,
				delay: 250,
				contextTime: at,
				contextRate: 44100,
				rms: 0.1,
				clock: "audio",
				playout: { ...diagnostic },
			});
		});
		writeFileSync(join(out, `${tag}.ndjson`), JSON.stringify({ tag, samples }));
		const result = spawnSync(
			process.execPath,
			[new URL("../analyze.ts", import.meta.url).pathname, "--run", out, "--row", tag],
			{ encoding: "utf8" },
		);
		expect(result.status, result.stderr).toBe(0);
		return JSON.parse(readFileSync(join(out, `${tag}.summary.json`), "utf8"));
	} finally {
		rmSync(out, { recursive: true, force: true });
	}
}

test("report age does not invent a playback skip", () => {
	const summary = analyze((sample) => ({
		...sample,
		timestamp: 1000 + sample.at - (sample.at >= 15000 && sample.at < 20000 ? 60 : 0),
	}));
	expect(summary.metrics.skip_aheads_total).toBe(0);
	expect(summary.metrics.skipped_samples_total).toBe(0);
});

test("a real ring skip remains visible despite delayed reports", () => {
	const summary = analyze((sample) => ({
		...sample,
		playout: { ...diagnostic, skips: sample.at >= 20000 ? 1 : 0, skipped: sample.at >= 20000 ? 2646 : 0 },
	}));
	expect(summary.metrics.skip_aheads_total).toBe(1);
	expect(summary.metrics.skipped_samples_total).toBe(60);
});

test("late writes and startup trim are separate from skipped playback", () => {
	const summary = analyze((sample) => ({
		...sample,
		playout: { ...diagnostic, discarded: sample.at >= 20000 ? 441 : 0, trimmed: 4410 },
	}));
	expect(summary.metrics.skip_aheads_total).toBe(0);
	expect(summary.metrics.skipped_samples_total).toBe(0);
	expect(summary.metrics.discarded_samples_total).toBe(10);
});

test("a missing diagnostic counter remains unmeasured", () => {
	const summary = analyze((sample) => ({ ...sample, playout: undefined }));
	expect(summary.metrics.skip_aheads_total).toBeNull();
	expect(summary.metrics.skipped_samples_total).toBeNull();
});

for (const changed of [{ generation: 2 }, { anchor: 88200 }, { output: -1 }]) {
	test(`a changed playback timeline cannot pass as zero skips (${JSON.stringify(changed)})`, () => {
		const summary = analyze((sample) => ({
			...sample,
			playout: { ...diagnostic, ...(sample.at >= 20000 ? changed : {}) },
		}));
		expect(summary.voids.some((entry) => entry.assertion === "playout")).toBe(true);
	});
}

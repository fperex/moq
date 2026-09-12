import { describe, expect, it } from "bun:test";
import { ALGORITHM, generate, load } from "./jitter.vectors.ts";

describe("playout corpus", () => {
	const disk = load();
	const fresh = generate();

	it("is the format both languages read", () => {
		expect(disk.algorithm).toBe(ALGORITHM);
	});

	it("matches the checked-in file", () => {
		// Regenerated in memory and compared whole, so a change to the estimator that moves a single
		// target fails here rather than only in the Rust suite.
		expect(disk).toEqual(fresh);
	});

	it("holds only whole buckets", () => {
		// An f64 difference between V8 and rustc cannot straddle a 20ms step, so parity survives it.
		for (const entry of disk.cases) {
			for (const target of entry.target_ms) {
				expect(target % disk.constants.bucket_ms).toBe(0);
				expect(Number.isInteger(target)).toBe(true);
			}
		}
	});

	it("records a target per arrival", () => {
		for (const entry of disk.cases) {
			expect(entry.target_ms).toHaveLength(entry.arrivals.length);
			expect(entry.arrivals.length).toBeGreaterThan(0);
			expect(entry.description).not.toBe("");
		}
	});
});

import { describe, expect, test } from "bun:test";
import path from "node:path";

type Mapping = { [key: string]: unknown };

const workflows = [
	{ file: "interop.yml", job: "interop" },
	{ file: "nightly.yml", job: "nightly" },
];

const github = path.resolve(import.meta.dir, "..");

function mapping(value: unknown, label: string): Mapping {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError(`${label} is not a YAML mapping`);
	}

	return { ...value };
}

function sequence(value: unknown, label: string): unknown[] {
	if (!Array.isArray(value)) throw new TypeError(`${label} is not a YAML sequence`);
	return value;
}

async function yaml(file: string): Promise<Mapping> {
	return mapping(Bun.YAML.parse(await Bun.file(file).text()), file);
}

describe("Rust cache boundary", () => {
	for (const workflow of workflows) {
		test(`${workflow.file} uses the flake-keyed local cache action`, async () => {
			const file = path.join(github, "workflows", workflow.file);
			const document = await yaml(file);
			const jobs = mapping(document.jobs, `${file}: jobs`);
			const job = mapping(jobs[workflow.job], `${file}: jobs.${workflow.job}`);
			const steps = sequence(job.steps, `${file}: jobs.${workflow.job}.steps`).map((step, index) =>
				mapping(step, `${file}: jobs.${workflow.job}.steps[${index}]`),
			);
			const cache = steps.find((step) => step.name === "Rust cache" || step.name === "Rust Cache");

			expect(
				steps.some((step) => typeof step.uses === "string" && step.uses.startsWith("Swatinem/rust-cache@")),
			).toBeFalse();
			expect(cache?.uses).toBe("./.github/actions/rust-cache");
		});
	}

	test("cache and restore keys bind the runner and pinned Nix toolchain", async () => {
		const file = path.join(github, "actions/rust-cache/action.yml");
		const document = await yaml(file);
		const runs = mapping(document.runs, `${file}: runs`);
		const steps = sequence(runs.steps, `${file}: runs.steps`).map((step, index) =>
			mapping(step, `${file}: runs.steps[${index}]`),
		);
		const cache = steps.find(
			(step) => typeof step.uses === "string" && step.uses.startsWith("jdx/mr-boxington-action@"),
		);
		const inputs = mapping(cache?.with, `${file}: cache inputs`);
		const prefix = `\${{ runner.os }}-\${{ runner.arch }}-mbx-target-\${{ inputs.scope }}-\${{ hashFiles('flake.nix', 'flake.lock', 'rust-toolchain.toml') }}-`;

		expect(inputs["restore-keys"]).toBe(prefix);
		expect(typeof inputs["cache-key"] === "string" && inputs["cache-key"].startsWith(prefix)).toBeTrue();
	});
});

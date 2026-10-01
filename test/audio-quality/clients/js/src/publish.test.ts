import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../../../publish.sh", import.meta.url));

function publish(profile: string) {
	const out = mkdtempSync(join(tmpdir(), "moq-audio-publisher-"));
	try {
		const result = spawnSync(
			"bash",
			[
				"-c",
				'set -euo pipefail; source "$1"; ffmpeg() { printf "%s\\n" "$@" > "$OUT/ffmpeg"; }; moq() { printf "%s\\n" "$@" > "$OUT/moq"; }; publish_aac "$2"',
				"publish-test",
				script,
				profile,
			],
			{
				encoding: "utf8",
				env: { ...process.env, OUT: out, MEDIA: "movie.mp4", MOQ: "moq", RELAY_URL: "http://relay" },
			},
		);
		expect(result.status).toBe(0);
		return {
			ffmpeg: readFileSync(join(out, "ffmpeg"), "utf8").trim().split("\n"),
			moq: readFileSync(join(out, "moq"), "utf8").trim().split("\n"),
		};
	} finally {
		rmSync(out, { recursive: true, force: true });
	}
}

test("the fixed 250 ms control flushes each AAC frame without changing its encode", () => {
	const result = publish("fixed-250");
	expect(result.ffmpeg).toEqual([
		"-hide_banner",
		"-v",
		"quiet",
		"-stream_loop",
		"-1",
		"-re",
		"-readrate_catchup",
		"1",
		"-i",
		"movie.mp4",
		"-c:v",
		"copy",
		"-c:a",
		"aac",
		"-ar",
		"44100",
		"-ac",
		"2",
		"-b:a",
		"128k",
		"-max_delay",
		"0",
		"-f",
		"mpegts",
		"-",
	]);
	expect(result.moq).toEqual(["--connect", "http://relay", "--broadcast", "bbb-aac-paced.hang", "import", "ts"]);
});

for (const profile of ["near-zero", "mild", "bursty", "step", "high-rtt"]) {
	test(`${profile} keeps the default AAC PES packing`, () => {
		const result = publish(profile);
		expect(result.ffmpeg).toEqual([
			"-hide_banner",
			"-v",
			"quiet",
			"-stream_loop",
			"-1",
			"-re",
			"-readrate_catchup",
			"1",
			"-i",
			"movie.mp4",
			"-c:v",
			"copy",
			"-c:a",
			"aac",
			"-ar",
			"44100",
			"-ac",
			"2",
			"-b:a",
			"128k",
			"-f",
			"mpegts",
			"-",
		]);
		expect(result.moq).toEqual(["--connect", "http://relay", "--broadcast", "bbb-aac.hang", "import", "ts"]);
	});
}

test("the matrix starts one publisher per source and routes every profile to that source", () => {
	const out = mkdtempSync(join(tmpdir(), "moq-audio-publishers-"));
	try {
		const result = spawnSync(
			"bash",
			[
				"-c",
				`
set -euo pipefail
source "$1"
CODECS=(opus aac)
PROFILES=(near-zero mild bursty step high-rtt fixed-250)
ffmpeg() { :; }
moq() { printf '%s\\n' "$@" >> "$OUT/moq"; }
harness_spawn() { printf '%s\\n' "$1" "$3" "$4" >> "$OUT/spawn"; shift 2; "$@"; }
start_publishers
for codec in "\${CODECS[@]}"; do
    for profile in "\${PROFILES[@]}"; do
        printf '%s %s %s\\n' "$codec" "$profile" "$(broadcast_of "$codec" "$profile")" >> "$OUT/routes"
    done
done
`,
				"publishers-test",
				script,
			],
			{
				encoding: "utf8",
				env: {
					...process.env,
					OUT: out,
					HARNESS_RUN: out,
					MEDIA: "movie.mp4",
					MOQ: "moq",
					RELAY_URL: "http://relay",
				},
			},
		);
		expect(result.status).toBe(0);
		expect(readFileSync(join(out, "spawn"), "utf8").trim().split("\n")).toEqual([
			"pub-opus",
			"publish_opus",
			"near-zero",
			"pub-aac",
			"publish_aac",
			"near-zero",
			"pub-aac-paced",
			"publish_aac",
			"fixed-250",
		]);
		expect(readFileSync(join(out, "moq"), "utf8").trim().split("\n")).toEqual([
			"--connect",
			"http://relay",
			"--broadcast",
			"bbb-opus.hang",
			"import",
			"fmp4",
			"--connect",
			"http://relay",
			"--broadcast",
			"bbb-aac.hang",
			"import",
			"ts",
			"--connect",
			"http://relay",
			"--broadcast",
			"bbb-aac-paced.hang",
			"import",
			"ts",
		]);
		expect(readFileSync(join(out, "routes"), "utf8").trim().split("\n")).toEqual([
			"opus near-zero bbb-opus.hang",
			"opus mild bbb-opus.hang",
			"opus bursty bbb-opus.hang",
			"opus step bbb-opus.hang",
			"opus high-rtt bbb-opus.hang",
			"opus fixed-250 bbb-opus.hang",
			"aac near-zero bbb-aac.hang",
			"aac mild bbb-aac.hang",
			"aac bursty bbb-aac.hang",
			"aac step bbb-aac.hang",
			"aac high-rtt bbb-aac.hang",
			"aac fixed-250 bbb-aac-paced.hang",
		]);
	} finally {
		rmSync(out, { recursive: true, force: true });
	}
});

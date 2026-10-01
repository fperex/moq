/** Check the real audio-quality driver's page-close and trace lifetime, without playing or grading media. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const run = mkdtempSync(join(process.env.MOQ_TEST_RUN ?? tmpdir(), "trace-retention-"));
const page = join(run, "page");
const out = join(run, "driver");
const marker = "quality-trace-page-close-fixture";
const beacon = "quality-trace-pagehide";

// Only the DOM status is synthetic. The actual driver owns Chromium, page closure and tracing.
await Bun.write(
	join(page, "index.html"),
	`<!doctype html><body><div>${marker}</div><pre id="status"></pre><script>
document.getElementById("status").textContent = JSON.stringify({
  crossOriginIsolated: false, transport: "webtransport", thread: {kind: "main"},
  backend: "message", timestamp: 1, stalled: false
});
addEventListener("pagehide", () => navigator.sendBeacon(
  new URLSearchParams(location.search).get("sink"), "${beacon}"
));
</script></body>`,
);

const beacons: string[] = [];
const sink = Bun.serve({
	port: 0,
	async fetch(request) {
		beacons.push(await request.text());
		return new Response(null, { status: 204 });
	},
});

let driverExit: number;
try {
	const driver = Bun.spawn(
		[
			process.execPath,
			resolve(import.meta.dir, "../../../audio-quality/clients/js/driver.ts"),
			"--url",
			"http://127.0.0.1:1",
			"--broadcast",
			"trace-fixture.hang",
			"--page",
			page,
			"--tag",
			"trace-retention",
			"--out",
			out,
			"--sink",
			`http://127.0.0.1:${sink.port}/pagehide`,
			"--offload",
			"false",
			"--duration",
			"1",
		],
		{
			env: { ...process.env, MOQ_TEST_RUN: out },
			stdout: Bun.file(join(run, "driver.stdout.log")),
			stderr: Bun.file(join(run, "driver.stderr.log")),
		},
	);
	driverExit = await driver.exited;
} finally {
	sink.stop(true);
}

await Bun.write(join(run, "page-close.json"), JSON.stringify({ driverExit, beacons }, null, 2));
if (driverExit !== 0) throw new Error(`trace fixture driver exited ${driverExit}; see ${run}`);
if (JSON.stringify(beacons) !== JSON.stringify([beacon])) {
	throw new Error(`page close did not flush its literal pagehide beacon: ${JSON.stringify(beacons)}; see ${run}`);
}

// Python is already an interop prerequisite. Inspect actual snapshot records, not just ZIP existence.
const inspect = Bun.spawn(
	[
		"python3",
		"-c",
		`import glob, json, sys, zipfile
paths = glob.glob(sys.argv[1] + "/*.trace.zip")
assert len(paths) == 1, "expected one saved driver trace after successful page close, got " + repr(paths)
with zipfile.ZipFile(paths[0]) as trace:
    snapshots = []
    closes = set()
    completed = set()
    for name in trace.namelist():
        if not name.endswith(".trace"):
            continue
        for line in trace.read(name).splitlines():
            event = json.loads(line)
            if event.get("type") == "frame-snapshot" and sys.argv[2] in json.dumps(event.get("snapshot", {}).get("html")):
                snapshots.append(name)
            if event.get("type") == "before" and event.get("class") == "Page" and event.get("method") == "close":
                closes.add(event["callId"])
            if event.get("type") == "after" and "error" not in event:
                completed.add(event["callId"])
    assert snapshots, "saved trace has no DOM snapshot of the fixture marker"
    assert closes & completed, "trace was saved before successful page closure"
    print(json.dumps({"trace": paths[0], "snapshotEntries": sorted(set(snapshots)), "pageCloseCompleted": True}))
`,
		out,
		marker,
	],
	{ stdout: "pipe", stderr: "pipe" },
);
const [inspection, errors, inspectionExit] = await Promise.all([
	new Response(inspect.stdout).text(),
	new Response(inspect.stderr).text(),
	inspect.exited,
]);
await Bun.write(join(run, "trace-inspection.log"), inspection + errors);
if (inspectionExit !== 0) throw new Error(`trace inspection failed: ${errors.trim()}; see ${run}`);
console.log(`trace retention: driver exited 0, pagehide flushed, fixture snapshot saved; ${inspection.trim()}`);

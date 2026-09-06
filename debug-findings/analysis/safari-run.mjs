// Safari confirmation: relay + native bbb publisher spawned here, Safari opened on the harness
// watcher (?gesture=1), the start button pressed through System Events (a real user activation),
// one preset per invocation. Beacons land via the sink as <tag>/watch-<preset>.ndjson.
// bun safari-run.mjs --tag=e3b-safari --preset=auto --hold=45 --vite=5174 --relayBin=... --relayCwd=... --moq=... --bbb=...
import { execFile, spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { promisify } from "node:util";
const exec = promisify(execFile);
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.match(/^--([^=]+)=(.*)$/)?.slice(1) ?? [a, true]));
const TAG = args.tag ?? "e3b-safari";
const PRESET = args.preset ?? "auto";
const HOLD = Number(args.hold ?? 45) * 1000;
const VITE = Number(args.vite ?? 5174);
const RUN = `${new URL("../runs", import.meta.url).pathname}/${TAG}`;
mkdirSync(RUN, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const children = [];
async function waitFor(desc, fn, timeoutMs = 30000, everyMs = 500) {
	const t0 = Date.now();
	for (;;) {
		try {
			if (await fn()) return;
		} catch {}
		if (Date.now() - t0 > timeoutMs) throw new Error(`timeout: ${desc}`);
		await sleep(everyMs);
	}
}
try {
	if (args.relayBin) {
		const log = openSync(`${RUN}/relay-${PRESET}.log`, "w");
		children.push(spawn(args.relayBin, ["localhost.toml"], { cwd: args.relayCwd, stdio: ["ignore", log, log], env: { ...process.env, RUST_LOG: "info,moq_net=debug" } }));
		await waitFor("relay", async () => (await fetch("http://localhost:4443/certificate.sha256")).ok);
		const plog = openSync(`${RUN}/pub-${PRESET}.log`, "w");
		const cmd = `ffmpeg -hide_banner -v quiet -stream_loop -1 -re -i ${args.bbb} -c copy -f mp4 -movflags cmaf+separate_moof+delay_moov+skip_trailer+frag_every_frame - | ${args.moq} --connect http://localhost:4443 --broadcast bbb.hang import fmp4`;
		children.push(spawn("sh", ["-c", cmd], { stdio: ["ignore", plog, plog], detached: true }));
		await sleep(6000);
	}
	const url = `http://localhost:${VITE}/harness.html?role=watch&url=${encodeURIComponent(args.relay ?? "http://localhost:4443")}&name=${encodeURIComponent(args.name ?? "bbb.hang")}&delay=${PRESET}&gesture=1${args.embed ? "&embed=1" : ""}&beacon=${TAG}.watch-${PRESET}`;
	await exec("open", ["-a", "Safari", url]);
	console.log("safari opened", url);
	await sleep(4000);
	// Press the start button (AXPress on the AXButton named "start audio"), retrying: the AX tree is flaky.
	const script = `tell application "Safari" to activate
delay 1
tell application "System Events"
	tell process "Safari"
		repeat with b in (entire contents of window 1)
			try
				if role of b is "AXButton" then
					set n to ""
					try
						set n to name of b
					end try
					set d to ""
					try
						set d to description of b
					end try
					set t to ""
					try
						set t to title of b
					end try
					if (n contains "start audio") or (d contains "start audio") or (t contains "start audio") then
						perform action "AXPress" of b
						return "pressed"
					end if
				end if
			end try
		end repeat
	end tell
end tell
return "not found"`;
	let pressed = "";
	for (let i = 0; i < 10 && pressed !== "pressed"; i++) {
		pressed = (await exec("osascript", ["-e", script])).stdout.trim();
		console.log("gesture:", pressed);
		if (pressed !== "pressed") await sleep(2000);
	}
	await sleep(HOLD);
	console.log("hold done; closing our tab");
	await exec("osascript", ["-e", `tell application "Safari" to close (every tab of every window whose URL contains "localhost:${VITE}/harness.html")`]).catch((e) => console.error("close failed:", e.message));
	await sleep(1500);
} finally {
	for (const c of children.reverse()) {
		try {
			process.kill(-c.pid, "SIGTERM");
		} catch {
			try {
				c.kill("SIGTERM");
			} catch {}
		}
	}
}

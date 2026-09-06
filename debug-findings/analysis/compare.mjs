// Before/after table across benchmark variants. bun compare.mjs <runs dir> <variant...>
// Reads <runs>/<variant>-<scenario>/summary.json (from analyze.mjs) and prints one row per
// scenario/preset with underrun episodes/min, silence ms/min, discarded ms/min, resolved delay.
import { existsSync, readFileSync, readdirSync } from "node:fs";
const [RUNS, ...VARIANTS] = process.argv.slice(2);
const scenarios = ["local-fmp4-iso", "local-fmp4-post", "local-ts-post", "remote-post", "ownpub-remote"];
// silent % = underrun silence plus time the ring sat re-stalled (F2 refills), over the window.
const silent = (s) => {
	const stalled = (s.worklet.stalledQuantaFrac ?? 0) / 100;
	const under = s.underruns.totalMsPerMin / 60000;
	return Math.round(1000 * (under + stalled)) / 10;
};
const cell = (s) => (s ? `${s.underruns.perMin} / ${silent(s)}% / ${Math.round(s.skips.totalMsPerMin)} @${s.resolved.delay}` : "n/a");
console.log(`| scenario | preset | ${VARIANTS.join(" | ")} |`);
console.log(`|---|---|${VARIANTS.map(() => "---").join("|")}|`);
for (const sc of scenarios) {
	const presets = new Set();
	const data = {};
	for (const v of VARIANTS) {
		const f = `${RUNS}/${v}-${sc}/summary.json`;
		if (!existsSync(f)) continue;
		data[v] = JSON.parse(readFileSync(f, "utf8")).presets;
		for (const p of Object.keys(data[v])) presets.add(p);
	}
	for (const p of [...presets].sort((a, b) => (a === "auto" ? -1 : b === "auto" ? 1 : Number.parseInt(a) - Number.parseInt(b)))) {
		console.log(`| ${sc} | ${p} | ${VARIANTS.map((v) => cell(data[v]?.[p])).join(" | ")} |`);
	}
}
console.log("\ncells: underrun episodes/min / silent % of time (underruns + refill stalls) / discarded ms/min @resolved delay ms");

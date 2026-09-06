// E6: replay a recorded insert trace through the real SharedRingBuffer at several targets.
//
// bun replay.ts <run dir>/watch-<preset>.ndjson [--targets=20,43,60,80,100,150,250,500,1000]
//   [--synthetic=<chunkMs>:<sigmaMs>:<burst>:<seconds>]  (ignore the trace; generate arrivals)
//
// The reader consumes one 128-sample quantum per 128/rate seconds of wall time, exactly like the
// worklet; inserts land at the wall time the trace recorded (decoder output -> ring insert), with
// the trace's own timestamps. The trace's arrival times are independent of the ring state in live
// mode (no backpressure), so replaying them at another target is a fair counterfactual.
import { readFileSync } from "node:fs";
import { allocSharedRingBuffer, SharedRingBuffer } from "../../js/watch/src/audio/shared-ring-buffer.ts";

const file = process.argv[2];
const opts = Object.fromEntries(process.argv.slice(3).map((a) => a.replace(/^--/, "").split("=")));
const targets = String(opts.targets ?? "20,30,43,60,80,100,150,250,500,1000").split(",").map(Number);
const warmupMs = Number(opts.warmup ?? 5000);

type Ins = { e: number; ts: number; n: number };
function loadTrace(path: string): { rate: number; ins: Ins[] } {
	const ev: Record<string, unknown>[] = [];
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			ev.push(...(JSON.parse(line).ev ?? []));
		} catch {}
	}
	ev.sort((a, b) => (a.e as number) - (b.e as number));
	const create = ev.filter((e) => e.k === "ring.create").at(-1);
	const rate = (create?.rate as number) ?? 48000;
	const ins = ev.filter((e) => e.k === "ins").map((e) => ({ e: e.e as number, ts: e.ts as number, n: e.n as number }));
	return { rate, ins };
}

function synthetic(spec: string, rate: number): Ins[] {
	const [chunkMs, sigmaMs, burst, seconds] = spec.split(":").map(Number);
	const out: Ins[] = [];
	const n = Math.round((rate * chunkMs) / 1000);
	let ts = 1_000_000;
	const t0 = 1000;
	// Gaussian jitter via Box-Muller, plus optional burst grouping (every `burst` chunks arrive together).
	const gauss = () => Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
	for (let i = 0; i * chunkMs < seconds * 1000; i++) {
		const nominal = t0 + i * chunkMs;
		const group = burst > 1 ? Math.floor(i / burst) * burst + (burst - 1) : i;
		const e = t0 + group * chunkMs + Math.max(0, sigmaMs * gauss() + 2 * sigmaMs);
		out.push({ e, ts, n });
		ts += (n / rate) * 1e6;
	}
	return out.sort((a, b) => a.e - b.e);
}

function replay(rate: number, ins: Ins[], targetMs: number) {
	const latency = Math.max(128, Math.ceil((rate * targetMs) / 1000));
	const ring = new SharedRingBuffer(allocSharedRingBuffer(2, Math.max(rate, latency * 2), rate, false));
	ring.setLatency(latency);
	const quantumMs = (128 / rate) * 1000;
	const out = [new Float32Array(128), new Float32Array(128)];
	let underrun = 0;
	let underrunEpisodes = 0;
	let inUnder = false;
	let stalledQuanta = 0;
	let reads = 0;
	const t0 = ins[0].e;
	const tEnd = ins.at(-1)!.e;
	let nextRead = t0;
	let i = 0;
	const chunk = (n: number) => [new Float32Array(n).fill(0.5), new Float32Array(n).fill(0.5)];
	for (let t = t0; t <= tEnd; ) {
		// Deliver every insert due before the next read tick.
		while (i < ins.length && ins[i].e <= nextRead) {
			ring.insert(ins[i].ts as never, chunk(ins[i].n));
			i++;
		}
		t = nextRead;
		nextRead += quantumMs;
		if (t < t0 + warmupMs) {
			ring.read(out);
			continue;
		}
		const stalled = ring.stalled;
		const got = ring.read(out);
		reads++;
		if (stalled) {
			stalledQuanta++;
			continue;
		}
		if (got < 128) {
			underrun += 128 - got;
			if (!inUnder) {
				inUnder = true;
				underrunEpisodes++;
			}
		} else inUnder = false;
	}
	const minutes = (tEnd - t0 - warmupMs) / 60000;
	return {
		targetMs,
		underrunEpisodesPerMin: Math.round(underrunEpisodes / minutes),
		underrunMsPerMin: Math.round((underrun / rate) * 1000 / minutes),
		skipsPerMin: Math.round(ring.skips / minutes),
		skippedMsPerMin: Math.round((ring.skipped / rate) * 1000 / minutes),
		stalledPct: Math.round((1000 * stalledQuanta) / Math.max(1, reads)) / 10,
	};
}

let rate = 48000;
let ins: Ins[];
if (opts.synthetic) ins = synthetic(String(opts.synthetic), rate);
else ({ rate, ins } = loadTrace(file));
console.log(`trace: ${ins.length} inserts, rate ${rate}, span ${((ins.at(-1)!.e - ins[0].e) / 1000).toFixed(1)} s`);
console.log("| target ms | underrun episodes/min | underrun ms/min | skips/min | skipped ms/min | stalled % |");
console.log("|---|---|---|---|---|---|");
for (const t of targets) {
	const r = replay(rate, ins, t);
	console.log(`| ${r.targetMs} | ${r.underrunEpisodesPerMin} | ${r.underrunMsPerMin} | ${r.skipsPerMin} | ${r.skippedMsPerMin} | ${r.stalledPct} |`);
}

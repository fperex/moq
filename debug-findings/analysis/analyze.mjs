// Analyzer: turns a run directory (sink NDJSON per tag + driver events) into per-preset metrics.
// bun analyze.mjs <run dir> <tag> [--warmup=5]
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";

const RUN = process.argv[2];
const TAG = RUN.replace(/\/+$/, "").split("/").pop();
const opts = Object.fromEntries(process.argv.slice(3).map((a) => a.replace(/^--/, "").split("=")));
const WARMUP = Number(opts.warmup ?? 5) * 1000;

function loadEvents(file) {
	const out = [];
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const batch = JSON.parse(line);
			for (const ev of batch.ev ?? []) out.push(ev);
		} catch {}
	}
	out.sort((a, b) => a.e - b.e);
	return out;
}

const pct = (arr, p) => {
	if (arr.length === 0) return null;
	const s = [...arr].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
// Pair each `a` with the `b` whose ts is nearest within `tol` microseconds (both sorted by ts).
function matchNearest(as, bs, tol) {
	const sb = [...bs].sort((x, y) => x.ts - y.ts);
	const out = [];
	let j = 0;
	for (const a of [...as].sort((x, y) => x.ts - y.ts)) {
		while (j + 1 < sb.length && Math.abs(sb[j + 1].ts - a.ts) <= Math.abs(sb[j].ts - a.ts)) j++;
		if (sb.length && Math.abs(sb[j].ts - a.ts) <= tol) out.push([a, sb[j]]);
	}
	return out;
}
// Least-squares slope of lateness over wall time, in ms per second: nonzero means the media clock
// is not tracking wall time (an invalid environment or a drifting source), not network jitter.
function slope(xs, ys) {
	const n = xs.length;
	if (n < 2) return null;
	const mx = xs.reduce((a, b) => a + b, 0) / n;
	const my = ys.reduce((a, b) => a + b, 0) / n;
	let num = 0;
	let den = 0;
	for (let i = 0; i < n; i++) {
		num += (xs[i] - mx) * (ys[i] - my);
		den += (xs[i] - mx) ** 2;
	}
	return den ? (num / den) * 1000 : null;
}
const r1 = (x) => (x === null || x === undefined || Number.isNaN(x) ? null : Math.round(x * 10) / 10);
const dist = (arr) => ({ n: arr.length, p50: r1(pct(arr, 50)), p90: r1(pct(arr, 90)), p99: r1(pct(arr, 99)), max: r1(pct(arr, 100)), min: r1(pct(arr, 0)) });

function analyzeWatcher(events, pubEvents) {
	const byK = (k) => events.filter((e) => e.k === k);
	const create = byK("ring.create").at(-1);
	const rate = create?.rate ?? 48000;
	const polls = byK("poll");
	const live = polls.find((p) => p.status === "live" && (p.abytes ?? 0) > 0);
	const t0 = (live?.e ?? events[0]?.e ?? 0) + WARMUP;
	const t1 = events.at(-1)?.e ?? t0;
	const inWin = (e) => e.e >= t0 && e.e <= t1;
	const win = events.filter(inWin);
	const wk = (k) => win.filter((e) => e.k === k);
	const minutes = Math.max(1e-9, (t1 - t0) / 60000);
	const msOf = (samples) => (samples / rate) * 1000;

	// Worklet window stats: underrun samples while not stalled, stalled quanta.
	const wstat = wk("wstat");
	const underMs = msOf(wstat.reduce((a, w) => a + (w.under ?? 0), 0));
	const stalledQ = wstat.reduce((a, w) => a + (w.stalledQ ?? 0), 0);
	const quanta = wstat.reduce((a, w) => a + (w.quanta ?? 0), 0);
	// Wall cadence of the worklet: 100 quanta should take 100*128/rate seconds.
	const wdt = [];
	for (let i = 1; i < wstat.length; i++) wdt.push(wstat[i].e - wstat[i - 1].e);
	const readGaps = wstat.map((w) => w.maxGapMs).filter((x) => typeof x === "number");
	const burstMax = wstat.map((w) => w.burstMax).filter((x) => typeof x === "number");
	const burstFrac = wstat.length && typeof wstat[0].burstQuanta === "number" ? (100 * wstat.reduce((a, w) => a + (w.burstQuanta ?? 0), 0)) / Math.max(1, quanta) : null;

	// Underrun episodes (excluding the initial stalled fill).
	const eps = [];
	let open;
	for (const e of win) {
		if (e.k === "under.start") open = e;
		else if (e.k === "under.end" && open) {
			if (!open.stalled) eps.push({ start: open.e, ms: msOf(e.samples), buffered: open.buffered });
			open = undefined;
		}
	}
	const skips = wk("skip").filter((s) => !s.stalled);
	// The worklet's cumulative `skipped` counter is the authoritative total (the post ring's
	// per-event posts were missing in some runs); fall back to per-event sums when absent.
	const skippedCum = wstat.map((w) => w.skipped).filter((x) => typeof x === "number" && x >= 0);
	// Sum positive deltas: a rebuilt ring restarts the counter.
	let skippedDelta = 0;
	for (let i = 1; i < skippedCum.length; i++) skippedDelta += Math.max(0, skippedCum[i] - skippedCum[i - 1]);
	const skipMs = skippedCum.length > 1 ? msOf(skippedDelta) : skips.reduce((a, s) => a + msOf(s.samples ?? 0), 0);

	// Insert-side view: buffered depth before each insert (0 = ring already dry) and arrival lateness.
	const ins = wk("ins").filter((i) => !i.stalled);
	const before = ins.map((i) => msOf(i.before));
	const lat = ins.map((i) => msOf(i.lat));
	const dry = ins.filter((i) => i.before <= 0).length;
	const L = ins.map((i) => i.e - i.ts / 1000);
	const insDrift = slope(ins.map((i) => i.e), L);
	const Ld = L.map((x, k) => x - ((insDrift ?? 0) / 1000) * (ins[k].e - (ins[0]?.e ?? 0)));
	const Lmin = Math.min(...Ld);
	const lateness = Ld.map((x) => x - Lmin);
	const chunkMs = ins.length ? msOf(pct(ins.map((i) => i.n), 50)) : null;

	// Network arrival at the decode loop and the decode latency for matched timestamps.
	const frames = wk("aud.frame");
	const decodeLat = matchNearest(ins, frames, 2000).map(([a, b]) => a.e - b.e);
	const Lnet = frames.map((f) => f.e - f.ts / 1000);
	const netDrift = slope(frames.map((f) => f.e), Lnet);
	const Lnd = Lnet.map((x, k) => x - ((netDrift ?? 0) / 1000) * (frames[k].e - (frames[0]?.e ?? 0)));
	const LnetMin = Math.min(...Lnd);
	const netLateness = Lnd.map((x) => x - LnetMin);
	const iat = [];
	for (let i = 1; i < frames.length; i++) iat.push(frames[i].e - frames[i - 1].e);

	// Publisher -> watcher one-way latency for matched timestamps (same machine, same clock).
	let owd = [];
	if (pubEvents) {
		owd = matchNearest(frames, pubEvents.filter((p) => p.k === "pub.aud"), 2000).map(([a, b]) => a.e - b.e);
	}

	// Sync (video/audio pacing) lateness.
	const sync = wk("sync");
	const late = (label) => sync.filter((s) => s.label === label && s.sleep < 0).map((s) => -s.sleep);
	const refChanges = wk("sync.ref").length;

	// Group-level drops.
	// The audio track is whichever container track produced the timestamps the audio decode loop saw.
	const grp = wk("grp");
	const frm = wk("frm");
	const audioTs = new Set(frames.map((f) => f.ts));
	const audioTrack = frm.find((f) => audioTs.has(f.ts))?.track ?? grp.find((g) => /audio/i.test(g.track))?.track;
	const grpAudio = grp.filter((g) => g.track === audioTrack).length;
	const grpVideo = grp.filter((g) => g.track !== audioTrack).length;

	const last = polls.at(-1) ?? {};
	const vfr = polls.filter(inWin).map((p) => p.vframes).filter((x) => x !== undefined);
	const fps = vfr.length > 1 ? (vfr.at(-1) - vfr[0]) / ((t1 - t0) / 1000) : null;
	const astalledFrac = polls.filter(inWin).length ? polls.filter(inWin).filter((p) => p.astalled).length / polls.filter(inWin).length : null;
	const vstalledFrac = polls.filter(inWin).length ? polls.filter(inWin).filter((p) => p.vstalled).length / polls.filter(inWin).length : null;
	const catalogAudio = polls.find((p) => p.catalogAudio)?.catalogAudio;
	const abuf = polls.filter(inWin).map((p) => p.abufMs).filter((x) => typeof x === "number" && x >= 0);
	const catalogChanges = wk("catalog").length;

	return {
		windowSec: r1((t1 - t0) / 1000),
		rate,
		ringTargetMs: r1(msOf(create?.latencySamples ?? 0)),
		lastTargetMs: lat.length ? r1(lat.at(-1)) : null,
		chunkMs: r1(chunkMs),
		resolved: { jitter: last.jitter, delay: last.delay, maxAge: last.maxAge, rtt: last.rtt, ajitter: last.ajitter, vjitter: last.vjitter, transport: last.transport, arate: last.arate },
		catalogAudio,
		worklet: { quanta, underrunMsPerMin: r1(underMs / minutes), stalledQuantaFrac: quanta ? r1((100 * stalledQ) / quanta) : null, windowWallMs: dist(wdt), readGapMs: dist(readGaps), readBurstMax: dist(burstMax), readBurstPct: r1(burstFrac) },
		underruns: { perMin: r1(eps.length / minutes), totalMsPerMin: r1(eps.reduce((a, x) => a + x.ms, 0) / minutes), episodeMs: dist(eps.map((x) => x.ms)) },
		skips: { perMin: r1(skips.length / minutes), totalMsPerMin: r1(skipMs / minutes), skipMs: dist(skips.map((s) => msOf(s.samples))) },
		inserts: { n: ins.length, driftMsPerS: r1(insDrift), dryFrac: ins.length ? r1((100 * dry) / ins.length) : null, bufferedBeforeMs: dist(before), arrivalLatenessMs: dist(lateness) },
		network: { frames: frames.length, driftMsPerS: r1(netDrift), latenessMs: dist(netLateness), interArrivalMs: dist(iat), decodeLatencyMs: dist(decodeLat), pubToWatchMs: dist(owd), audioTrack, audioGroups: grpAudio, videoGroups: grpVideo, groupSkips: wk("grp.skip").length, groupErrs: wk("grp.err").length, netStale: wk("net.stale").length },
		sync: { videoLatePerMin: r1(late("video").length / minutes), videoLateMs: dist(late("video")), audioLatePerMin: r1(late("audio").length / minutes), audioLateMs: dist(late("audio")), refChanges },
		poll: { abufMs: dist(abuf), catalogChanges, fps: r1(fps), astalledPct: r1(astalledFrac === null ? null : 100 * astalledFrac), vstalledPct: r1(vstalledFrac === null ? null : 100 * vstalledFrac), lastStatus: last.status },
		console: wk("console").filter((c) => c.level === "warn" || c.level === "error").slice(0, 20).map((c) => c.text.slice(0, 160)),
	};
}

const files = readdirSync(RUN).filter((f) => f.startsWith("watch-") && f.endsWith(".ndjson"));
const pubFile = `${RUN}/pub.ndjson`;
const pubEvents = existsSync(pubFile) ? loadEvents(pubFile) : undefined;
const summary = { tag: TAG, presets: {} };
for (const f of files.sort()) {
	const preset = f.slice("watch-".length, -".ndjson".length);
	summary.presets[preset] = analyzeWatcher(loadEvents(`${RUN}/${f}`), pubEvents);
}
if (pubEvents) {
	const pa = pubEvents.filter((p) => p.k === "pub.aud");
	const Lp = pa.map((p) => p.e - p.ts / 1000);
	const pubDrift = slope(pa.map((p) => p.e), Lp);
	const min = Math.min(...Lp);
	const iat = [];
	for (let i = 1; i < pa.length; i++) iat.push(pa[i].e - pa[i - 1].e);
	const pe = pubEvents.filter((p) => p.k === "pub.enc");
	const Le = pe.map((p) => p.e - p.ts / 1000);
	const encDrift = slope(pe.map((p) => p.e), Le);
	const encMin = Le.length ? Math.min(...Le) : 0;
	const encLat = matchNearest(pa, pe, 2000).map(([a, b]) => a.e - b.e);
	const wrote = pubEvents.filter((p) => p.k === "pub.wrote").map((p) => p.ms);
	const lagSeries = [];
	if (pa.length) {
		const t0 = pa[0].e;
		const buckets = new Map();
		for (const p of pa) {
			const b = Math.floor((p.e - t0) / 10000);
			if (!buckets.has(b)) buckets.set(b, []);
			buckets.get(b).push(p.e - p.ts / 1000 - min);
		}
		for (const [b, v] of [...buckets.entries()].sort((x, y) => x[0] - y[0])) lagSeries.push(`${b * 10}s:${Math.round(v.reduce((a, x) => a + x, 0) / v.length)}`);
	}
	summary.publisher = { audioChunks: pa.length, driftMsPerS: r1(pubDrift), writeFrameMs: dist(wrote), outputLagPer10s: lagSeries.join(" "), encodeInputs: pe.length, encodeInputDriftMsPerS: r1(encDrift), encodeInputLatenessMs: dist(Le.map((x) => x - encMin)), encodeQueue: dist(pe.map((p) => p.q ?? 0)), encodeLatencyMs: dist(encLat), emitLatenessMs: dist(Lp.map((x) => x - min)), interEmitMs: dist(iat) };
}
writeFileSync(`${RUN}/summary.json`, JSON.stringify(summary, null, 1));

// Markdown table.
const order = Object.keys(summary.presets);
const row = (label, f) => `| ${label} | ${order.map((p) => f(summary.presets[p]) ?? "").join(" | ")} |`;
const lines = [
	`| metric | ${order.join(" | ")} |`,
	`|---|${order.map(() => "---").join("|")}|`,
	row("resolved jitter/delay/maxAge ms", (s) => `${s.resolved.jitter}/${s.resolved.delay}/${s.resolved.maxAge}`),
	row("ring target ms (last)", (s) => s.lastTargetMs),
	row("chunk ms", (s) => s.chunkMs),
	row("underrun episodes /min", (s) => s.underruns.perMin),
	row("underrun ms /min", (s) => s.underruns.totalMsPerMin),
	row("underrun episode ms p50/p90/max", (s) => `${s.underruns.episodeMs.p50}/${s.underruns.episodeMs.p90}/${s.underruns.episodeMs.max}`),
	row("skips /min", (s) => s.skips.perMin),
	row("skipped ms /min", (s) => s.skips.totalMsPerMin),
	row("skip ms p50/p90/max", (s) => `${s.skips.skipMs.p50}/${s.skips.skipMs.p90}/${s.skips.skipMs.max}`),
	row("inserts into a dry ring %", (s) => s.inserts.dryFrac),
	row("buffered before insert ms p50/p90/min", (s) => `${s.inserts.bufferedBeforeMs.p50}/${s.inserts.bufferedBeforeMs.p90}/${s.inserts.bufferedBeforeMs.min}`),
	row("media clock drift ms/s (insert / net)", (s) => `${s.inserts.driftMsPerS} / ${s.network.driftMsPerS}`),
	row("insert arrival lateness ms p50/p90/p99/max", (s) => `${s.inserts.arrivalLatenessMs.p50}/${s.inserts.arrivalLatenessMs.p90}/${s.inserts.arrivalLatenessMs.p99}/${s.inserts.arrivalLatenessMs.max}`),
	row("net arrival lateness ms p50/p90/p99/max", (s) => `${s.network.latenessMs.p50}/${s.network.latenessMs.p90}/${s.network.latenessMs.p99}/${s.network.latenessMs.max}`),
	row("net inter-arrival ms p50/p90/p99/max", (s) => `${s.network.interArrivalMs.p50}/${s.network.interArrivalMs.p90}/${s.network.interArrivalMs.p99}/${s.network.interArrivalMs.max}`),
	row("decode latency ms p50/p90/max", (s) => `${s.network.decodeLatencyMs.p50}/${s.network.decodeLatencyMs.p90}/${s.network.decodeLatencyMs.max}`),
	row("pub->watch ms p50/p90/p99/max", (s) => `${s.network.pubToWatchMs.p50}/${s.network.pubToWatchMs.p90}/${s.network.pubToWatchMs.p99}/${s.network.pubToWatchMs.max}`),
	row("audio groups / video groups / group skips / net stale / errs", (s) => `${s.network.audioGroups}/${s.network.videoGroups}/${s.network.groupSkips}/${s.network.netStale}/${s.network.groupErrs}`),
	row("video late frames /min (max ms)", (s) => `${s.sync.videoLatePerMin} (${s.sync.videoLateMs.max})`),
	row("audio late frames /min (max ms)", (s) => `${s.sync.audioLatePerMin} (${s.sync.audioLateMs.max})`),
	row("sync reference changes", (s) => s.sync.refChanges),
	row("element audio buffered ms p10/p50/p90 (poll)", (s) => `${s.poll.abufMs.min}/${s.poll.abufMs.p50}/${s.poll.abufMs.p90}`),
	row("catalog changes seen", (s) => s.poll.catalogChanges),
	row("rendered fps / audio stalled % / video stalled %", (s) => `${s.poll.fps} / ${s.poll.astalledPct} / ${s.poll.vstalledPct}`),
	row("worklet read gap ms p50/max, burst quanta max, burst %", (s) => `${s.worklet.readGapMs.p50}/${s.worklet.readGapMs.max}, ${s.worklet.readBurstMax.max}, ${s.worklet.readBurstPct}`),
	row("worklet 100-quanta wall ms p50/max", (s) => `${s.worklet.windowWallMs.p50}/${s.worklet.windowWallMs.max}`),
	row("window s", (s) => s.windowSec),
];
if (summary.publisher) lines.push("", `publisher: ${JSON.stringify(summary.publisher)}`);
writeFileSync(`${RUN}/summary.md`, lines.join("\n"));
console.log(lines.join("\n"));

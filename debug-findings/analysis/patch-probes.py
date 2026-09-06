#!/usr/bin/env python3
"""Apply the throwaway rtprobe instrumentation to a moq worktree (js/ + demo/web).

Usage: patch-probes.py <worktree-root>
Every edit is an anchored insertion/replacement that must match exactly one line, so a
drifted tree fails loudly instead of silently probing the wrong place.
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(sys.argv[1])
import subprocess
subprocess.run(["git", "-C", str(ROOT), "checkout", "--", "js", "demo"], check=True)


def T(block: str) -> str:
    # Blocks below are written with 4-space indents; the repo uses tabs.
    return "\n".join(re.sub(r"^((?:    )+)", lambda m: "\t" * (len(m.group(1)) // 4), l) for l in block.strip("\n").split("\n"))


def _lines(p):
    return (ROOT / p).read_text().split("\n")


def _write(p, lines):
    (ROOT / p).write_text("\n".join(lines))


def _find(lines, anchor, exact):
    idx = [i for i, l in enumerate(lines) if (l == anchor if exact else anchor in l)]
    assert len(idx) == 1, f"anchor {anchor!r} matched {len(idx)} lines"
    return idx[0]


def _indent(line):
    return re.match(r"^\s*", line).group(0)


def _block(ind, new):
    return [ind + l if l else l for l in new.split("\n")]


def insert_after(p, anchor, new, exact=False, indent=None):
    lines = _lines(p)
    i = _find(lines, anchor, exact)
    ind = _indent(lines[i]) if indent is None else indent
    lines[i + 1 : i + 1] = _block(ind, new)
    _write(p, lines)


def insert_before(p, anchor, new, exact=False, indent=None):
    lines = _lines(p)
    i = _find(lines, anchor, exact)
    ind = _indent(lines[i]) if indent is None else indent
    lines[i:i] = _block(ind, new)
    _write(p, lines)


def replace_line(p, anchor, new, exact=False):
    lines = _lines(p)
    i = _find(lines, anchor, exact)
    lines[i : i + 1] = _block(_indent(lines[i]), new)
    _write(p, lines)


def replace_all(p, anchor, new):
    lines = _lines(p)
    idx = [i for i, l in enumerate(lines) if anchor in l]
    assert idx, anchor
    for i in reversed(idx):
        lines[i : i + 1] = _block(_indent(lines[i]), new)
    _write(p, lines)


HELPER = T('''
// rtprobe (throwaway diagnostics): the page defines globalThis.__rt; absent in tests.
type RtSink = { push: (k: string, o: Record<string, unknown>) => void };
const rtPush = (k: string, o: Record<string, unknown>) => (globalThis as { __rt?: RtSink }).__rt?.push(k, o);
''')

# ---- js/watch/src/audio/shared-ring-buffer.ts -------------------------------------------------
P = "js/watch/src/audio/shared-ring-buffer.ts"
insert_after(P, "\t#lastRead = 0;", T('''

// rtprobe (throwaway): skip accounting, read by the worklet.
skips = 0;
skipped = 0;
lastSkip?: { samples: number; buffered: number; latency: number };
'''), exact=True)
replace_line(P, "if (((skipTo - read) | 0) > 0) read = skipTo;", T('''
if (((skipTo - read) | 0) > 0) {
    this.skips++;
    this.skipped += (skipTo - read) | 0;
    this.lastSkip = { samples: (skipTo - read) | 0, buffered, latency };
    read = skipTo;
}
'''))
insert_before(P, "/** Whether the buffer is stalled (waiting to fill). */", T('''
/** rtprobe: the current target depth in samples. */
get latency(): number {
    return Atomics.load(this.#control, LATENCY);
}

'''))

# ---- js/watch/src/audio/ring-buffer.ts (postMessage fallback ring) ------------------------------
P = "js/watch/src/audio/ring-buffer.ts"
insert_after(P, "\t#anchored = false;", T('''

// rtprobe (throwaway): skip accounting, read by the worklet.
skips = 0;
skipped = 0;
lastSkip?: { samples: number; buffered: number; latency: number };
'''), exact=True)
replace_line(P, "this.#readIndex += overflow;", T('''
this.#readIndex += overflow;
this.skips++;
this.skipped += overflow;
this.lastSkip = { samples: overflow, buffered: this.#writeIndex - this.#readIndex, latency: this.#latencySamples };
'''))
insert_before(P, "get stalled(): boolean {", T('''
/** rtprobe: the current target depth in samples. */
get latency(): number {
    return this.#latencySamples;
}

'''))

# ---- js/watch/src/audio/render-worklet.ts ----------------------------------------------------
P = "js/watch/src/audio/render-worklet.ts"
insert_after(P, "\t#stateCounter = 0;", T('''
// rtprobe (throwaway)
#rtQuanta = 0;
#rtUnder = 0;
#rtUnderQ = 0;
#rtStalledQ = 0;
#rtEp = 0;
#rtInUnder = false;
#rtLastSkips = 0;
#rtLastCall = 0;
#rtMaxGap = 0;
#rtBurst = 0;
#rtBurstMax = 0;
#rtBurstCur = 0;
'''), exact=True)
insert_after(P, "const samplesRead = backend?.read(output) ?? 0;", "this.#rtProbe(backend, output[0].length, samplesRead);")
insert_before(P, "process(_inputs: Float32Array[][]", T('''
#rtPost(k: string, o: Record<string, unknown>) {
    this.port.postMessage({ type: "rt", k, cf: currentFrame, ct: currentTime, ...o });
}

#rtProbe(backend: SharedRingBuffer | AudioRingBuffer | undefined, want: number, got: number) {
    const buffered = backend?.length ?? -1;
    const stalled = backend?.stalled ?? true;
    this.#rtQuanta++;
    this.#rtCadence();
    if (stalled) this.#rtStalledQ++;
    this.#rtUnderrun(want - got, buffered, stalled);
    if (backend && backend.skips !== this.#rtLastSkips) {
        this.#rtLastSkips = backend.skips;
        this.#rtPost("skip", { ...backend.lastSkip, stalled, post: backend instanceof AudioRingBuffer });
    }
    if (this.#rtQuanta % 100 !== 0) return;
    this.#rtPost("wstat", {
        quanta: 100,
        maxGapMs: this.#rtMaxGap,
        burstQuanta: this.#rtBurst,
        burstMax: this.#rtBurstMax,
        under: this.#rtUnder,
        underQ: this.#rtUnderQ,
        stalledQ: this.#rtStalledQ,
        buffered,
        latency: backend?.latency ?? -1,
        skipped: backend?.skipped ?? -1,
        post: backend instanceof AudioRingBuffer,
    });
    this.#rtUnder = 0;
    this.#rtUnderQ = 0;
    this.#rtStalledQ = 0;
    this.#rtMaxGap = 0;
    this.#rtBurst = 0;
    this.#rtBurstMax = 0;
}

// Wall-clock cadence of process(): a device with a coarse buffer pulls several quanta back to
// back (gap < 1 ms) and then idles, which reads the ring in bursts.
#rtCadence() {
    const now = Date.now();
    const gap = this.#rtLastCall ? now - this.#rtLastCall : 0;
    this.#rtLastCall = now;
    if (gap > this.#rtMaxGap) this.#rtMaxGap = gap;
    if (gap < 1) {
        this.#rtBurst++;
        this.#rtBurstCur++;
        if (this.#rtBurstCur > this.#rtBurstMax) this.#rtBurstMax = this.#rtBurstCur;
    } else this.#rtBurstCur = 0;
}

#rtUnderrun(short: number, buffered: number, stalled: boolean) {
    if (short > 0) {
        this.#rtUnder += short;
        this.#rtUnderQ++;
        this.#rtEp += short;
        if (!this.#rtInUnder) {
            this.#rtInUnder = true;
            this.#rtPost("under.start", { buffered, stalled });
        }
        return;
    }
    if (!this.#rtInUnder) return;
    this.#rtInUnder = false;
    this.#rtPost("under.end", { samples: this.#rtEp, buffered, stalled });
    this.#rtEp = 0;
}

'''))

# ---- js/watch/src/audio/buffer.ts -------------------------------------------------------------
P = "js/watch/src/audio/buffer.ts"
insert_after(P, 'import { allocSharedRingBuffer, SharedRingBuffer } from "./shared-ring-buffer";', "\n" + HELPER, indent="")
insert_before(P, "// Poll the shared control array and reflect it into signals.", T('''
// rtprobe: worklet-side events (underruns, skips, window stats).
this.#signals.event(worklet.port, "message", (ev: Event) => {
    const d = (ev as MessageEvent<{ type?: string; k?: string }>).data;
    if (d?.type === "rt" && d.k) rtPush(`w.${d.k}`, d as Record<string, unknown>);
});
worklet.port.start();

'''))
replace_line(P, "this.#ring.insert(timestamp, data);", T('''
const before = this.#ring.length;
const stalled = this.#ring.stalled;
this.#ring.insert(timestamp, data);
rtPush("ins", {
    ts: timestamp,
    n: data[0].length,
    before,
    after: this.#ring.length,
    stalled,
    lat: this.#ring.latency,
    play: this.#ring.timestamp,
});
'''))
insert_after(P, "const data = (ev as MessageEvent<State>).data;", T('''
const rt = data as unknown as { type?: string; k?: string };
if (rt?.type === "rt" && rt.k) rtPush(`w.${rt.k}`, rt as Record<string, unknown>);
'''))
insert_after(P, 'const msg: Data = { type: "data", data, timestamp };', 'rtPush("ins", { ts: timestamp, n: data[0].length, post: true });')

# ---- js/watch/src/audio/decoder.ts ------------------------------------------------------------
P = "js/watch/src/audio/decoder.ts"
insert_after(P, 'import type { Source } from "./source";', "\n" + HELPER, indent="")
insert_after(P, "const latencySamples = ringSamples(sampleRate, delay);", 'rtPush("ring.create", { rate: sampleRate, channels: channelCount, latencySamples, delay });')
replace_line(P, "ring.setLatency(ringSamples(ring.rate, delay));", T('''
const samples = ringSamples(ring.rate, delay);
rtPush("ring.latency", { delay, samples });
ring.setLatency(samples);
'''))
replace_line(P, "if (floor > baseline) this.reset();", T('''
if (floor > baseline) {
    rtPush("ring.reanchor", { floor, baseline });
    this.reset();
}
'''))
replace_all(P, 'this.sync.received(timestamp, "audio");', T('''
this.sync.received(timestamp, "audio");
rtPush("aud.frame", { ts: frame.timestamp, bytes: frame.payload.byteLength });
'''))

# ---- js/watch/src/sync.ts ---------------------------------------------------------------------
P = "js/watch/src/sync.ts"
insert_after(P, 'from "@moq/signals";', "\n" + HELPER, indent="")
insert_after(P, "const sleep = Time.Milli.add(Time.Milli.sub(currentRef, ref), delay);", 'rtPush("sync", { label, ts: timestamp, sleep, ref, cur: currentRef, delay });')
insert_after(P, "this.#out.reference.set(ref);", 'rtPush("sync.ref", { ref });')

# ---- js/hang/src/container/consumer.ts --------------------------------------------------------
P = "js/hang/src/container/consumer.ts"
insert_after(P, 'import type { BufferedRanges, Frame } from "./types";', "\n" + HELPER, indent="")
insert_after(P, "if (!consumer) break;", 'rtPush("grp", { track: this.#track.name, seq: consumer.sequence });')
insert_before(P, "if (first.empty) this.#markDiscontinuity();", 'rtPush("grp.skip", { track: this.#track.name, from: first.consumer.sequence, to: this.#active, age, threshold });')
insert_after(P, "group.frames.push(frame);", 'rtPush("frm", { track: this.#track.name, seq: group.consumer.sequence, ts: frame.timestamp, bytes: frame.payload.byteLength });')
insert_after(P, "} catch (_err) {", 'rtPush("grp.err", { track: this.#track.name, seq: group.consumer.sequence, err: String(_err) });')

# ---- js/net/src/track.ts ----------------------------------------------------------------------
P = "js/net/src/track.ts"
insert_after(P, 'import { Timescale, type Timestamp } from "./time.ts";', "\n" + HELPER, indent="")
insert_after(P, "\t\t\tgroups.shift();", T('''
rtPush(this.#isStale(group, drift) ? "net.stale" : "net.group", {
    track: this.name,
    seq: group.sequence,
    budget: drift.budget,
    edge: drift.presentation?.sequence,
    edgeTs: drift.presentation?.timestamp.asMillis(),
});
'''), exact=True)

# ---- js/publish -------------------------------------------------------------------------------
P = "js/publish/src/audio/encoder.ts"
insert_after(P, 'import { Resampler } from "./resampler";', "\n" + HELPER, indent="")
insert_after(P, "this.#setDecoderDescription(config, metadata?.decoderConfig?.description);", 'rtPush("pub.aud", { ts: frame.timestamp, bytes: frame.byteLength, q: encoder.encodeQueueSize });\nconst rtWrite0 = performance.now();')
insert_after(P, "\t\t\t\t\t\t\ttimestamp: Time.Timestamp.fromMicros(frame.timestamp as Time.Micro),\n", "", exact=False) if False else None
insert_after(P, "\t\t\t\t\t\t});", 'rtPush("pub.wrote", { ts: frame.timestamp, ms: performance.now() - rtWrite0 });', exact=True)
insert_before(P, "\t\t\t\t\t\t\tencoder.encode(frame);", 'rtPush("pub.enc", { ts: frame.timestamp, q: encoder.encodeQueueSize });', exact=True)

P = "js/publish/src/video/encoder.ts"
insert_after(P, 'import { isStreamTrack, type Source } from "./types";', "\n" + HELPER, indent="")
insert_after(P, 'const key = frame.type === "key";', 'rtPush("pub.vid", { ts: frame.timestamp, bytes: frame.byteLength, key });')

P = "js/publish/src/audio/capture.ts"
insert_after(P, 'import { isSampleSource, normalizeSource, type SampleSource, type Source, type SourceConfig } from "./types";', "\n" + HELPER + "\nlet rtQuanta = 0;", indent="")
insert_after(P, "const channelCount = frame.channels.length;", 'if (++rtQuanta % 100 === 0) rtPush("pub.cap", { ts: frame.timestamp, quanta: 100 });')

# ---- demo/web/console-overlay.ts: event sink + beacon drain -----------------------------------
P = "demo/web/console-overlay.ts"
insert_before(P, "`;", T('''

// rtprobe (throwaway): structured event sink + beacon drain, see debug-findings/.
(() => {
    const params = new URLSearchParams(location.search);
    const tag = params.get("beacon");
    const rt = {
        ev: [],
        seq: 0,
        tag,
        push(k, o) {
            const e = Object.assign({ k, t: performance.now(), e: performance.timeOrigin + performance.now() }, o);
            rt.ev.push(e);
            if (rt.ev.length > 20000) rt.ev.splice(0, 5000);
        },
    };
    window.__rt = rt;
    sinks.add((entry) => rt.push("console", { level: entry.level, text: entry.text.slice(0, 400) }));
    if (!tag) return;
    const SINK = "http://127.0.0.1:18787/log";
    const flush = () => {
        if (rt.ev.length === 0) return;
        const batch = rt.ev.splice(0, rt.ev.length);
        for (let i = 0; i < batch.length; i += 200) {
            const body = JSON.stringify({
                tag,
                page: location.pathname + location.search,
                seq: rt.seq++,
                e: performance.timeOrigin + performance.now(),
                ev: batch.slice(i, i + 200),
            });
            try {
                navigator.sendBeacon(SINK, body);
            } catch {}
        }
    };
    rt.push("hb", { text: "beacon-init", origin: performance.timeOrigin, ua: navigator.userAgent });
    setInterval(() => {
        rt.push("hb", { text: "heartbeat" });
        flush();
    }, 1000);
    window.addEventListener("pagehide", flush);
})();
'''), exact=True, indent="")

# ---- DIAGNOSTIC WORKAROUND (not a fix proposal): dev's media.ts sends a fractional maxAge to the
# u53 varint and every SUBSCRIBE throws in auto mode on a real RTT. main rounds with Math.ceil in
# audio/subscription.ts; mirror that here so the ring behaviour behind the bug can be measured.
P = "js/watch/src/media.ts"
replace_line(P, "const subscription = () => ({ priority: props.priority, maxAge: props.maxAge.peek() });",
    "const subscription = () => ({ priority: props.priority, maxAge: Math.ceil(props.maxAge.peek()) }); // rtprobe workaround")
replace_line(P, "subscriber.update({ priority: props.priority, maxAge: inner.get(props.maxAge) });",
    "subscriber.update({ priority: props.priority, maxAge: Math.ceil(inner.get(props.maxAge)) }); // rtprobe workaround")

# ---- demo/web/vite.config.ts: MOQ_NO_ISOLATION=1 drops COOP/COEP (how moq.watch is deployed) ------
P = "demo/web/vite.config.ts"
replace_line(P, "\t\tcrossOriginIsolation(),", T('''
// rtprobe: MOQ_NO_ISOLATION=1 serves the demo without COOP/COEP, the way moq.watch is deployed,
// so the postMessage audio ring can be measured.
...(process.env.MOQ_NO_ISOLATION ? [] : [crossOriginIsolation()]),
'''), exact=True)

print("probes applied")

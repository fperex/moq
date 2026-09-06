# debug-findings: realtime audio/video stutter investigation

## How to read this branch

This branch (`debug/rt-audio`, on `upstream/dev` 30ef2a3de) is the evidence behind moq-dev/moq #3477, #3478 and #3479. It is not a pull request and asks nothing of the maintainers; it exists so every number in those issues can be reproduced and every trace can be re-read.

Commits, oldest first:
1. Instrumentation: timestamp probes at every hand-off, the bare-element harness page, the `MOQ_NO_ISOLATION` switch that drops COOP/COEP (postMessage ring, the production path), and a local complexity gate (`biome.jsonc` override plus a `CLAUDE.md` line; a working rule for this branch, not a proposal).
2. Prototype switches, page-load `?rt=f2,f3,f4`, all off = upstream behaviour byte for byte: F2 ring hysteresis and re-stall after an underrun (`js/watch/src/audio/shared-ring-buffer.ts`, `ring-buffer.ts`); F3 advertised `jitter` 0 treated as absent and the audio graph keyed on sample rate and channels only (`source.ts`, `decoder.ts`); F4 auto jitter from the measured arrival lateness (`sync.ts`). Plus the complexity splits those files needed.
3. This folder.

Where the probes are: `js/publish/src/audio/capture.ts`, `audio/encoder.ts`, `video/encoder.ts` (capture, encoder in/out, writeFrame); `js/net/src/track.ts` (group open, stale drop); `js/hang/src/container/consumer.ts` (groups, frames, skips); `js/watch/src/audio/{decoder,render,render-worklet,buffer,source}.ts` and the two rings (decoder output, ring insert, worklet `read()` underruns, skip-aheads, read cadence); `js/watch/src/sync.ts` (reference, per-frame lateness); `js/watch/src/media.ts` (the labelled diagnostic `Math.ceil` on the wire `maxAge`, #3478). `demo/web/console-overlay.ts` defines `window.__rt`, drains it to the beacon sink and parses `?rt=`; `demo/web/src/harness.{html,ts}` is the bare-element page (`?role=publish|watch|embed&url=&name=&delay=&beacon=<run>.<stream>[&gesture=1][&invisible=1][&embed=1]`); `demo/web/src/enc-bench.html` is the standalone AudioEncoder check.

Running it (see the header comment of each script): `analysis/sink.ts` receives the beacons (bun, `RT_RUN_DIR`); `analysis/run.mjs` drives a headed Chrome over CDP, one watcher tab per preset; `analysis/bench.sh <variant> "<flags>"` runs the five benchmark scenarios; `analysis/analyze.mjs <run dir>` prints the metric table; `analysis/compare.mjs` builds `before-after-table.md`; `analysis/replay.ts` replays a recorded trace or synthetic arrivals through the real `SharedRingBuffer`; `analysis/blackbox.js` is the public-API probe (playhead plateaus, AnalyserNode silence share); `analysis/patch-probes.py` re-applies the probes to a clean tree (anchored, self-reverting), followed by `harness-catalog.py`; `safari-run.mjs`, `inspect-moqwatch.mjs`, `enc-bench.mjs` are the Safari runner, the deployed-build reader and the encoder benchmark. Needs a headed Chrome started with only `--use-fake-ui-for-media-stream` (real devices; the fake microphone is not usable for timing, see notes), `moq` and `moq-relay` binaries (`MOQ_BIN_DIR`), ffmpeg, bun and node.

Data: `runs/<tag>/` holds one directory per measurement run (driver, relay and publisher logs, `events.json`, `summary.json`, `summary.md`); the raw per-tab `*.ndjson` event traces are too large for git and are attached as one tarball to the release https://github.com/fperex/moq/releases/tag/rt-audio-traces-2026-09-06 (same layout, `runs/<tag>/<stream>.ndjson`). `analysis/*.summary.md` are the per-run tables, `analysis/before-after.md` and `before-after-table.md` the four-variant comparison (as shipped, F2, F2+F3, F2+F3+F4), `analysis/bench-baseline.md` the refactored-tree baseline.

Notes: `notes/findings.md` is the chronological log with every number's origin, `notes/disproven.md` the theories that were tested and dropped. Issue texts as posted: `issue/posted.md` (#3477), `issue/b-varint.md` (#3478), `issue/c-catalog.md` (#3479). The moq.dev site page was measured from a local checkout of `moq-dev/moq.dev` (`sites/watch`, `@moq/watch ^0.4.3`); that checkout is not part of this branch.

## Working notes (kept as written during the investigation)

Started 2026-09-06. Goal: evidence for upstream issues on moq-dev/moq (diagnosis only).

Tree state at start: local dev c0f75b36f (js/ and demo/ identical to upstream/dev 511d20ce1),
upstream/main 842ef8f09 (moq.watch lineage). Instrumentation lives in this branch
(debug/rt-audio, started on upstream/dev 511d20ce1, rebased on 30ef2a3de).

Layout
- notes/      findings log, decisions, disproven theories
- runs/       one directory per measurement run (relay.log, beacons, CSV, summary.json)
- analysis/   scripts and tables
- issue/      the draft issue text

Run ledger (append one line per run)
- smoke, smoke-headed: pipeline validation (fake mic publisher; publisher clock invalid, see notes)
- p0-focus-pub / p0-focus-watch / p1-focus-pub: JS publisher encoder backlog with the fake mic (foreground vs background tab; encoder-input probe)
- e2-smoke: native bbb, auto, 20 s (mechanism visible: 388 underruns/min, 336 skips/min)
- e2-bbb-local: native bbb, auto/100/250/500/1000 ms, 90 s each (the watcher-side matrix)
- moqwatch-inspect.json: deployed moq.watch (main lineage) reading the public bbb: RTT 40, jitter 50, delay 53, catalog jitter 0
- p2-audio-only: JS publisher with video disabled (is the encoder backlog video-induced?)
- e5-remote-bbb: instrumented watcher on https://cdn.moq.pro/demo bbb.hang, auto/100/250/500, 60 s each
- e5-remote-auto-a/b: remote auto with the diagnostic ceil (Issue B workaround), 60 s each
- p3-real-mic: JS publisher with the real (BT) microphone in a headed Chrome, publisher foreground
- enc-bench.log: standalone WebCodecs Opus AudioEncoder benchmark (fake-mic backlog cross-check)
- e5b-own-pub-remote: own JS publisher (real mic) -> cdn.moq.dev/anon -> own watcher, auto and 500 ms
- p4-local-faithful: own publisher, real USB mic+camera, publisher tab background, local relay, auto/100/500
- e3b-safari: Safari watcher (WebSocket) on the native bbb, auto and 500ms
- p5-churn: local churn repro for the encoder-output lag (three sequential auto watchers, real mic)
- moqwatch-inspect.json / analysis/*.summary.md: per-run metric tables
- e8-userchrome: a normal Chrome profile (extension-driven), shipped demo watch page, auto vs 500ms
- Use case 2 (moq.watch embedding): a2-embed-remote-{iso,post}, a2-embed-local-{iso,post}, a4-ts-{default,pes0}, a3-site-{remote,local}, a2-embed-safari-post
- Phase B benchmarks: {baseline,f2,f23,f234}-{local-fmp4-iso,local-fmp4-post,local-ts-post,remote-post,ownpub-remote}; analysis/compare.mjs builds the before/after table
- phaseb-check.log / phaseb-test.log: the full JS gates on the Phase B tree (both pass)
- analysis/before-after.md: the final four-variant comparison (baseline, F2, F2+F3, F2+F3+F4) with the reading; before-after-table.md is the raw table
- worktree debug/rt-audio commits: 228a11199 (instrumentation baseline), 7dc07d46d (Phase B prototypes behind ?rt= flags)
- Filed: moq-dev/moq#3477 (A: ring + auto sizing, body issue/posted.md = a-ring.md, rewritten 2026-09-06 with environment, relay exoneration, no-churn encoder lag, methodology), #3478 (B: dev fractional maxAge varint throw, issue/b-varint.md), #3479 (C: fmp4 jitter running minimum -> 0 + AudioContext rebuild per catalog republish, issue/c-catalog.md)

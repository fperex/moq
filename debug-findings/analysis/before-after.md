# Before/after: prototype fixes on the instrumented dev worktree (debug/rt-audio)

Variants are cumulative page-load flags on ONE build (`?rt=f2`, `f2,f3`, `f2,f3,f4`), so "baseline"
is the same code with the flags off. Every cell: underrun episodes/min / silence ms/min / discarded
ms/min @resolved delay ms, 60 s per preset after a 5 s warm-up, exact moq.watch DOM, both rings
where named. Scenarios: local fmp4 bbb (2-chunk pacing), local TS import with default PES packing
(7-frame bursts, the public stream's shape), the public relay (cdn.moq.pro), own real-mic publisher
over the public relay (source-side lag confound, see findings.md).

- F2: ring hysteresis (skip only past target + one chunk) and re-stall on underrun (both rings).
- F3: catalog jitter 0 treated as absent; audio graph keyed on rate/channels only.
- F4: auto jitter = max(RTT term, measured arrival-lateness p99 + one chunk), grow fast, shrink slow.

## Deterministic replay (real SharedRingBuffer, recorded traces), upstream vs F2

| trace | target | upstream: underruns/min, silence ms/min, skips/min | F2: underruns/min, silence ms/min (+stalled %), skips/min |
|---|---|---|---|
| local fmp4 bbb | 46 | 230, 413, 229 | 12, 17 (+0.3 %), 13 |
| local fmp4 bbb | 60 | 8, 58, 19 | 2, 2, 4 |
| public bbb (shared ring trace) | 46 | 371, 41811, 498 | 368, 161 (+70.5 % stalled), 453 |
| public bbb (shared ring trace) | 250 | 75, 1935, 44 | 24, 60 (+7.1 %), 62 |
| public bbb (fallback ring trace) | 250 | 47, 976, 28 | 12, 30 (+3.3 %), 31 |

## Browser matrix (final, all four variants)

| scenario | preset | baseline | f2 | f23 | f234 |
|---|---|---|---|---|---|
| local-fmp4-iso | auto | 366.5 / 1.4% / 802 @46 | 0 / 0.3% / 198 @46 | 0 / 0.4% / 205 @46 | 0 / 0% / 0 @104 |
| local-fmp4-iso | 100ms | 0 / 0% / 3 @126 | 0 / 0% / 0 @126 | 0 / 0% / 0 @126 | 0 / 0% / 0 @126 |
| local-fmp4-iso | 250ms | 0 / 0% / 3 @253 | 0 / 0% / 0 @253 | 0 / 0.5% / 28 @277 | 0 / 0.5% / 40 @277 |
| local-fmp4-iso | 500ms | 0 / 0% / 3 @503 | 0 / 0% / 0 @503 | 0 / 0% / 0 @527 | 0 / 0% / 0 @527 |
| local-fmp4-post | auto | 372.5 / 1.3% / 756 @46 | 0 / 0.2% / 135 @46 | 0 / 0.7% / 412 @46 | 0 / 0% / 0 @100 |
| local-fmp4-post | 100ms | 0 / 0% / 6 @126 | 0 / 0% / 0 @126 | 0 / 0% / 0 @126 | 0 / 0% / 0 @126 |
| local-fmp4-post | 250ms | 0 / 0% / 10 @253 | 0 / 0% / 29 @253 | 0 / 0.5% / 28 @277 | 0 / 0.5% / 31 @277 |
| local-fmp4-post | 500ms | 0 / 0% / 3 @503 | 0 / 0% / 0 @503 | 0 / 0% / 0 @527 | 0 / 0% / 0 @527 |
| local-ts-post | auto | 354.7 / 73% / 194 @46 | 0 / 76.9% / 1543 @46 | 0 / 76.3% / 35765 @46 | 0 / 0.6% / 536 @229 |
| local-ts-post | 500ms | 0 / 0% / 6 @526 | 0 / 0% / 0 @526 | 0 / 0% / 0 @526 | 0 / 0% / 0 @526 |
| remote-post | auto | 367.7 / 67.1% / 36028 @51.75 | 0 / 52% / 2722 @61.75 | 0 / 52.3% / 28531 @74.5 | 0 / 0% / 0 @270 |
| remote-post | 100ms | 360.2 / 35.2% / 20518 @103 | 0 / 26.3% / 14231 @103 | 0 / 22.6% / 12760 @127 | 0 / 22.9% / 12894 @127 |
| remote-post | 250ms | 3.3 / 0.2% / 150 @253 | 0 / 0.5% / 248 @253 | 0 / 0% / 0 @277 | 0 / 0% / 0 @277 |
| remote-post | 500ms | 0 / 0% / 6 @503 | 0 / 0% / 0 @503 | 0 / 0% / 0 @527 | 0 / 0% / 27 @527 |
| ownpub-remote | auto | 86.3 / 4.3% / 0 @70.5 | 0 / 40.1% / 273 @70.5 | 0 / 3.2% / 0 @78 | 0 / 10.1% / 36 @1023 |
| ownpub-remote | 500ms | 271 / 52.5% / 0 @523 | 0 / 13.2% / 98 @523 | 0 / 6.7% / 110 @523 | 0 / 6.8% / 129 @523 |

cells: underrun episodes/min / silent % of time (underruns + refill stalls) / discarded ms/min @resolved delay ms

Reading the table:

- Smooth local source (fmp4, 2-chunk pacing), both rings: the baseline's ~370 underrun
  episodes/min at the 46 ms auto target vanish with F2 (ring hysteresis + re-stall); F4 then settles
  auto at 100-104 ms and removes the residual skip-ahead trimming entirely.
- Burst-shaped source (TS import with default PES packing, the public stream's shape) and the public
  relay itself: F2 and F3 change the form of the silence, not its amount (52-77 % of the time
  silent at a 46-75 ms target, because a 162 ms burst cannot fit). F4 sizes auto from the measured
  arrival spread (p99 lateness + one chunk): 230 ms locally, 270 ms on the public relay, and both
  play clean (0 underruns, 0-0.6 % silent, 0-536 ms/min trimmed). Fixed presets below the burst
  period (100 ms) stay broken by construction; 250 ms and up are clean in every variant.
- Own real-mic publisher over the public relay: the source itself runs behind real time (encoder
  output lag up to 7.7 s, drift 88-275 ms/s, see findings.md), so the watcher numbers track a source
  defect, not the ring; F4 correctly chases it up to the 1000 ms clamp instead of hiding it.
- F3 in isolation: keeps the codec floor when a catalog advertises jitter 0 (277 instead of 253 ms
  at the 250 preset with the fmp4 importer's refinement) and stops the AudioContext rebuild on
  catalog republish (one ring per run instead of one per republish).

Gates on the Phase B tree: `just js check` and `just js test` pass (0 failures, 211 watch tests
including 7 new F2 tests); Biome cognitive-complexity capped at 10 on every touched file.

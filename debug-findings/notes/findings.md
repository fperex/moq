# Findings log (chronological, evidence in runs/)

Environment: Mac mini (Apple Silicon), Chrome 152.0.7977.82 (headed test instance, separate
profile, fake camera+mic flags), relay = main tree target/debug/moq-relay (built 2026-09-05),
watcher/publisher JS = this branch (debug/rt-audio) @ upstream/dev 30ef2a3de + rtprobe
instrumentation (analysis/patch-probes.py). All timestamps are epoch ms on one machine.

## 2026-09-06 setup facts

- "Real-time" chip (moq.watch, main) == "Auto" chip (dev) == Sync auto mode: jitter = max(20 ms,
  1.25 x minRTT). Locally RTT=1 ms -> jitter 20 ms; Opus floor 20+3 -> delay 43 ms, maxAge 43 ms.
  bbb (AAC 44.1k, native fmp4 import): floor 23+3 -> delay 46 ms.
- Headless Chrome is NOT usable for audio timing: worklet cadence is fine but see the publisher
  backlog note below; headed Chrome (CDP 9225) is used for every real run.

## smoke-headed / p0 / p1 (JS publisher, fake mic, Chrome)

- Capture worklet is real time (pub.cap: media s == wall s over 24 s).
- Encoder INPUT (pub.enc, right before AudioEncoder.encode) is real time: lateness p99 0.8 ms,
  drift 0, encodeQueueSize always 0.
- Encoder OUTPUT (pub.aud) carries the input timestamps unchanged (784/804 equal, all deltas 20 ms)
  but is emitted late and slower than real time: drift +106 ms/s with the publisher tab foreground,
  +344 ms/s in the background, +315 ms/s headless. At the end of a 24 s run the codec held a 7.3 s
  backlog (last input ts 24.79 s, last output ts 17.47 s). Emission shows ~1 Hz stalls of
  100-430 ms. DTX ruled out (no tiny payloads, no timeline compression).
  -> the watcher sees a source whose media clock runs at 65-90 % of wall time: the ring drains
  and, because read() never re-stalls after an underrun, never rebuilds its cushion (dry ring at
  28-34 % of inserts, 180-300 underrun episodes/min). Whether a REAL microphone shows any of this
  is exactly what E3 must measure; do not cite the fake-mic publisher numbers as the reported case.

## e2-smoke (native bbb publisher, ffmpeg -re, AAC 23.2 ms chunks, localhost, auto)

- Real-time source (drift 0.1 ms/s), RTT 1 ms, delay/maxAge 46 ms, ring target 46 ms.
- ffmpeg -re interleaving delivers audio in bursts of ~2 chunks per video frame: inter-arrival
  p50 26 / p90 42 / p99 46 ms.
- Result at auto: 388 underrun episodes/min (913 ms/min silence), 336 skip-aheads/min (923 ms/min
  of audio discarded), ring dry at 23 % of inserts, buffered-before-insert p50 5.8 ms against a
  46 ms target. Mechanism: target == burst size, so a 2-chunk burst overflows the cap (skip) and
  the following 46 ms gap drains it (underrun). No network jitter involved.

## E6 replay of the e2-smoke trace (analysis/replay.ts, real SharedRingBuffer, 44.1 kHz)

Same arrivals, ring target swept. Live measurement at 46 ms was 388 underruns/min and 336 skips/min.

| target ms | underrun episodes/min | underrun ms/min | skips/min | skipped ms/min |
|---|---|---|---|---|
| 20 | 1447 | 22298 | 3312 | 32118 |
| 30 | 1217 | 10276 | 1389 | 16210 |
| 46 (auto) | 242 | 648 | 285 | 3470 |
| 60 | 8 | 200 | 35 | 2811 |
| 100 | 4 | 18 | 16 | 2480 |
| 150 | 0 | 0 | 12 | 2268 |
| 500 | 0 | 0 | 12 | 903 |

The residual ~12 skips/min at every target >= 150 ms is a clock-rate mismatch between the trace's
media clock and the replay reader (about 0.8 % from the 288 ms vs 290 ms per-100-quanta figure),
i.e. the slow drift any two oscillators show; the ring resolves drift by discarding audio (skip)
or by silence (underrun), never by resampling. Not the headline, but relevant to remote relays.

## e2-bbb-local, 100ms preset: catalog jitter refinement rebuilds the watcher's audio graph

- 82.5 s into the 100 ms run (about 178 s into the publisher's life) the native fmp4 importer
  republished the catalog with the audio rendition's `jitter` lowered to 0. Mechanism in
  rs/moq-mux/src/container/fmp4/import.rs: per fragment `jitter = max - min + min_duration`, kept
  as a running MINIMUM (`if track.jitter.is_none_or(|j| jitter < j)`), written straight into
  `catalog.audio.renditions[..].jitter`. A single-frame fragment gives one frame duration; any
  fragment that yields a smaller value (a short or zero-duration sample) drags the published
  value down for the rest of the stream, and it never recovers.
- The watcher trusts that field verbatim: `js/watch/src/audio/source.ts` `codecJitter =
  selected.config.jitter ?? defaultAudioJitter(...)`, so the audio floor went 26 ms -> 3 ms
  (poll `ajitter` 26 -> 3, resolved delay 126 -> 103). This is the 51 ms = 48 + 3 total in the
  user's moq.watch screenshot: the public bbb publisher has long since refined its jitter to 0.
- Because the rendition config object changed, `Decoder#runWorklet` (which tracks
  `source.out.config`) re-ran: a second `[audio] using SharedArrayBuffer audio buffer` line,
  a second `ring.create` (new AudioContext + worklet + ring), `sync[audio]: 1 late frame(s), max
  2.4s behind`, a 875 ms gap in worklet stats, 14 transport-level stale drops, one container
  group skip and a 222 ms skip-ahead burst. One catalog hint update = a full audio teardown
  and rebuild mid-playback.
- From then on the publisher advertises jitter 0, so the 250/500/1000 runs of this matrix ran with
  the 3 ms floor (delay 253/503/1003), and any later auto run would resolve 23 ms instead of 46.

## e2-bbb-local final matrix (native bbb, localhost, headed Chrome, 90 s per preset)

Full table: analysis/e2-bbb-local.summary.md. Headline, steady state after a 5 s warm-up:

| preset | resolved delay | underrun episodes/min | underrun ms/min | skips/min | skipped ms/min | dry-ring inserts |
|---|---|---|---|---|---|---|
| auto (Real-time) | 46 ms | 313.8 | 690.7 | 308.1 | 690.7 | 19.8 % |
| 100 ms | 103 ms | 0 | 0 | 5.7 (one 222 ms burst from the catalog rebuild, rest 2.9 ms) | 186.7 | 0 |
| 250 ms | 253 ms | 0 | 0 | 8.5 x 2.9 ms | 24.8 | 0 |
| 500 ms | 503 ms | 0 | 0 | 0.7 x 2.9 ms | 2 | 0 |
| 1000 ms | 1003 ms | 0 | 0 | 0.7 x 2.9 ms | 2 | 0 |

Network arrival is identical in every row (inter-arrival p50 25 / p90 42 / p99 46 ms, 2-chunk
bursts from ffmpeg -re interleaving; lateness spread ~7 ms p90). Only the ring target changes.
Video late frames: 18/min at auto, 0 elsewhere. The 2.9 ms skips at >= 250 ms are one render
quantum of clock drift (44.1 kHz media vs the output device), harmless.

## moq.watch deployed build, unmodified (runs/moqwatch-inspect.json, 60 s, RTT 39-40 ms)

- relay https://cdn.moq.pro/demo, broadcast bbb.hang, `latency="real-time"` attribute (main lineage,
  bundle /assets/index-BEDqIRFy.js).
- catalog: audio 0.aac mp4a.40.2 44.1 kHz stereo, container legacy, **jitter 0**; video 0.avc3
  1280x720, jitter 0.
- Sync: jitter 48.75-50 ms (= 1.25 x RTT), delay 51.75-53 ms, audio floor (`ajitter`) 3 ms.
  Matches the original screenshot (48 ms auto / 51 ms total) exactly.
- element `audio.out.buffered` span: p10 0 / p50 0.00001 / p90 0.04 ms, i.e. the ring is
  chronically empty: every decoded chunk is consumed as it lands. `audio.out.stalled` flags only
  0.4 % of samples, which is why the UI shows nothing: the ring is not "stalled" (that flag only
  covers the initial fill), it is running dry quantum by quantum.

## E6 synthetic sweep (analysis/replay.ts --synthetic chunk:sigma:burst:seconds, 20 ms chunks, 120 s)

Underrun episodes/min at each ring target (ms), Gaussian arrival jitter sigma, optional 2-chunk bursts:

| sigma / burst | 23 | 43 | 63 | 83 | 103 | 150 |
|---|---|---|---|---|---|---|
| 2 ms / 1 | 752 | 0 | 0 | 0 | 0 | 0 |
| 5 ms / 1 | 1236 | 17 | 0 | 0 | 0 | 0 |
| 10 ms / 1 | 1344 | 377 | 9 | 0 | 0 | 0 |
| 5 ms / 2 | 1482 | 351 | 0 | 0 | 0 | 0 |
| 10 ms / 2 | 1349 | 519 | 98 | 0 | 0 | 0 |
| 20 ms / 1 | 1237 | 698 | 302 | 71 | 1 | 0 |

Skips track underruns one for one (the ring drops what arrived early and starves on what arrived
late). Rule visible in the numbers: the target must exceed chunk + burst + about 4 sigma. The auto
floor (20 ms jitter + codec frame) survives sigma <= ~3 ms; the remote bbb resolution (53 ms with
23 ms chunks, floor 3 ms) survives sigma <= ~7 ms.

## p2-audio-only (JS publisher, fake mic, video disabled, publisher tab foreground)

Still lags: encoder input real time (drift 0, queue 0), output drift +231 ms/s, 2997 inputs vs
2346 outputs after 60 s, encode latency up to 13 s. Video is not the cause. Next: a standalone
WebCodecs AudioEncoder benchmark (demo/web/src/enc-bench.html) and the real BT microphone.

## e5-remote-bbb, auto preset (dev worktree, public relay cdn.moq.pro/demo, RTT 46-47 ms): DEAD

- Resolved: jitter 57.5 (= 1.25 x 46), delay 60.5, maxAge 60.5. Console at 0.9 s:
  `subscribe error: id=2 broadcast=bbb.hang track=0.avc3 error=The number 60.5 cannot be converted
  to a BigInt because it is not an integer` and the same for `track=0.aac` (57.5), thrown from
  js/net/src/varint.ts `encodeTo` while encoding the SUBSCRIBE. Both subscriptions fail, the
  failure is an unhandled `spawn error` (no retry), and for the whole 60 s the element reports
  status=live, audio stalled, 0 bytes, video stalled. The catalog track (integer priority, no
  maxAge) still works, which is why status says live.
- Locally RTT is 1 ms so `max(20, 1.25)` is the integer floor and nothing breaks; any RTT above
  16 ms whose 1.25 x product is fractional (46, 47, 39 -> 48.75 ...) kills auto mode on dev.
- The deployed main build (moq.watch) plays with the same fractional jitter (48.75) because its
  first SUBSCRIBE goes out while jitter is still the integer 100 ms fallback; the later RTT-driven
  value only reaches SUBSCRIBE_UPDATE, whose failure is not fatal. Needs the diff to confirm.
- Consequence for this investigation: remote `auto` cannot be measured on dev as-is. Plan:
  (a) report as its own finding; (b) add a clearly labelled diagnostic rounding of the wire
  maxAge in the worktree to measure the ring behaviour that main users actually get.

## e5-remote-bbb: instrumented dev watcher on the public relay (cdn.moq.pro/demo, RTT 38-47 ms, 60 s each)

Full table: analysis/e5-remote-bbb.summary.md. The public bbb is `0.aac` (AAC 44.1k, 23.2 ms
frames, one MoQ group per frame: 2365 audio groups in 55 s) + `0.avc3` (one group per ~2.4 s GOP).

Arrival shape (identical in every preset, from the wire timestamps of the audio frames):
inter-arrival p50 0.1-0.2 ms, p90 140 ms, p99 200-205 ms, max 227-241 ms. The relay hands the
watcher audio in bursts every 140-240 ms, not at the 23 ms frame cadence the local relay showed.
Arrival lateness spread: p50 107-115 ms, p90 172-181 ms, p99 200-213 ms, max 221-244 ms.

| preset | resolved delay | underrun episodes/min | underrun ms/min | skips/min | skipped ms/min | group skips / net stale |
|---|---|---|---|---|---|---|
| auto | 60.5 (dev bug: SUBSCRIBE throws, nothing delivered) | n/a | n/a | n/a | n/a | n/a |
| 100 ms | 103 | 365.8 | 21494 (36 % of the minute is silence) | 378.9 | 20546 | 210 / 3 |
| 250 ms | 253 | 3.3 | 30 | 6.5 | 33 | 0 / 0 |
| 500 ms | 503 | 0 | 0 | 2.2 (drift) | 3 | 0 / 0 |

At 100 ms the sync reference re-anchored 222 times and 1010 audio frames/min arrived "late".
Video rendered 24 fps in all three (its 41.7 ms frames sit inside a 2.4 s group, so the bursts
do not starve it the same way). Caveat: the "decode latency" column is meaningless for this
stream (decoder output timestamps are re-based, so nearest-timestamp matching pairs distant
frames); the wire-timestamp columns are the ones to cite.

Burst structure on the public relay (watch-500ms trace): audio frames arrive 7 at a time (burst
size p50 7, max 8, i.e. ~162 ms of AAC per burst) with 364 gaps > 100 ms in 60 s; video frames
arrive one by one at their 41.5 ms cadence (p90 76 ms). So the batching is on the audio path
upstream of the watcher (the public bbb publisher or the relay tier), not in the watcher, and not
in the video path. A watcher targeting 53 ms against 162 ms bursts cannot avoid the ring's
skip/underrun cycle; this is the reported remote "Real-time stutter" on moq.watch.

## e5-remote-auto-a (dev + diagnostic ceil on the wire budget, public relay, RTT 39 ms, 60 s)

Resolved jitter 48.75 / delay 51.75 / maxAge 51.75 (ceil'd to 52 on the wire). Steady state:
369 underrun episodes/min totalling 39.6 s/min (two thirds of the time is silence), 407
skip-aheads/min discarding 36.0 s/min, underrun episode p50 105 ms (one burst period), skip p50
105 ms, 826 container group skips + 32 transport stale drops, video 731 late frames/min (max 83 ms),
sync reference re-anchored 213 times. Same arrival shape as the other presets (7-frame bursts).
This is what "Real-time" delivers on moq.watch: the ring is emptied by every 140-240 ms gap and
overrun by every 162 ms burst.

## p3-real-mic (JS publisher, real Bluetooth microphone, headed Chrome, publisher foreground, 25 s)

Encoder healthy: 1341 inputs = 1341 outputs, drift 0, encode latency p50 0.3 / max 8 ms, emit
inter-arrival p50 20 / p90 30 / max 38 ms, publisher->watcher one-way p50 1.8 / p99 3.8 ms.
So the Opus backlog seen earlier is a `--use-fake-device-for-media-stream` artifact only.
The local watcher at auto (43 ms) in THIS configuration (publisher tab foreground, system default
output): 0 underruns, 0 skips in 20 s of steady state. The reported local symptom therefore needs
the faithful setup: publisher tab in the background and the Bluetooth headset as the output device
(HFP buffering pulls the worklet in bursts); next run p4.

## enc-bench (standalone WebCodecs AudioEncoder, same Chrome, no moq code)

opus 48k stereo: realtime feed 1000 frames -> 1000 outputs, latency p50 0.4 / max 4.3 ms; with
{voip, voice, dtx}: p50 0.8 / max 3.3 ms; burst of 1000 frames encoded in 0.2 s (queue peaked at
995, drained fully); mono: p50 0.3 ms. The encoder itself is nowhere near real-time limits, which
confirms the fake-microphone backlog is specific to that capture source, not to Opus or Chrome.

## e5b-own-pub-remote (own <moq-publish>, real USB mic + camera, publisher tab background, via cdn.moq.dev/anon, RTT ~45 ms)

- auto (45 s): jitter 56.25, delay 79.25 (Opus floor 23 ms is right here), maxAge 79.25 -> 80 on
  the wire (ceil workaround). Steady state: 0 underruns, 0 skips, ring held p50 48.6 / p90 52.6 ms,
  arrival lateness p50 10 / p90 12 / p99 15 / max 38 ms, inter-arrival p50 20 / p90 30 / max 56 ms,
  publisher->watcher one-way p50 40 / p99 45 ms. Per-frame Opus groups from our own publisher
  arrive smoothly through the public relay (no 7-frame bursts), and an 80 ms target covers them.
  So a conferencing shape CAN be clean at auto today when the codec floor is honest (23 ms) and the
  arrival jitter is small; the bbb path fails because of its 0 ms floor and 162 ms bursts.
- 500 ms (45 s): 84 underruns/min, 10.7 s/min silence, because the SOURCE fell behind: after the
  first watcher left (52.4 s, relay aborts the publisher's tracks) and the second subscribed
  (55.9 s, "publish ok"), the audio encoder OUTPUT lag rose from 5 ms to >100 ms at 59.3 s, 2 s at
  60-65 s, 5.9 s at 70 s, and 7.35 s from 80 s on, then held exactly there (output back at real
  time but permanently 7.3 s behind). Encoder input stayed on time (p50 5 ms, queue 0), the VIDEO
  encoder output stayed on time (1-2 ms), capture on time. Audio-only: outputs 4511 vs inputs 4878.
  This is the same signature the fake microphone showed from t=0; here it is triggered by
  subscriber churn on a real device. Needs a local repro (p5) before it goes in the report.

## p4-local-faithful (own <moq-publish>, real USB webcam mic + camera, publisher tab BACKGROUND, local relay, HDMI output, 45 s each)

| preset | delay | underrun /min | underrun ms/min | skips /min | skipped ms/min | ring p50 before insert | arrival lateness p90/p99/max |
|---|---|---|---|---|---|---|---|
| auto | 43 | 4 | 46.5 | 9.3 | 46.5 | 21.7 ms | 2.1 / 4.8 / 47 ms |
| 100 ms | 123 | 0 | 0 | 0 | 0 | 100.3 ms | 2.2 / 6.8 / 21 ms |
| 500 ms | 523 | 0 | 0 | 0 | 0 | 440 ms | 139.5 / 157 / 159 ms (encoder churn transient, see below) |

With a healthy publisher and small local jitter, auto is only mildly broken here (a glitch every
5-15 s); the ring sits at the bottom of its band (21.7 ms against a 43 ms target with 20 ms
chunks) so a 2-5 ms excursion is enough. The reported severe local case had a Bluetooth headset
as output (not paired now): the HDMI device pulls 3-4 quanta per 10 ms (read gap p50 10 ms), a
HFP headset buffer would pull far larger bursts against the same 43 ms ring. Untested.
Publisher across the three subscriptions: 7485 in / 7474 out, drift 0.7 ms/s, but encode-output
latency p90 60 / p99 220 ms: the re-subscribe transient again (arrival lateness up to 159 ms
during the third subscription), this time recovering instead of settling 7 s behind.

## e3b-safari (Safari, WebSocket transport, native bbb on the local relay, HDMI output)

auto (46 ms, 65 s): 279.6 underrun episodes/min (697 ms/min), 266.6 skips/min (697 ms/min), ring
empty at 20.5 % of inserts, ring p50 5.8 ms before insert. 500 ms (80 s): 0 and 0, ring p50
480 ms. Arrival lateness identical (p90 27.6 / p99 30-33 ms). Safari's worklet pulls 2 quanta
per 6 ms callback (no bursts). The AudioContext was already running at 0.4 s (auto-play allowed
for this site); the AX press never found the button, a manual click landed at 6.8 s with
userActivation active. Same mechanism, same magnitude as Chrome.

## p5-churn (own publisher, real USB mic, publisher tab FOREGROUND, local relay, three sequential auto watchers x 40 s)

Watcher 1 and 2: 0 underruns, 0 skips (ring p50 15 ms of a 43 ms target, arrival lateness p99
14-15 ms). Watcher 3: 3.4 underruns/min (254 ms/min), 5.1 skips/min, arrival lateness p99 131 /
max 169 ms. Publisher output lag per 10 s: 8 ms flat for 110 s, then 48 ms and 148 ms during the
third subscription; encode-output latency p99 140 / max 151 ms; writeFrame itself p99 0.8 ms;
encoder input on time, queue 0. So the post-churn encoder-output lag is real, transient here
(100-170 ms), permanent 7.3 s once on the public relay (e5b), and not in writeFrame. Not
root-caused; reported as an observation only.

## e8-userchrome (a normal Chrome profile driven through a browser extension, shipped demo watch.html, local relay, native bbb, tab hidden so video was gated, audio playing)

auto (46 ms, 115 s): 334.2 underrun episodes/min (808 ms/min), 333.2 skips/min (849 ms/min), ring
empty at 20.6 % of inserts, ring p50 5.8 ms. 500 ms (54 s): 0 underruns, 8.8 skips/min (59 ms/min,
one 2.5 s hiccup). Same numbers as the test Chromes and Safari.

## Use case 2, a2-embed-remote-iso: the exact moq.watch DOM, SharedArrayBuffer ring, public relay (RTT 46 ms)

Bare `<moq-watch volume="1" visible="20%" latency="real-time">` + 1280x720 canvas + overlay div,
built from the worktree source (dev), served cross-origin isolated, 60 s per preset.
- auto (resolved 59.25 ms): probes 368.7 underrun episodes/min (37.4 s/min silence), 414 skips/min
  (33.4 s/min discarded), 827 container skips + 42 stale; black-box probe on the public API:
  278 plateaus/min (19.5 s/min), 355 skips/min, and the PCM tap on `audio.out.root` reports 50.8 %
  of 50 ms windows silent (< -60 dBFS).
- 100 ms: 364 underruns/min (21.6 s/min), 377 skips/min. Same arrival shape as before (7-frame
  bursts, lateness p90 178 ms).
- `visible="20%"` gated video whenever the test window was occluded (rendered 7.3 fps at auto, 0
  at 100 ms with 0 video groups); the earlier `visible="always"` runs are the video reference.

## Use case 2, a2-embed-remote-post: the PRODUCTION path (exact DOM, no COOP/COEP -> postMessage ring), public relay

`crossOriginIsolated === false`, console `[audio] SharedArrayBuffer unavailable, falling back ...`,
worklet reports the AudioRingBuffer backend. 60 s per preset, RTT 39-47 ms.

| latency attr | resolved | underrun episodes/min | silence ms/min | discarded ms/min (cumulative skip counter) | black-box: plateaus/min, silent PCM windows |
|---|---|---|---|---|---|
| real-time | 51.75 | 371 | 39403 | 36857 | 301/min, 58.7 % silent |
| 100 | 103 | 363 | 20870 | 20397 | 117/min, 47.5 % silent |
| 250 | 253 | 1.1 | 6 | 3 | |
| 500 | 503 | 0 | 0 | 0 | |

Underrun episodes are longer on this ring (p50 108 / p90 151 / max 201 ms at real-time) because the
fallback ring's capacity equals the target: every 7-frame burst overflows it (discarding the excess)
and the 140-240 ms gap that follows drains it completely. Nearly 60 % of the rendered audio is
silence. This is what https://moq.dev/watch/ and moq.watch play at "Real-time".

## Use case 2, a2-embed-local-{iso,post}: exact DOM, local native bbb (fmp4), both rings, 60 s

| ring | latency attr | resolved | underrun episodes/min | silence ms/min | discarded ms/min |
|---|---|---|---|---|---|
| SharedArrayBuffer | real-time | 46 | 296 | 2771 | 2767 |
| SharedArrayBuffer | 100 | 126 | 0 | 0 | 3 |
| SharedArrayBuffer | 500 | 503 | 0 | 0 | 0 (one catalog rebuild, defect C, reset the counters) |
| postMessage | real-time | 46 | 308 | 674 | 690 |
| postMessage | 100 | 126 | 0 | 0 | 13 |
| postMessage | 500 | 503 | 0 | 0 | 0 |

Same mechanism on both rings locally; the SharedArrayBuffer run at real-time also caught a
publisher hiccup (arrival lateness max 769 ms) that the 46 ms target could not absorb.
The black-box "silent PCM windows" figure varies with the film's own quiet passages (11-34 %
even at 500 ms), so it is only comparable within one content window; the plateau/underrun counters
are the robust metrics, and locally the black-box plateau count at real-time (6/min on the shared
ring) undercounts the probe's 296/min because 50 ms polling misses sub-50 ms gaps.

## Use case 2, a4-ts-default: the backend cause reproduced locally (moq import ts, ffmpeg default PES packing)

`ffmpeg -stream_loop -1 -re -i bbb.mp4 -c copy -f mpegts - | moq import ts` on the local relay
produces exactly the public stream's signature: tracks `0.aac` (one group per 23.2 ms frame,
2599 groups in 55 s) and `0.avc3` (one group per GOP), `container: legacy`, `description: 1210`,
and audio frames arriving 7 at a time (burst size p50 7, max 8; inter-arrival p50 0.5 / p90 158 /
max 207 ms), while video frames arrive one by one. The public relay adds nothing to the shape: the
bursts come from `AacStream::write` in `rs/moq-mux/src/container/ts/import.rs` forwarding every
ADTS frame of a PES in one pass, and ffmpeg's default MPEG-TS mux packs ~7 AAC frames per PES.
Exact embedding, postMessage ring, RTT 1 ms: real-time (46 ms) 324 underrun episodes/min with
44.6 s/min of silence, 360 container skips + 634 transport stale drops; 500 ms clean.

Catalog values from this tree's TS importer (a4-ts-default): audio `jitter: 23`, video `jitter: 42`
(one frame each, the generic min-duration estimator wins over the 162 ms audio-burst value, which
`Rendition::estimate()` overwrites), and the catalog is republished on every bitrate refinement
(0.3 s, 1.6 s, 3.6 s, 16.8 s, 46.3 s). The public stream advertises 0 for both, so the deployed
publisher is not this code (older build or a supplied hint). Either way the watcher's floor is one
frame (23 + 3 ms) against 162 ms bursts, and each republish is a candidate AudioContext rebuild.

Rebuild per republish (dev `Decoder#runWorklet` keys on the whole rendition config): in the
a4-ts-default real-time run the audio graph was rebuilt at 0.1, 1.4, 3.4, 16.7 and 46.4 s, one
for each catalog republish (bitrate refinements at 0.3, 1.6, 3.6, 16.8, 46.3 s). Five AudioContext
teardowns in 47 s from a fresh publisher, each one a ring reset. Defect C is therefore "any catalog
refinement rebuilds the audio graph", not only the jitter field.

## a4-ts-pes0: same TS import with `-pes_payload_size 0` (one PES per AAC frame)

Bursts gone: audio burst size p50 1 (max 2), inter-arrival p50 25 / p90 45 / max 68 ms, arrival
lateness p99 42 ms. Exact embedding on the postMessage ring, real-time (46 ms): still 494 underrun
episodes/min (1.58 s/min silence), 1.53 s/min discarded, 465 transport stale drops; 500 ms clean.
So the publisher's PES packing sets the burst size (162 ms vs one frame), and the ring's cap
semantics turn even a smoothly paced source into hundreds of glitches per minute at a 46 ms target.

## Phase B preview: F2 ring semantics replayed on recorded traces (real SharedRingBuffer, dry-run copy)

F2 = skip only past target + one chunk of slack, re-stall on underrun (refill to target). Same
arrivals, mode off vs on:

| trace | target | upstream: underruns/min, silence ms/min, skips/min | F2: underruns/min, silence ms/min (+ stalled %), skips/min |
|---|---|---|---|
| local fmp4 bbb (e2) | 46 | 230, 413, 229 | 12, 17 (+0.3 % stalled), 13 |
| local fmp4 bbb (e2) | 60 | 8, 58, 19 | 2, 2, 4 |
| public bbb, shared ring trace (e5-auto-a) | 46 | 371, 41811, 498 | 368, 161 but 70.5 % of the time stalled (silent), 453 |
| public bbb, shared ring trace | 100 | 361, 22226, 415 | 347, 594 + 37.9 % stalled, 364 |
| public bbb, shared ring trace | 250 | 75, 1935, 44 | 24, 60 + 7.1 % stalled, 62 |
| public bbb, fallback ring trace (a2-post) | 250 | 47, 976, 28 | 12, 30 + 3.3 % stalled, 31 |

Reading: F2 fixes the smooth-source case at the auto target (20x fewer glitches locally) and helps
at 250 ms remotely, but against 162 ms bursts a 46-100 ms target is simply too small: F2 turns
continuous underruns into refill stalls (still silence) and the bursts still overflow one chunk of
slack. The burst case needs the target sized from the measured arrival spread (F4), or the
publisher to stop packing 7 frames per PES. Local "skipped ms/min" in the 1.2-1.9 s range at every
target is the 44.1 kHz replay clock drift noted earlier, not F2.

## Use case 2, a3-site-remote: the real site page (debug-findings/moq.dev-main, @moq/watch@0.4.3, no isolation), black box

Loaded `sites/watch` locally at /demo/bbb.hang?relay=https://cdn.moq.pro (its .env otherwise points
the page at a local relay), read only the public API plus an AnalyserNode on `audio.out.root`:
- Real-time (resolved 60.5 ms, RTT 46): 283 playhead plateaus/min (20.0 s/min), 316 skips/min,
  64.3 % of 50 ms PCM windows silent, `stalled` 0 %.
- The 100/500 rows did not take: `<moq-watch-ui>` owns the child's `latency` attribute and reflected
  it back to the RTT mode ('48', '57' = the jitter at close), so both rows are Real-time again
  (52 % and 42.7 % silent). On the main lineage presets must be set through `latencyMin`; noted for
  a re-run once the browser is free.
- Same magnitude as the instrumented exact-embedding run on the fallback ring (58.7 % silent), which
  ties the probe numbers to the version the site ships.

## a3-site-local: the site page against the local relay (published 0.4.3, no isolation)

Real-time (46 ms, RTT 1): black-box plateaus 0/min, skips 9/min, 10.8 % silent windows; the same
scenario with probes shows ~300 sub-millisecond underruns/min, which 50 ms polling of
`audio.out.timestamp` cannot resolve. The black-box plateau metric is therefore only sensitive to
the long (100-200 ms) gaps of the remote burst case; the PCM silence share and the internal probes
are the metrics for the short local ones. The 500 preset again did not stick through the UI wrapper.

## a2-embed-safari-post: Safari on the fallback ring

500 ms: clean (0 underruns, 80 s). The real-time pass is invalid: Safari connected over WebSocket,
the AudioContext stayed `interrupted` (no gesture until 23 s) and the WebSocket session dropped
("connection closed, reconnecting", then offline at 93 s), so no worklet reads happened. Safari's
shared-ring run (e3b-safari) remains the Safari evidence; a fallback-ring real-time re-run is a gap
to close only if the browser is free after the benchmark chain.

## Phase B baseline (refactored tree, flags off): behaviour preserved

local fmp4 auto 366-373 underruns/min on both rings (pre-refactor: 296-308), local TS default packing
auto 355/min with 43.7 s/min silence (pre: 324/min, 44.6 s), remote fallback ring auto 368/min with
39.9 s/min (pre: 371/min, 39.4 s), 250/500 ms clean everywhere. Own publisher over the public relay:
auto 86/min at a 70.5 ms delay; the 500 ms row's 271/min with 31.5 s/min silence is the post-churn
encoder-output lag again (second subscription), a source-side effect, so for that scenario only the
first-subscription (auto) row compares across variants.

Own publisher over the public relay, baseline run: the encoder output lag began with the FIRST
subscription this time (output lag per 10 s: 68, 333, 1501, 1831, 2038, 2336, then 8-28 s after the
second subscription; 3879 chunks out for 5366 in; drift 275 ms/s), publisher tab in the background,
real USB mic. P4 (same setup, local relay) drifted 0.7 ms/s and E5b (public relay) was clean for its
first 50 s, so the lag is intermittent and its trigger is not established (per-frame stream credit
over a 45 ms RTT path is the leading suspect, unproven). The ownpub scenario is therefore not usable
for the ring A/B; it stays a reported observation.

## Phase B: the first F2 benchmark was inert (vite plugin trap) and was discarded

The `?rt=` flag parser lives in `demo/web/console-overlay.ts`, a vite plugin, and plugins load at
server start; both vite servers predated Phase B, so `window.__rtFlags` was never set and the first
"f2" variant measured the baseline again (369 vs 367 underruns/min). Servers restarted, stale runs
deleted, and a 25 s check with `rt=f2` on the local fmp4 stream at auto (46 ms): 0 underrun
episodes, 3 skip-aheads (227 ms/min discarded), ring p50 19.9 ms before insert, 36 stalled quanta
(re-stalls after underruns), against ~370 episodes/min without the flag. Chain relaunched.

## Phase B, F2 in the browser (local fmp4 bbb, exact DOM, 60 s, both rings)

| ring | preset | baseline | F2 |
|---|---|---|---|
| SharedArrayBuffer | auto (46 ms) | 366.5 underruns/min, 812 ms silence, 802 ms discarded | 0, 0, 198 ms discarded |
| postMessage | auto (46 ms) | 372.5, 765, 756 | 0, 0, 135 |
| both | 100/250/500 | 0 | 0 |

Same arrival statistics in both rows (2-chunk pacing, lateness p90 ~27 ms). The one-chunk slack
absorbs the second chunk of each pair and the re-stall never fires in steady state; what remains is
the 44.1 kHz clock drift being trimmed a quantum at a time.

## Phase B, F2 on the burst-shaped streams (local TS default packing, public relay)

F2 removes the underrun episodes but the ring then spends the time re-stalled and refilling, which
is silence as well: local TS auto 76.9 % of the time stalled (1.5 s/min discarded), public relay
auto 52 % stalled (2.7 s/min discarded), public 100 ms 26 % stalled (14.2 s/min discarded), public
250 ms 0.5 % stalled and 0 underruns (from 3.3/min). So F2 fixes the smooth-source case outright and
helps once the target is near the burst period, but a 46-100 ms target against 162 ms bursts stays
mostly silent whatever the ring does; that is the sizing problem F4 addresses. The comparison table
now reports "silent % of time" (underruns + stalls) so F2 rows are not read as clean.

Audible confirmation: during the own-publisher runs (real microphone through the public relay to
the watcher in the test browser) the reporter, speaking into the microphone, heard the audio
stutter live. Same runs as the numbers above.

## Phase B, F2+F3 (catalog jitter 0 treated as absent; graph keyed on rate/channels)

- Local fmp4, 250 ms run: the catalog jitter refinement (23 -> 0) happened mid-run; with F3 the
  audio floor stayed 27 ms (resolved 277 instead of 253) and the audio graph was NOT rebuilt (one
  `ring.create` per run; baseline rebuilt on every catalog change).
- Public relay: floor 3 -> 27 ms (delay 51.75 -> 74.5 at auto), which changes nothing against the
  162 ms bursts: 52.3 % of the time silent at auto, 22.6 % at 100 ms; 250 ms clean (0 underruns,
  0 % silent, 0 discarded).
- Local streams: unchanged from F2 (0 underruns, < 1 % silent).

## Phase B, F2+F3+F4 (adaptive auto sizing), local scenarios

| scenario | auto target settled | underruns/min | silent % | discarded ms/min | baseline at 46 ms |
|---|---|---|---|---|---|
| local fmp4, shared ring | 104 ms (jitter 78) | 0 | 0 | 0 | 366/min, 1.4 %, 802 |
| local fmp4, postMessage ring | 100 ms (jitter 74) | 0 | 0 | 0 | 373/min, 1.3 %, 756 |
| local TS default packing (7-frame bursts) | 230 ms (jitter 204 = p99 lateness 174 + 25 headroom) | 0 | 0.6 | 536 | 355/min, 73 %, 194 |

The fixed presets (100/250/500) are unchanged, as designed (F4 only touches auto). The settled
auto target is the p99 arrival lateness plus one chunk, so "Real-time" now means what the
connection can sustain: 100 ms on a smooth local source, 230 ms behind a bursty publisher.

## Phase B, F2+F3+F4 on the public relay and the own publisher (final)

- Public relay, production DOM, fallback ring, auto: settled jitter 243 / delay 270 ms (p99
  arrival lateness 205 + 25 headroom, RTT 46), 0 underrun episodes, 0 % silent, 0 discarded, over
  60 s; baseline at 51.75 ms: 368/min, 67 % silent, 36 s/min discarded. Fixed 100 ms stays 23 %
  silent (bursts do not fit), 250/500 clean.
- Own publisher: F4 settled at the 1000 ms clamp (measured lateness p99 1.7 s) because the
  publisher's encoder output ran behind real time again (lag 6 ms -> 7.7 s over 100 s, drift
  88 ms/s); 10 % of the time stalled. The watcher cannot fix a source that runs slow; that defect
  stays a separate, publisher-side observation.

## Filed

moq-dev/moq#3477, 2026-09-06, one issue carrying the ring/auto-sizing diagnosis with the two related defects (dev fractional maxAge, importer catalog jitter 0 + AudioContext rebuild) as sections; cross-references #2812.

## Filed, second pass (same day): split into three issues

The single issue was split on request: #3477 keeps the ring/auto-sizing diagnosis (body rewritten: machine and OS, browser and toolchain versions, the exact revisions behind the relay and importer binaries, the relay exoneration, the no-churn variant of the encoder-output lag, the deployed page's own `audio.out.buffered`/`stalled` readings, and a "How this was measured" section with the ruled-out list and the not-measured list); #3478 is the dev fractional maxAge varint throw; #3479 is the fMP4 running-minimum jitter plus the AudioContext rebuild on every catalog republish.

Binary provenance established for the record: `target/debug/moq` (the importer used for every local fmp4/ts publish) was built 2026-08-20 from the fork's dev at b9a2dda8e, a pure sync merge whose tree equals upstream dev b39fb8722 (2026-08-21); `target/debug/moq-relay` was built 2026-09-05 from 16bff46be, tree equal to upstream dev 6f30e42e4. The cited importer hunks (`fmp4/import.rs` running minimum, `ts/import.rs` `AacStream::write` and its `update_rendition` jitter publishing, `catalog/estimate.rs`) are identical between those revisions and 30ef2a3de (git diff), so the observed importer behaviour is the 30ef2a3de behaviour. The relay differs from 30ef2a3de in 25 files (auth, path patterns, ietf error codes, coding), none on the group delivery path that was exonerated.

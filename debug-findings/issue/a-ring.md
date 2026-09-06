### Summary

With the Latency tab on "Real-time" (main, moq.watch) or "Auto" (dev), audio cuts in and out and video stutters, locally on one machine and against the public relay. 500 ms and 1 s play clean. The mechanism is in `js/watch`: the resolved delay is `max(codec floor, video floor) + max(20 ms, 1.25 x minRTT)`, the audio ring treats that number as a hard cap with no hysteresis and does not re-buffer after an underrun, so any arrival earlier than the cap is discarded (a skip-ahead) and any arrival later than the cap plays as silence. Measured on `dev` (30ef2a3de) with instrumented builds and reproduced deterministically by replaying the recorded arrival traces through the unmodified `SharedRingBuffer`. Two related defects found on the way are filed separately: #3478 (dev: the fractional `maxAge` throws in the varint encoder) and #3479 (the fMP4 importer's `jitter` ratchets to 0, and a catalog republish rebuilds the AudioContext).

Related: #2812 reports the same symptom on iOS without a reproduction; the measurements below are the throughput, RTT and audio-buffer recordings asked for there, taken on desktop Chrome and Safari.

### Environment

- Machine: Mac mini (Apple M4, 10 cores, 24 GB), macOS 26.6.1 (25G76). For the local rows the publisher, relay and watcher all run on this one machine, so every timestamp is on one clock; audio output is a wired HDMI device.
- Watcher: Chrome 152.0.7977.82, headed, a separate fresh profile, started with only `--use-fake-ui-for-media-stream` (real devices without a permission prompt; no fake media device is behind any number here, see the publisher section for why). A normal Chrome profile with extensions gives the same numbers on the shipped demo page. Safari 26.6 (WebKit 605.1.15), which connects over WebSocket here, reproduces them.
- Code: `upstream/dev` 30ef2a3de (chore: merge main into dev, 2026-09-06) plus timestamp probes in a local branch; no behavioural change except the diagnostic `Math.ceil` on the wire `maxAge` that auto mode needs to run on dev at all (#3478). `upstream/main`: the cited files were read at d88c2ee99 and re-checked at 234569928 (identical in `js/watch`, `js/net`, `js/hang`, `js/publish`, `rs/moq-mux`, `rs/moq-net`, `rs/moq-relay`). The deployed moq.watch bundle (`/assets/index-BEDqIRFy.js`, main lineage) was read live, and the site repo's own `sites/watch` page was run locally with `@moq/watch@0.4.3` from its lockfile.
- Relay: local `moq-relay` built from upstream dev 6f30e42e4 (2026-09-05, rustc 1.95.0), localhost RTT 1 ms; and the public `https://cdn.moq.pro/demo` (RTT 38 to 47 ms from here, no induced impairment).
- Sources: `moq import fmp4` and `moq import ts` built from upstream dev b39fb8722 (2026-08-21; the importer code cited below is identical at 30ef2a3de), fed by ffmpeg 9.0.1 with `-re` from bbb.mp4 (AAC 44.1 kHz, 23.2 ms frames); the public `bbb.hang` (AAC 44.1 kHz, one MoQ group per 23.2 ms frame); and `<moq-publish>` with a USB microphone and camera (Opus 48 kHz, 20 ms frames, one group per frame), the shape a videoconferencing client has.

### What "Real-time" resolves to

- `js/watch/src/ui/components/latency.ts`: the chip sets `latencyMin = "real-time"` (main) / `delay = "auto"` (dev).
- `js/watch/src/sync.ts` `#runJitter`: `jitter = max(MIN_JITTER = 20 ms, minRtt * 1.25)`, 100 ms until the first PROBE sample. `#runDelay`: `delay = max(video floor, audio floor) + jitter`; `maxAge = delay + buffer` goes on the wire as Subscriber Max Age (`js/watch/src/media.ts` `subscribeMedia`).
- Audio floor: `js/watch/src/audio/source.ts` `codecJitter = selected.config.jitter ?? defaultAudioJitter(config)` plus one 128-sample worklet quantum (3 ms). Local Opus: 20 + 3 = 23 ms, so `auto` resolves to 43 ms. Local AAC via the native importer: 23 + 3 = 26 ms, so 46 ms. Public bbb: the catalog advertises `jitter: 0` (the catalog `jitter` defect below), so the floor is 3 ms and the deployed moq.watch page shows "Jitter buffer 48 ms (auto), Total buffer 51 ms" at a 39 ms RTT.

### The ring

`js/watch/src/audio/shared-ring-buffer.ts` (the `SharedArrayBuffer` path the demo uses; `ring-buffer.ts` mirrors it):

- `read()`: `if (!this.buffered && latency > 0 && buffered > latency) read = write - latency`. Anything buffered beyond the target is dropped on the next render quantum.
- `read()` on an empty ring returns 0 and leaves `READ` where it is; `STALLED` is only ever set by `reset()`/allocation, so after an underrun the next chunk plays immediately and the cushion is whatever that chunk happens to be.
- `insert()` un-stalls only once `WRITE - READ >= LATENCY`.
- `render-worklet.ts` `process()` renders the shortfall as digital silence (no ramp) and reports it at `console.debug`.

So the usable margin against arrival jitter is `target - chunk`, on both sides: 23 ms locally for Opus at `auto`, 30 ms on the public relay. The ring resolves any clock-rate difference between publisher and output device the same way (drift shows up as periodic 2.9 ms skips at every preset in the tables below).

### Measurements

#### Local, native bbb publisher (real-time source, zero network jitter), 90 s per preset, steady state

Arrival is the same in every row: inter-arrival p50 25 / p90 42 / p99 46 ms (ffmpeg -re interleaves two audio frames per video frame), lateness spread about 7 ms at p90.

| preset | resolved delay | underrun episodes/min | underrun ms/min | skip-aheads/min | skipped ms/min | inserts into an already empty ring |
|---|---|---|---|---|---|---|
| auto ("Real-time") | 46 ms | 313.8 | 690.7 | 308.1 | 690.7 | 19.8 % |
| 100 ms | 103 ms | 0 | 0 | 5.7 | 186.7 (one 222 ms burst, the catalog `jitter` defect below) | 0 |
| 250 ms | 253 ms | 0 | 0 | 8.5 | 24.8 | 0 |
| 500 ms | 503 ms | 0 | 0 | 0.7 | 2 | 0 |
| 1000 ms | 1003 ms | 0 | 0 | 0.7 | 2 | 0 |

At `auto` the ring holds p50 5.8 ms before an insert against a 46 ms target, video renders 18 late frames/min; at every other preset the ring holds target minus one chunk, as designed.

Safari on the same local setup (WebSocket): `auto` 279.6 underrun episodes/min (697 ms/min), 266.6 skips/min (697 ms/min), ring empty at 20.5 % of inserts; 500 ms: 0 and 0. The shipped demo `watch.html` in a normal Chrome profile: `auto` 334 underrun episodes/min and 333 skips/min, 500 ms clean.

`<moq-publish>` with a real USB microphone and camera on the same machine, publisher tab in the background, local relay (RTT 1 ms, arrival lateness p90 2 / p99 5 / max 47 ms): `auto` (43 ms) 4 underrun episodes/min and 9.3 skips/min with the ring sitting at p50 21.7 ms, 100 ms and 500 ms clean. The audible severity of the local case therefore scales with whatever adds arrival or output-device jitter on the machine (other output devices were not measured).

#### Public relay (`cdn.moq.pro/demo`, `bbb.hang`, RTT 38 to 47 ms), 60 s per preset

Audio arrives seven frames at a time (about 162 ms of AAC per burst) with gaps of 140 to 240 ms; video frames arrive one by one at 41.5 ms. Arrival lateness spread: p50 110 / p90 178 / p99 210 / max 244 ms, identical in every preset.

| preset | resolved delay | underrun episodes/min | underrun ms/min | skip-aheads/min | skipped ms/min |
|---|---|---|---|---|---|
| auto ("Real-time") | 51.75 ms (RTT 39) | 368.9 | 39601 | 406.9 | 36029 |
| auto on dev as shipped | 60.5 ms (RTT 46) | subscription never opens (the fractional `maxAge` defect below) | | | |
| 100 ms | 103 ms | 365.8 | 21494 | 378.9 | 20546 |
| 250 ms | 253 ms | 3.3 | 30 | 6.5 | 33 |
| 500 ms | 503 ms | 0 | 0 | 2.2 | 3 |

At auto two thirds of every minute is silence and most of the rest is discarded (826 container group skips, 32 transport stale drops, 731 late video frames/min); at 100 ms a third of every minute is silence and another third is discarded; the Sync reference re-anchored 213 and 222 times. The auto row was measured with the wire budget rounded up (the fractional `maxAge` defect below) so the subscription could open at all. This is the "Real-time stutter" on moq.watch: the deployed build reads `audio.out.buffered` as 0.00001 ms (p50) over 60 s, i.e. every decoded chunk is consumed the instant it lands, while `audio.out.stalled` flags 0.4 % of samples, so nothing in the UI shows it.

None of the loss is on the relay. In every local run at every preset the transport stale-drop and container group-skip counters are 0, and on the public relay no group ended in an error (no stream reset): the 826 group skips and 32 stale drops per minute at auto are the watcher's own `maxAge` checks (`js/hang` container consumer, `js/net` subscriber) discarding what its 52 ms window no longer wants. The public relay also adds nothing to the burst shape; the same seven-frame bursts come out of `moq import ts` on localhost (below).

#### Replay of the recorded traces through the unmodified ring

`SharedRingBuffer` fed the local `auto` trace (same arrivals, target swept) reproduces the live numbers and shows where the artifacts stop:

| target ms | underrun episodes/min | skips/min |
|---|---|---|
| 20 | 1447 | 3312 |
| 46 (auto) | 242 | 285 |
| 60 | 8 | 35 |
| 100 | 4 | 16 |
| 150 | 0 | 12 (drift) |

Synthetic 20 ms chunks with Gaussian arrival jitter (120 s): artifact-free only once target exceeds chunk + burst + about 4 sigma. With sigma 5 ms, 43 ms still gives 17 underruns/min; with sigma 10 ms, 377/min; sigma 20 ms needs 103 ms. The RTT term (1.25 x RTT) does not measure any of this: a 1 ms RTT path with 5 ms of decode/scheduling jitter and a 40 ms RTT path with 200 ms bursts both get a target their arrivals cannot fit.

#### Own publisher through the public relay (`<moq-publish>`, real microphone, `cdn.moq.dev/anon`, RTT 45 ms)

At `auto` the Opus floor is the honest 23 ms, the resolved delay 79.25 ms, and the arrivals of per-frame groups are smooth (lateness p50 10 / p90 12 / p99 15 / max 38 ms): 0 underruns, 0 skips in 45 s, ring held about 50 ms. The same watcher at 500 ms then underran 84 times/min, but because the publisher fell behind after the first watcher left (next section), not because of the ring. In the later own-publisher runs (the ones with that lag) the stutter was audible live in the watcher while someone spoke into the microphone.

### Secondary observation, not root-caused: encoder output lags after subscriber churn

Three times, right after a watcher left and another subscribed (the relay aborts the publisher's tracks, then `publish ok` again), the `AudioEncoder` output started arriving late while its input stayed on time (`encodeQueueSize` 0, capture on time, the `VideoEncoder` output on time, `track.writeFrame` p99 0.8 ms): locally a transient 100 to 170 ms (arrival lateness p99 131 ms at the third subscription), on the public relay a lag that grew to 7.35 s over 25 s and then stayed there for the rest of the session (4511 chunks emitted for 4878 inputs). A watcher at 500 ms behind that publisher underran 84 times/min because the source itself fell behind. In two later runs over the public relay the same lag began with the first subscription, with no churn at all: output lag 68 ms, 333 ms, 1.5 s, 1.8 s, 2.0 s and 2.3 s over successive 10 s windows (drift 275 ms/s, 3879 chunks out for 5366 in), and in another run 6 ms to 7.7 s over 100 s (drift 88 ms/s). The same publisher on localhost drifted 0.7 ms/s across three subscriptions and showed only the transient. So churn is not the only trigger, it appeared only on the 45 ms RTT path, and it is intermittent (one 45 s public-relay run was clean at auto). Not root-caused; it is a source-side effect and is kept out of the ring numbers above.

#### The path moq.dev/watch and moq.watch actually run: no cross-origin isolation, the postMessage ring

The deployed pages send no COOP/COEP headers, so `crossOriginIsolated` is false, `supportsSharedArrayBuffer()` is false and the element plays through `PostAudioBuffer` + `AudioRingBuffer` (`js/watch/src/audio/{buffer,ring-buffer}.ts`). That ring's live capacity equals the target, it un-stalls only through its overflow branch (discarding), and it never re-stalls after an underrun. Measured with the exact DOM the site renders (`volume="1" visible="20%" latency="real-time"`, 1280x720 canvas), served without isolation, against `cdn.moq.pro/demo`, 60 s per setting:

| latency | resolved | underrun episodes/min | silence ms/min | discarded ms/min | PCM windows silent (AnalyserNode on `audio.out.root`) |
|---|---|---|---|---|---|
| real-time | 51.75 ms | 371 | 39403 | 36857 | 58.7 % |
| 100 | 103 ms | 363 | 20870 | 20397 | 47.5 % |
| 250 | 253 ms | 1.1 | 6 | 3 | |
| 500 | 503 ms | 0 | 0 | 0 | |

The shipped site itself (its `sites/watch` page, `@moq/watch@0.4.3` from its lockfile, no isolation) read through the public API only: at real-time 283 playhead plateaus/min (20 s/min), 316 skips/min, 64 % of 50 ms PCM windows silent.

#### Where the 7-frame bursts come from (backend)

The public `bbb.hang` has the MPEG-TS importer's signature (`0.aac`, `0.avc3`, `container: legacy`, a `timeline.z` track). In `rs/moq-mux/src/container/ts/import.rs`, `AacStream::write` splits one PES into its ADTS frames, cuts each into its own group, and forwards them all in one synchronous pass, so a TS mux that packs several AAC frames per PES delivers them as one burst. Reproduced locally: `ffmpeg -re ... -f mpegts - | moq import ts` with ffmpeg's default PES packing yields the identical signature and 7-frame bursts every ~160 ms (burst size p50 7, max 8; inter-arrival p50 0.5 / p90 158 / max 207 ms), while `-pes_payload_size 0` yields one frame per group at a steady 25 ms. Video is one access unit per PES either way. On localhost (RTT 1 ms), the default packing at real-time (46 ms) gives 324 underrun episodes/min with 44.6 s/min of silence, 360 container skips and 634 transport stale drops; per-frame packing still gives 494 episodes/min (1.6 s/min). This tree's TS importer advertises `jitter: 23` (one frame) for that stream, not the 162 ms burst it produces (the generic estimator overwrites the audio-burst value), and the public publisher advertises 0.

#### Catalog republish rebuilds the audio graph

`Decoder#runWorklet` (`js/watch/src/audio/decoder.ts`) tracks the whole rendition config, so every catalog republish (the TS importer refines `bitrate` at 0.3, 1.6, 3.6, 16.8 and 46.3 s after start; the fMP4 importer lowers `jitter`) tears down and rebuilds the AudioContext, worklet and ring: five rebuilds in the first 47 s of one run, each a ring reset. Filed as #3479 together with the importer's `jitter` defect.

### What controls the artifacts (measured, same build, page-load switches)

To confirm the mechanism rather than describe it, the instrumented branch carries three experimental switches and the matrix was repeated with each: same streams, same 60 s windows, arrival statistics identical across the rows of each table. The switches are cumulative: "ring change" holds one chunk above the target and re-buffers after an underrun; "plus measured sizing" also sets the auto target to the measured p99 arrival lateness plus one chunk. "Time silent" counts underruns and re-buffering stalls together; "audio trimmed" is what skip-aheads discarded.

Local fmp4 bbb, smooth two-chunk pacing, same result on both rings:

| switch | underrun episodes/min | time silent | audio trimmed ms/min | resolved delay |
|---|---|---|---|---|
| as shipped | 367 to 373 | 1.4 % | about 800 | 46 ms |
| ring change | 0 | 0.3 % | 135 to 198 | 46 ms |
| plus measured sizing | 0 | 0 % | 0 | 100 to 104 ms |

Local `moq import ts` with ffmpeg's default packing, 7-frame bursts, postMessage ring:

| switch | underrun episodes/min | time silent | audio trimmed ms/min | resolved delay |
|---|---|---|---|---|
| as shipped | 355 | 73 % | 194 | 46 ms |
| ring change | 0 | 77 % (all of it re-buffering) | 1543 | 46 ms |
| plus measured sizing | 0 | 0.6 % | 536 | 230 ms |

`cdn.moq.pro/demo` bbb, the production DOM on the postMessage ring:

| switch | underrun episodes/min | time silent | audio trimmed ms/min | resolved delay |
|---|---|---|---|---|
| as shipped | 368 | 67 % | 36028 | 52 ms |
| ring change | 0 | 52 % (all of it re-buffering) | 2722 | 62 ms |
| plus measured sizing | 0 | 0 % | 0 | 270 ms |

Two facts follow. The ring's cap-without-hysteresis and no-refill behaviour is what turns ordinary two-chunk pacing into hundreds of glitches per minute at the auto target: with one chunk of slack and a refill they disappear at the same 46 ms. And no ring behaviour can fit a 162 ms burst into a 46-100 ms window: the artifacts on the public stream only stop once the target follows the measured arrival spread (270 ms there), i.e. the RTT term is not a measure of what arrives. A fixed 250 ms is clean in every configuration, which is why the 500 ms and 1 s presets have always sounded fine.

(Treating an advertised catalog `jitter` of 0 as absent kept the codec floor at 27 ms instead of 3 ms and stopped the AudioContext rebuild on catalog republish, without changing the burst outcome.)

### Why it is invisible

`watch.audio.out.stalled` is read by no UI; the spinner (`buffering-indicator.ts`) and the buffer bars (`buffer-control.ts`) use `video.out.stalled`; `demo/web/src/viz.ts` hardcodes `stalled=false` for the audio bar; the worklet's `audio underflow: Nms` is `console.debug`. On the deployed moq.watch page itself, read through the element's public signals for 60 s at real-time: `audio.out.buffered` is p10 0 / p50 0.00001 / p90 0.04 ms (empty at nearly every sample) while `audio.out.stalled` is true for 0.4 % of samples, because that flag only covers the initial fill; the ring runs dry quantum by quantum without ever counting as stalled.

### Publisher side (Chrome, Opus, real microphone)

`<moq-publish>` with a real USB microphone is clean: 1341 encoder inputs produced 1341 chunks with zero drift, encode latency p50 0.3 ms (max 8 ms), chunk emission inter-arrival p50 20 / p90 30 / max 38 ms, and publisher-to-watcher one-way p50 1.8 / p99 3.8 ms on localhost. (Chrome's fake microphone, `--use-fake-device-for-media-stream`, is not usable for this: its `AudioEncoder` output lags the input by seconds while `encodeQueueSize` stays 0; noted so nobody measures with it; a standalone `AudioEncoder` in the same Chrome encodes 1000 Opus frames in 0.2 s, so the codec is not the limit.)

### How this was measured

- Instrumented build: a timestamp at every hand-off (capture worklet, encoder input and output, `track.writeFrame`, transport group open and stale drop, container group, frame and skip, decoder output, ring insert, the worklet's `read()` for underruns, skip-aheads and read cadence, Sync reference and per-frame lateness), collected in the page and drained once a second to a local sink. The local rows have publisher, relay and watcher on one clock.
- Driver: a Chrome DevTools Protocol script opens the publisher and one watcher tab per preset, sets the preset, and records 60 to 90 s per row. Presets run back to back on the same stream, so the arrival statistics printed with each table are the check that only the ring target changed between rows.
- Metrics: an underrun episode is a run of render quanta in which `read()` delivered fewer samples than asked; a skip-ahead is `read()` moving its cursor past buffered audio (the discarded ms are counted); the silent share is underrun time plus time spent re-filling; "inserts into an empty ring" is the share of inserts that found nothing buffered; arrival lateness is arrival wall time minus media timestamp, relative to its running minimum.
- Replay: the recorded insert traces, and synthetic arrivals with Gaussian jitter and optional two-chunk bursts, fed through the unmodified `SharedRingBuffer` with the target swept. It reproduces the live counts, which is what separates the ring from the network.
- Black box, for the production DOM and the site's own page: only the public API (`audio.out.timestamp` sampled every 50 ms for plateaus and jumps, `audio.out.buffered` and `stalled`, `sync.out.buffer` and `jitter`, `connection.probe.rtt`) plus an `AnalyserNode` on `audio.out.root` for the share of 50 ms windows below -60 dBFS. Caveat: 50 ms polling misses sub-50 ms gaps (locally 6 plateaus/min against 296 underruns/min from the probes), so the plateau count only resolves the 100 to 200 ms remote gaps, and the PCM silence share moves with the film's own quiet passages (11 to 34 % even at 500 ms), so it compares only within one content window.
- Switches: the three page-load switches in the table above. With all of them off the code path is byte-for-byte upstream, so before and after ran on one build.
- Ruled out, with the measurement that ruled it out: Opus DTX compressing the timeline (encoder outputs carry the exact input timestamps, payloads 64 to 194 bytes); the Opus encoder not keeping up (only with Chrome's fake microphone; a real one is 1341 in, 1341 out); video encoding starving the audio encoder (an audio-only publisher lags identically with the fake microphone); headless Chrome's audio clock (its AudioWorklet runs at real time; headless was dropped only because of the fake microphone); relay-side expiry (0 stale drops and 0 group skips in every local run); network jitter as the local cause (arrival spread about 7 ms at p90, identical across presets); a "0 ms" setting behind the chip (it is the RTT-derived auto mode; `instant` disables audio outright).
- Not measured: added loss or latency profiles (every remote row is the 38 to 47 ms path as found); Safari on the postMessage ring at real-time (its WebSocket session dropped and the AudioContext stayed `interrupted` during that pass, so Safari's SharedArrayBuffer-ring run is the Safari evidence); the site's own page at fixed presets (its UI wrapper re-reflects `latency`, so those rows came back as real-time); a Bluetooth output device.

Traces, the per-run tables and the scripts are available on request.

Related: #3478, #3479.

Tested: `upstream/dev` 30ef2a3de1d469a591ee2c14ccdb81ded20857ec (probes and the page-load switches added on top in a local branch; the switches-off path is byte-for-byte the upstream behaviour); `upstream/main` 234569928de0d45fc0d9b2e61769b17a89d0cd23 read for the cited files; the deployed moq.watch build plus its `@moq/watch@0.4.3` package measured directly; local relay from upstream dev 6f30e42e4 and importer from upstream dev b39fb8722 (importer code identical at 30ef2a3de).

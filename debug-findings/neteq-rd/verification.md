# Audio playout verification record

This POC fixes several reproduced timing and lifecycle defects. It has **not** eliminated audio interruptions in every tested workload. The latest original-4K file test still loses audio between publisher output and watcher decoder input. Passing earlier snapshots does not verify every change now on the branch.

This record contains aggregate measurements and source identifiers. Recordings, stream addresses, access credentials, local filesystem paths, and raw browser logs are excluded. The retained synthetic checks are linked below.

## Snapshot identity

The investigation started from `origin/dev` at `5c96c0e81`. Browser tests used immutable built snapshots. The numbers in parentheses are historical local build labels, not release versions or endpoints.

These are SHA256 prefixes of the individual source files, not hashes of the whole application:

| Snapshot | `audio/playout.ts` | `audio/decoder.ts` | `audio/render-worklet.ts` |
| --- | --- | --- | --- |
| Timing normalization (4325) | `174402154039` | `b650a35bc0d6` | `66a535a9e0ee` |
| Bounded admission (4326) | `174402154039` | `1e678183e0b5` | `4209cd4e6f96` |
| Combined audio (4327) | `4bd2e9fa5375` | `1e678183e0b5` | `4209cd4e6f96` |
| Combined file playback (4328) | `b0b7353123e6` | `1e678183e0b5` | `4209cd4e6f96` |

The combined file test also used the updated file publisher. Its `source/file.ts` SHA256 is `f3a15b0eeb0a54cf486461039ee08b03cbf8445416987bfda16c3a12759e5b22`. The tests below do not certify later source changes.

## Local browser observations

| Browser and workload | Snapshot and measurement | Result |
| --- | --- | --- |
| Chromium 152.0.7977.84, public AAC | Timing normalization; 120 samples, approximately 119 seconds between first and last | No output zeros, new silent samples, or late samples. Added 1,026 concealed samples correspond to an observed source timestamp discontinuity. |
| Actual Safari 26.6 on macOS 26.6.1, public AAC | Timing normalization; approximately 119 seconds of steady playback, then pause and mute lifecycle | No new concealed, silent, or late samples in the steady interval. One 256-sample zero run also exists in decoded input. Queue 90–275 ms; adaptive requirement 183–223 ms. |
| Actual Safari 26.6 on macOS 26.6.1, local AAC | Combined audio; approximately 119 seconds between 120 measurements | No new concealed, silent, or late samples. The same 256 exact zeros occur in decoded input and output. Incoming media advances at 1.05009 times wall time. |
| Firefox 155.0 and Playwright WebKit 26.6, local Opus | Earlier frozen builds; separate 45-second observations | Neither steady measured interval adds concealment, silence, late samples, or output zeros. These traces are historical observations without the source identifiers above. |
| Firefox 155.0, local Opus | Later 90-second observation, also outside the identified snapshot table | Adds 5,464 concealed and late samples, 768 silent samples, and 837 output zeros. This remains a failed continuity observation. |
| Chromium 151.0.7922.34, original 4K file through actual publish and watch controls | Combined file playback; 100 measurement samples | Fails audio continuity and reports subscription latency-budget errors. Details follow. |

The local AAC publisher used FFmpeg 9.0.1. Its default read-rate catch-up factor of 1.05 explains the measured incoming pace and sustained acceleration in that Safari run. This is not evidence of a five-percent receiver clock drift.

Actual Safari was driven through Safari WebDriver and real playback controls. Playwright WebKit is a separate test environment. Neither establishes behavior on iOS hardware. All audio measurements observe browser graph output, not physical speakers. The older public-page build also had an unrelated embed hydration error, so its audio result is not an all-page UI pass.

The retained [graph probe](browser-probe.js) counts output samples and exact-zero runs and reads the player's timing counters. Natural source silence and receiver-generated silence require separate comparison against decoded input.

## The original 4K test still fails

The original input was 3840×2160 AV1 video with stereo Opus audio. The publisher actually encoded 3840×2160 HEVC. It did not silently reduce the test to a smaller video rendition.

All counts below are per channel at 48 kHz. Intervals use the measurement sample labels; polling adds some overhead, so labels 5–85 cover 80.667 rendered seconds.

| Interval | New concealed samples | New silent samples | New late samples | New output zeros |
| --- | ---: | ---: | ---: | ---: |
| 0–5 | 0 | 0 | 0 | 0 |
| 5–85, before the file loop | 7,500 | 5,308 | 4,496 | 5,433 |
| 85–89, second delivery interruption | 4,888 | 12,200 | 0 | 12,289 |
| 89–95, includes the file loop | 532 | 0 | 532 | 0 |
| 95–99 | 0 | 0 | 0 | 0 |

Decoded input contains no exact zeros during these intervals. The two output zero runs last 113.19 and 256.02 ms. At the final measured snapshot, cumulative counters are 12,920 concealed, 18,532 silent, and 5,028 late samples. Those cumulative totals include startup before the table's first sample.

The trace identifies 14 packets that the publisher encoded but the watcher never submitted to `AudioDecoder`: five consecutive 20 ms packets, then seven and two more. Their missing timestamps cover 280 ms. Publisher encoding remained regular; it had no input or output callback interval above 60 ms over the retained trace. Watcher audio input stalled for 174.8 and 317.9 ms while its sampling timer and some video callbacks continued.

Six console errors report `group exceeded the subscription latency budget`. The logs lack track and error timestamps, so they do not assign every error to an audio packet or prove the precise discard stage. The evidence narrows the missing audio to the path between encoded publisher output and watcher decoder input.

The runner continued its fast sampler while collecting large diagnostic arrays after the last PCM snapshot. That collection added stalls. Those later samples and their larger cumulative totals are excluded from the measured result above.

Two independent improvements did hold in this test:

- Video encoding no longer deadlocked or accumulated several seconds of backlog. The observed queue stayed at or below eight frames and matched encode latency stayed around 300 ms. Painted video still typically trailed audio by about 140–210 ms, so this is not an A/V synchronization pass.
- The approximately 2.6-second authored gap at the file wrap no longer collapsed the encoded audio clock. The [file source correction](publisher-findings.md) supplies timed silence before encoding. Audio and video input timestamps remained aligned across the wrap, and no output zero run appeared in that interval. This correction does not cover arbitrary live-capture discontinuities.

## What the retained checks establish

The [PCM browser driver](../../test/smoke/clients/js/pcm.ts) exercises the actual buffer and render worklet. Its 44 cells cover 44.1 and 48 kHz stereo, shared memory and transferred messages, finite endpoints, reset, rendition takeover, pressure ordering, graph changes, and three-second input blocks. The bounded-admission snapshot passed this matrix locally. Buffered output must match known samples exactly. Concealed missing content is not expected to reproduce the original recording.

The [media driver](../../test/smoke/clients/js/media.ts) measures real encoded audio, painted video, pause, rejoin, detach, republish, and resource cleanup. Its retained Libav cases test full fallback, missing-decoder-only fallback, and an explicitly injected late callback from a real closed decoder. Muted audio, frozen video, shifted audio, and leaked resources are negative controls. The [smoke guide](../../test/smoke/README.md) gives their commands and tolerances.

The [publisher verification](publisher-verify.ts) runs synthetic file gaps through production filling, resampling, framing, native encoding, and decoding. The [comparison](compare.ts) and [performance probe](performance.ts) render reproducible synthetic workloads. Their timing and waveform metrics do not establish perceptual transparency for arbitrary speech or music. The [standalone clock diagnostic](../../test/smoke/clients/js/clock.ts) can reproduce stale browser worklet clocks without importing MoQ; its success does not require that browser defect to occur.

At playout source `b0b7353123e6`, the comparison completed 20 tone cases and 20 recording-replay cases. Each renders 45 seconds at 48 kHz with a five-second warmup. All five auto scenarios, steady delivery, two-frame bursts, seven-frame bursts, and faster or slower sender clocks, produced no exact zeros after warmup in either source. Measured tone frequency was 997 Hz, except 996.975 Hz with the faster sender clock. Frequency is deliberately not reported for music. These are offline continuity observations, not a perceptual-quality pass. The runs shared CPU with other work, so their compute timings are not a performance baseline.

At playout source `b0b7353123e6`, the focused audio suite passed 179 tests and 45,142 assertions, with TypeScript and scoped formatting checks passing. The new realtime-startup regression fails against the preceding source. Separately, the rational timestamp correction in the [MPEG-TS importer](../../rs/moq-mux/src/container/ts/import.rs) passed 740 mux tests and strict Rust checks. These scoped results are not a completed final-branch cross-language run.

A subsequent local Nix checkpoint passed the JavaScript checks and tests and 1,834 Rust tests, with five configured skips. That checkpoint predates the later HE-AAC correction and fixture-generator changes. It must not be presented as verification of those later edits.

The [smoke workflow](../../.github/workflows/smoke.yml) wires Chromium PCM checks, the full interop matrix, media lifecycle and negative controls, publisher verification, and the diagnostic burst benchmark into scheduled or manually triggered CI. The source wiring is verified; this record does not claim that hosted CI has passed this branch. Firefox, Playwright WebKit, and actual Safari observations above are local evidence, not CI gates. Required final combined-source checks and cross-language smoke results must be recorded separately when complete.

## API and behavior impact

The POC deliberately adds an exported [`Clock`](../../js/watch/src/sync.ts): media `timestamp` at a monotonic presentation `reference`, with a media-to-wall-time `rate`. A zero rate holds the media clock. Sync accepts `clock` and `audioTarget`; the measured target affects auto mode. Decoder output exposes `clock` and `target` for integration and `playout` counters for diagnostics.

Existing constructor calls can omit the new inputs. Code that constructs a complete exported `SyncInput` object must supply its new properties, so the type change still needs API review on the experimental dev branch. Diagnostic signals are POC API, not a promised stable monitoring schema.

Wire framing, codec identifiers, catalog format, and relay media responsibilities are unchanged. Behavior does change: timestamps retain fractional sample timing and explicit gaps, publisher file gaps become timed silence, audio becomes the presentation clock, and adaptive delay affects which packets fit the existing age budget. An unchanged wire format does not imply unchanged timestamp values, packet selection, or buffering behavior.

## Remaining measurement problem

The adaptive estimator currently sees decoded PCM availability. Transport and container age limits can discard late packets before that measurement, and the estimator ignores reordered timestamps. Because the adaptive target also contributes to the age limit, it can censor the arrival tail it needs to learn.

The pinned NetEQ reference updates its delay manager from packet arrivals, including a separate reorder optimizer. Expand helps recovery but does not directly raise that delay target. Measuring complete encoded-frame receipt before age selection, separating local decode delay, and reviewing a bounded reception horizon independent of the instantaneous auto target remain open design work. The current evidence does not establish that this POC solves the censored-arrival problem.

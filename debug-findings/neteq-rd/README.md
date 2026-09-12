# Browser audio playout investigation

This branch investigates audible audio interruptions in `@moq/watch`. It includes an experimental PCM playout controller and independent fixes at the browser decoder and worklet boundaries. It is a proof of concept for maintainer review, not a claim of full WebRTC NetEQ equivalence or verification on every device.

The implementation starts from `origin/dev` at `5c96c0e81`. The relay and wire formats are unchanged. No pull request is intended.

## Reproduced failure mechanisms

| Boundary | Reproduction | Consequence |
| --- | --- | --- |
| Existing PCM rings | Steady 20 ms audio delivered in two-frame bursts with alternating 12 ms delay, using a 43 ms target | The old latency clamp drops or skips samples. Raising a fixed target can hide a particular trace but does not correct drift. |
| Chromium AudioDecoder | Feed Opus or AAC at 100 ms, then 1000 ms and subsequent packet timestamps | Chromium 152 emits a continuous decoded timeline starting at 100 ms. Firefox 155 and WebKit 26.6 preserve the gap. Resuming a real MoQ subscription reproduced a 2.7-second input/output timestamp difference. |
| Chromium AudioWorklet | Change the audio graph while rendering | Some successive callbacks expose the same `currentFrame`, although both request new PCM. Rejecting that value kills the processor. A minimal worklet reproduces this without MoQ. |
| Libav fallback | Remove the native audio decoder while retaining native data/chunk constructors | The fallback expects private Libav methods on native objects and fails. Full fallback additionally exposes full-frame copy and packed-stereo conversion defects. |
| Quantized source timestamps | Actual Safari public AAC has small gaps and overlaps between 1024-frame packets | Counting only contiguous samples drives persistent expansion even with a full queue. One-origin sample timing removes artificial holes; delay decisions count PCM reachable across short gaps. |
| Large decoded input | Submit one three-second PCM block while suspended, then reset | Physical FIFO capacity alone admits too much audio or strands lifecycle commands. Admission now accounts for both in-flight and retained samples. |
| Recovery after starvation | After five seconds of steady packets, increase delivery delay by 200 ms | An always-advancing empty media cursor discards subsequent packets forever, even after the adaptive target increases. This also reproduced in the proposed replacement before its recovery correction. |

These failures have different causes. The decoder and browser-clock fixes matter independently of which jitter controller the maintainer chooses.

## Playout design

Decoded planar PCM carries source timestamps into a single-owner AudioWorklet controller. Both shared memory and `postMessage` feed the same ordered command path. Shared memory transports input; it does not expose mutable playout state to the main thread.

The controller measures relative PCM availability delay, selects an adaptive target, and uses pitch-correlated overlap-add to consume slightly more or less source audio. Background-noise estimation permits correction when a strong pitch match is inappropriate. A voiced/unvoiced concealment mixture fades over 60 ms and merges into returning PCM. Concealment cannot reconstruct an arbitrary missing recording.

When the unknown tail remains empty after that fade, the media clock holds while a cushion refills. Known future samples and declared endpoints retain their source timeline. This prevents a sustained increase in network delay from turning into permanent silence.

The source timeline mapper consumes encoded durations across decoded callbacks. It supports callbacks that split or combine source spans. Adjacent timestamps within the existing one-millisecond continuity tolerance share one origin and integer sample offsets, which prevents quantization from inserting holes. Larger gaps remain explicit. It does not assume one input always produces one output. Opus packet duration comes from its TOC byte; AAC-LC can use its configuration or ADTS header; CMAF supplies per-sample duration. Codec pre-skip, timestamp gaps, and explicit endpoints remain separate. An epoch whose duration is unknown retains the native timestamp path. It therefore does not gain Chromium gap correction for an unknown-duration legacy codec.

Video follows the observed audio presentation clock while audio is active. Clearing that clock returns Sync to its existing arrival-clock policy. Fixed, automatic, buffered, and instant settings remain separate policies. Buffered playback disables time scaling. Instant continues to disable audio through the existing element policy. Explicit discontinuity, rendition takeover, and endpoint commands remain ordered with PCM.

## Source references

- [WebRTC NetEQ design](https://webrtc.googlesource.com/src/+/refs/heads/main/modules/audio_coding/neteq/g3doc/index.md).
- [WebRTC NetEQ implementation](https://webrtc.googlesource.com/src/+/refs/heads/main/modules/audio_coding/neteq/). The local reference revision is `d9ec82c89d94c319e2a1f547c1bdd58591828455`.
- [Opus packet framing, RFC 6716](https://www.rfc-editor.org/rfc/rfc6716.html#section-3.1).
- [WebCodecs audio output requirements](https://www.w3.org/TR/webcodecs/#output-audiodata).
- [Chromium AudioContext worklet clock update](https://source.chromium.org/chromium/chromium/src/+/main:third_party/blink/renderer/modules/webaudio/base_audio_context.cc).
- [Libav WebCodecs polyfill](https://github.com/ennuicastr/libavjs-webcodecs-polyfill). The repository uses `@kixelated/libavjs-webcodecs-polyfill` version 0.5.5.
- [Rust NetEQ reference](https://github.com/security-union/videocall-rs/tree/main/neteq). Its browser Opus decoder is not an AAC decoder.

The implementation adapts control and DSP ideas. It does not vendor the Chromium C++ tree or provide codec PLC, Opus FEC, WebRTC comfort-noise signaling, or NetEQ bit-exact output.

## Reproduce the experiments

Use the repository's Nix shell and Bun workspace. Run the focused checks from the repository root:

```sh
nix develop --command just check
nix develop --command just test
bun test ./js/watch/src/audio ./js/watch/src/sync.test.ts
bun debug-findings/neteq-rd/compare.ts --output=/tmp/moq-audio-comparison
```

`compare.ts` renders a synthetic 997 Hz stereo signal through the two preserved baseline rings and the current fixed/adaptive controller. It writes WAV files and a JSON manifest containing source hashes, queue statistics, exact-zero counts, tone frequency, stereo consistency, and compute time. Natural silence is not a failure metric for music.

`performance.ts` measures the current worklet's command application and PCM copy/render cost in a deterministic Bun host. It prints source hashes, runtime, sample rate, channels, transport, median, 95th percentile, maximum, and deadline overruns as JSON lines. It covers 40 ms and two-second published batches at 44.1/48/96 kHz with two or eight channels. It excludes actual browser messaging and speaker scheduling. Timing results are diagnostic and have no hard CI wall-time threshold.

```sh
bun debug-findings/neteq-rd/performance.ts > /tmp/moq-audio-performance.jsonl
```

To compare music or speech, extract 48 kHz stereo float PCM and pass its local path with `--input`. Use a separate output directory for each recording, for example `bun debug-findings/neteq-rd/compare.ts --input=.audit/speech.f32 --output=.audit/speech-comparison`. Input paths are omitted from the result manifest; it records the content hash. The recording and generated WAV files are local artifacts. They are not part of this branch. Big Buck Bunny is a Blender Foundation film; obtain and attribute its source separately.

The real browser checks and negative controls are documented in [the smoke test guide](../../test/smoke/README.md). They cover actual WebCodecs, AudioWorklets, both ingress transports, and the fallback decoder. They do not measure a physical speaker or an iOS device.

Run formatting and validation from a clean checkout or separate worktree. The root formatter can traverse ignored research archives placed beneath the repository. Keep reference repositories, recordings, and browser artifacts outside the checkout used for repository-wide formatting.

## Review scope

There is no transport, catalog, container-format, relay, or Rust wire change. The MPEG-TS importer preserves fractional audio timestamp ticks instead of truncating each frame. File publishing preserves authored silence before encoding; these publisher findings are documented separately. Browser-only additions expose an optional audio presentation clock and adaptive audio target through Sync and decoder signals. Applications that use the existing element controls keep those controls. A maintainer can review the independent browser fixes separately from the experimental controller.

The tests establish behavior under their stated signals, timing profiles, browser versions, and sample rates. A network outage or a suspended audio thread can still interrupt sound. Passing a tone-continuity check does not establish perceptual transparency for all speech and music. Measurements and remaining limitations belong in the accompanying evidence report; no universal deadline or sound-quality guarantee follows from this POC.

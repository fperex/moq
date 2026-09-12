# File audio gaps and native encoder timestamps

The file publisher previously omitted parts of a recording's presentation timeline that contain no audio samples. Native encoding then removed that elapsed time from the encoded audio timestamps. A shorter audio track could therefore move progressively ahead of video when the file looped.

The branch now renders those authored gaps as timed PCM silence before resampling and encoding. This fixes a file-source timing error. It does not establish that every reported audio stutter has the same cause.

## What the source establishes

[`File`](../../js/publish/src/source/file.ts) computes the complete file duration and shares one [`Timeline`](../../js/publish/src/source/timeline.ts) between audio and video. Previously, its audio stream emitted only decoded samples. It emitted nothing for a delayed audio start, a gap between decoded ranges, or the interval between the audio track's end and the next loop's audio start.

[`Framer`](../../js/publish/src/audio/framer.ts) preserves discontinuous input timestamps, but [`Encoder`](../../js/publish/src/audio/encoder.ts) publishes the timestamps returned by `AudioEncoder`. Preserving a timestamp before encoding is insufficient when the encoder reconstructs a continuous output clock.

The new internal [`fill`](../../js/publish/src/source/audio.ts) generator renders the absent file intervals on a cumulative sample clock. Each silence allocation covers at most 20 ms. Contiguous real samples pass through without another PCM copy. Preroll and overlapping samples already covered by the presentation are trimmed. Cancellation releases a held decoded sample; decode failures remain errors.

The existing full-duration loop offset exposes both the preceding audio tail gap and the next loop's lead-in. No additional loop clock is introduced. Capture, resampling, codec framing, codec settings, the package API, and the wire format retain their existing behavior.

## Native measurements

These measurements used actual native Chromium 151.0.7922.34 codecs on macOS, with synthetic PCM. They are observations of that implementation, not requirements imposed on every browser.

| Probe | Input | Observed output |
| --- | --- | --- |
| Opus timestamp gap | Four 20 ms inputs at 100, 1000, 1020, and 1040 ms | Packet timestamps 100, 120, 140, 160, and 180 ms after flush |
| AAC-LC timestamp gap | Four 1024-sample inputs at 48 kHz with the same leading timestamp jump | Continuous packet timestamps at the AAC frame cadence |
| Opus flush | Four aligned inputs | Five encoded packets |
| AAC-LC flush | Four aligned inputs | Seven encoded packets |
| Repeated source gap | A 2600 ms gap between otherwise regular Opus inputs | The output timestamp clock omits those 2600 ms |

An output callback cannot be matched to one input by ordinal position. The partial-input probes also show that multiple inputs can contribute samples to one encoded packet.

### A packet timestamp cannot describe a gap inside its PCM

A stereo impulse probe placed one impulse 16 samples before a source discontinuity and another 16 samples after it. The inputs were codec-aligned.

| Codec | Input boundary | Input impulse positions | Decoded peak positions | Decoded output containing both peaks |
| --- | ---: | --- | --- | --- |
| Opus | 2880 | 2864, 2896 | 2864, 2896 | Samples 2568 through 3527 |
| AAC-LC | 3072 | 3056, 3088 | 5168, 5200 | Samples 5120 through 6143 |

The decoder used the encoder-provided description. Native Opus removed its 312-sample pre-skip. The measured AAC pipeline retained 2112 samples of encoder delay. Both peaks remained above 0.5 amplitude.

Simply moving the timestamp of one post-gap packet would also move some pre-gap audio. A piecewise packet timestamp mapper can restore a long-term offset while still placing the local boundary incorrectly. That mapper was not integrated.

### Authored file gaps remain stable across loops

The retained verification generates eight 125 ms file loops, each with two impulse-bearing audio ranges and known leading, internal, and trailing absence. It runs the production `fill`, `Resampler`, and `Framer` before native encoding and decoding.

All four locally available codec/rate cells ran: Opus and AAC at 44.1 and 48 kHz. Opus uses the production 44.1 to 48 kHz resampler where needed. All 64 recovered impulses retain a constant position offset across the loops. Opus peaks match the nearest output sample. AAC retains a constant 2112-sample delay, approximately 44 ms at 48 kHz or 47.89 ms at 44.1 kHz. The AAC delay does not accumulate at each loop, and the fix does not claim to remove it.

At 44.1 kHz, a 125 ms loop spans 5512.5 samples. The cumulative clock handles the alternating integer boundaries without rounding drift.

## Remaining limitation for live capture

Live capture can have a genuine discontinuity whose missing content is unknown. The file-specific silence generator does not run on that path. Native encoder timestamp collapse can therefore still affect such a capture discontinuity.

A separate prototype drained each real encoding segment, declared its valid endpoint, and started a fresh codec epoch using existing container operations. It preserved the Opus boundary impulses exactly. The same approach was not faithful for native AAC: its configuration did not expose the measured 2112-sample delay, so trimming at the source endpoint removed valid tail audio. Existing decoder resets and finite playout endpoints also have consequences for queued audio and the shared video clock. Generic segment handling remains R\&D, rather than a partial production fix.

## Rerun the synthetic verification

From a branch checkout with its Bun workspace installed and Playwright Chromium available:

```sh
bun debug-findings/neteq-rd/publisher-verify.ts
```

[`publisher-verify.ts`](publisher-verify.ts) builds [`publisher-browser.ts`](publisher-browser.ts) in memory and uses the existing smoke browser launcher. It serves only the synthetic page on loopback and blocks non-loopback browser requests. No relay, recording, credentials, or external media URL is required. JSON output includes the browser version, literal native timestamp observations, recovered impulses, and the authored-gap regression results.

Native Opus is required. An unavailable AAC encoder is reported explicitly as `supported: false` for that codec/rate cell; it is not evidence that AAC passed. The native timestamp probes are observational, so a browser that correctly preserves input gaps is not required to reproduce Chromium's behavior. The file-presentation assertions require continuous source timing and stable impulse placement. A negative control bypasses `fill` and must fail the source-gap assertion.

The existing browser smoke CI job runs this command after media lifecycle checks. Six additional [`audio.test.ts`](../../js/publish/src/source/audio.test.ts) cases cover literal PCM and timestamps, contiguous sample identity, preroll and overlap, fractional loop boundaries, cancellation, and decode errors. The selected publisher source/audio suite passed 74 tests locally, alongside TypeScript and Biome checks.

This verification establishes the synthetic source-timeline properties. Actual file playback, browser scheduling, network behavior, and perceived audio quality require their separate end-to-end checks.

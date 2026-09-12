# File metadata can differ from decoded audio

A synthetic HE-AAC file exposed a compatibility regression in the authored-gap filler. Mediabunny reported a 24000 Hz track; the native decoder produced 48000 Hz PCM. HE-AACv2 also expanded the metadata's mono channel layout to stereo. The filler rejected both before yielding any audio. Removing that rejection alone would leave an existing error: file capture declared the encoded metadata's format and the encoder counted the decoded samples at that wrong rate.

The [AAC WebCodecs registration](https://www.w3.org/TR/webcodecs-aac-codec-registration/#audiodecoderconfig-description) says the decoder configuration's sample rate and channel count are ignored. The bitstream determines the output. Mediabunny's installed demuxer exposes the AudioSpecificConfig's core values in track metadata; its AudioSampleSink preserves actual decoder output. Explicit HE codec strings are insufficient to detect this case: both generated files' decoder configurations use `mp4a.40.2` with implicit extensions in the description.

| Synthetic input | Track metadata | Native decoded PCM |
| --- | --- | --- |
| HE-AAC | 24000 Hz, stereo | 48000 Hz, stereo |
| HE-AACv2 | 24000 Hz, mono | 48000 Hz, stereo |

The file source now reads one decoded sample before anchoring the shared audio/video timeline. Its actual format defines SampleSource, capture, and the encoder configuration. That sample and its existing decoder iterator become the first playback loop, so the format probe does not decode it twice. Subsequent loops open the sink normally. The filler uses the first nonempty decoded sample's format for its cumulative sample clock and rejects a later format change. Repeated AudioSample.close calls are safe because Mediabunny makes close idempotent. No wire fields or package exports change.

Run the retained browser regression from the repository root:

```sh
bun debug-findings/neteq-rd/file-format-verify.ts
```

It uses the real File, Capture, Encoder, and local Broadcast classes, the existing worklet build plugin, and the smoke browser launcher. It probes actual HE bitstream decoding separately from AAC-LC configuration support. Each available HE input is published as Opus and AAC-LC. Assertions check 48000 Hz stereo at the file source, capture, catalog, encoder input, and emitted decoder configuration; distinct 997 Hz left and 1703 Hz right tones; actual encoded output; and one decoder instance in the source's first loop. Unsupported HE decoding or encoding is reported per case and is not counted as a successful execution. This command runs in the existing media CI job.

`file-format-fixtures.json` contains two self-generated fixtures, their SHA-256 hashes, and exact regeneration commands. They contain mathematical tones only. They were generated with FFmpeg 9.0.1 and Apple's AudioToolbox HE-AAC encoder; Linux's native FFmpeg AAC encoder cannot regenerate these HE profiles. No recorded or downloaded media is included.

The original local proof used Chromium 151.0.7922.34. All four HE-AAC/HE-AACv2 to Opus/AAC-LC combinations passed. This establishes format and tone preservation through encoding, not universal browser codec support or listening quality. Generic live-capture timestamp discontinuities remain a separate limitation described in [publisher-findings.md](publisher-findings.md).

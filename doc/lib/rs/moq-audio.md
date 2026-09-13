---
title: moq-audio
description: Native audio capture, codecs, playback, and echo cancellation
---

# moq-audio

[![crates.io](https://img.shields.io/crates/v/moq-audio)](https://crates.io/crates/moq-audio)
[![docs.rs](https://docs.rs/moq-audio/badge.svg)](https://docs.rs/moq-audio)

The audio half of a native call: microphone in, hang track out, speaker at
the far end. Everything is Rust, so there is no C toolchain, CMake step, or
codec to install.

| Module | Does |
| --- | --- |
| `capture` | Microphones via CoreAudio, WASAPI, ALSA (and PipeWire/PulseAudio hosts), plus macOS system audio |
| `encode` | PCM to Opus (with DTX and voice-activity signaling) or raw PCM for the lowest latency |
| `decode` | Opus, PCM, and AAC-LC back to PCM, resampled to the rate you want, optionally through a jitter buffer |
| `playback` | One output device mixing every track in a call, with click-free volume ramps |
| `aec` | Acoustic echo cancellation (a port of WebRTC's), so a laptop with no headset doesn't feed itself back |

Highlights:

- **`encode::Publication`** advertises the track and opens the microphone only while someone listens. Stop, swap devices, and restart without changing the track subscribers know; read a level meter for the UI.
- **A measured jitter buffer.** Set `decode::Config::delay` and `read()` hands back a fixed 10 ms block every call instead of whatever packet was decoded, so the speaker never waits on the network. How much it holds is measured from arrival timing rather than from a round trip ([Playout](/concept/playout)), and `delay` is only the floor under it. A gap is concealed rather than played as silence unless `conceal` is turned off.
- **A/V sync signal.** `Consumer::playhead()` reports the media the speaker has actually been handed, which is what a video clock steers by; without a jitter buffer, `Sink::buffered()` says how far ahead the speaker is.
- **Activity per packet**, read off the Opus stream, so a call UI shows who is talking without a second voice detector.
- **One Linux build dependency**: ALSA headers, and only when `capture` or `playback` is enabled.

```rust
let mut audio = moq_audio::decode::Consumer::new(&broadcast, &rendition, "audio", Default::default()).await?;
let engine = moq_audio::playback::Engine::open(Default::default()).await?;
let mut input = moq_audio::playback::Input::default();
input.sample_rate = audio.sample_rate();
input.channels = audio.channels();
let mut sink = engine.sink(input)?;
while let Some(frame) = audio.read().await? {
    sink.write(&frame.data)?;
}
```

```bash
cargo add moq-audio --features playback                # decode and play the example above
cargo add moq-audio --features capture,playback,aec    # microphone, speaker, echo cancellation (Linux: cpal links libasound)
```

API: [docs.rs/moq-audio](https://docs.rs/moq-audio). Pair with
[`moq-video`](/lib/rs/moq-video).

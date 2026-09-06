### Summary

Two coupled defects around the catalog `jitter` hint, split out of #3477.

1. `moq import fmp4` publishes its per-fragment jitter estimate as a running minimum, so one short fragment drags the advertised audio `jitter` down for the rest of the stream (observed 23 ms, then 0 after about 178 s of the looping bbb; the public `bbb.hang` advertises 0 for both renditions from the start). The watcher trusts the field as its codec floor, so the floor becomes the 3 ms render quantum instead of one frame.
2. `Decoder#runWorklet` in `js/watch` keys on the whole rendition config, so any catalog republish (that jitter refinement, or the MPEG-TS importer's bitrate refinements at 0.3, 1.6, 3.6, 16.8 and 46.3 s after start) tears down and rebuilds the AudioContext, worklet and ring: five rebuilds in the first 47 s of one run, each a ring reset with a late-frame burst.

### Environment

- Importer: `moq import fmp4` and `moq import ts` built from upstream dev b39fb8722 (2026-08-21). The cited code (`fmp4/import.rs` running minimum, `ts/import.rs` `AacStream::write` and its jitter publishing, `catalog/estimate.rs`) is identical at 30ef2a3de (git diff of those hunks). Source: bbb.mp4 through `ffmpeg -re` (AAC 44.1 kHz, 23.2 ms frames), as fragmented MP4 and as MPEG-TS (ffmpeg 9.0.1).
- Watcher: `js/watch` at `upstream/dev` 30ef2a3de with timestamp probes only; Chrome 152.0.7977.82 on macOS 26.6.1 (Mac mini, Apple M4); local `moq-relay` built from upstream dev 6f30e42e4 (2026-09-05).
- The deployed moq.watch (main lineage, `@moq/watch@0.4.3`) shows the consequence of the first defect: `sync` jitter 48.75 to 50 ms plus an audio floor of 3 ms is the 51 to 53 ms total its UI displays for the public bbb.

### 1. The fMP4 importer's jitter is a running minimum

`rs/moq-mux/src/container/fmp4/import.rs`: per fragment `jitter = max - min + min_duration`, written only when smaller than the previous value (`if track.jitter.is_none_or(|j| jitter < j)`), straight into `catalog.audio.renditions[..].jitter`. A single-frame fragment yields one frame duration; any fragment that yields less (a short or zero-duration sample) lowers the published value for the rest of the stream, and it never recovers. Observed: 23 for the first ~178 s of the looping bbb, then 0 (the change landed 82.5 s into a 100 ms watcher run), and 0 from then on, so the 250/500/1000 ms rows of the same matrix ran with a 3 ms floor (resolved 253/503/1003).

The watcher trusts the field verbatim: `js/watch/src/audio/source.ts` `codecJitter = selected.config.jitter ?? defaultAudioJitter(...)`. The audio floor went 26 -> 3 ms (resolved delay 126 -> 103 at the 100 ms preset). On the public relay the field is 0 from the start, so "Real-time" resolves 48 + 3 = 51 ms against 23.2 ms frames that arrive seven at a time (#3477).

The MPEG-TS importer is misleading in a different way: for the same bbb through `moq import ts` with ffmpeg's default PES packing it advertised `jitter: 23` for audio and 42 for video (one frame each) while delivering the audio in 162 ms bursts (seven ADTS frames per PES). Its audio-burst running maximum (`AacStream` `jitter`, published through `update_rendition`) is the value that would describe those bursts; the generic one-frame estimate is what ended up in the catalog.

### 2. Any catalog republish rebuilds the audio graph

`js/watch/src/audio/decoder.ts` `Decoder#runWorklet` tracks `source.out.config`, the rendition object. A republished catalog is a new object, so the effect re-runs: a second `[audio] using SharedArrayBuffer audio buffer` line, a new AudioContext + worklet + ring, `sync[audio]: 1 late frame(s), max 2.4s behind`, an 875 ms gap in the worklet's statistics, 14 transport-level stale drops, one container group skip and a 222 ms skip-ahead burst, at 82.5 s into an otherwise clean 100 ms run (fMP4, jitter 23 -> 0). Behind the TS importer, which republishes on every bitrate refinement, the audio graph was rebuilt at 0.1, 1.4, 3.4, 16.7 and 46.4 s of a fresh publisher's life, once per republish (0.3, 1.6, 3.6, 16.8, 46.3 s): five AudioContext teardowns in 47 s, each a ring reset.

### Isolating the two mechanisms

With two page-load switches in the instrumented build (an advertised `jitter` of 0 treated as absent; the graph keyed on sample rate and channel count only), the same fMP4 250 ms run kept its floor at 27 ms (resolved 277 instead of 253) when the refinement arrived and created exactly one ring per run, where the shipped path created one per catalog change. The switches change nothing about the burst outcome on the public relay (that is #3477); switches off is byte-for-byte upstream.

Tested: `upstream/dev` 30ef2a3de1d469a591ee2c14ccdb81ded20857ec; `upstream/main` 234569928de0d45fc0d9b2e61769b17a89d0cd23 read for `source.ts` and `decoder.ts`.

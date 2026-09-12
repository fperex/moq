# BBB source timestamp overlap at the loop boundary

The tested local BBB MP4 contains AAC timestamp gaps and duplicate timestamps before it reaches MoQ. Its loop boundary caused a container rewind and audio rebuffering in the Safari test. This is a separate cause from the received-frame discard and ordinary-delivery stutter investigated elsewhere in this branch. No production rewind rule was relaxed.

Source identity: SHA-256 `cc1d8a9536a7a0f2520a8985ec14e535f265ffec148df690c3b2fa3152176f39`. The AAC track is 44100 Hz, has 25689 packets, and reports duration 596.497415 seconds. No source media or compressed audio payload is included in this finding or its verifier.

## Source packet evidence

`ffprobe` reports 1024 samples per packet. These are consecutive packets, with timestamps expressed in the source's 1/44100-second timebase:

| Packet index (zero based) | Previous PTS | Current PTS | Difference |
| --- | ---: | ---: | ---: |
| 7875 | 8062976 | 8065024 | 2048 samples |
| 7876 | 8065024 | 8065024 | 0 samples |
| 7877 | 8065024 | 8067072 | 2048 samples |
| 7878 | 8067072 | 8067072 | 0 samples |
| 25687 | 26302464 | 26304512 | 2048 samples |
| 25688 | 26304512 | 26304512 | 0 samples |

Normal spacing is 1024 samples. The final equal-PTS packets contain different compressed data, with lengths 334 and 324 bytes. They are not a duplicated network delivery. Earlier gap/duplicate pairs near 182.88 seconds also make this source unsuitable as an unconditional steady-cadence reference.

## Exact MPEG-TS and Safari match

A fast local remux with FFmpeg 9.0.1 used the same stream-copy and PES settings as the paced publisher, removing only wall-clock pacing:

```sh
ffmpeg -hide_banner -loglevel warning -stream_loop 1 \
  -i demo/pub/media/bbb.mp4 -t 600 -c copy \
  -f mpegts -pes_payload_size 2930 loop-diagnostic.ts
```

The parser counted ADTS frames within each PES and advanced their timestamps by the exact fraction `1024/44100` seconds, matching the current Rust importer. All 28 inferred timestamp and compressed-packet-size pairs from 597711655 through 598338597 microseconds matched the recorded Safari decoder inputs exactly.

| PES PTS (90 kHz ticks) | AAC frames | First inferred PTS (µs) | Last inferred PTS (µs) |
| --- | ---: | ---: | ---: |
| 53794049 | 6 | 597711655 | 597827755 |
| 53808678 | 8 | 597874200 | 598036739 |
| 53823306 | 7 | 598036733 | 598176053 |
| 53837935 | 7 | 598199277 | 598338597 |

The eight-frame PES contains both equal-PTS tail packets and the beginning of the next file loop. MPEG-TS supplies one timestamp for that PES; the importer interpolates the following AAC timestamps. Its next expected frame is at 598059959 µs. The next PES instead declares 598036733 µs, about one whole AAC frame earlier. The visible 6 µs backward step is the boundary between that interpolation and the next explicit anchor, not proof of a harmless 6 µs source-clock error.

The previous importer rounded every frame's duration down to 90 kHz ticks. It would put the preceding frame at 598036677 µs, making this boundary appear to advance by 56 µs. That cumulative timing error hid the overlap; restoring it would not repair the source.

Replaying the 28 numeric timestamps through the real JS Track, Group and Legacy Container produces exactly one discontinuity, at 598036733 µs. Watch treats that discontinuity as a decoder/render reset. The associated Safari measurement had 15616 silent output samples and no added concealment or late samples, consistent with rebuffering rather than an ordinary underrun. This evidence identifies the loop-reset cause; it does not establish that every other audio problem is fixed.

## Retained synthetic verification

```sh
bun debug-findings/neteq-rd/source-timeline-verify.ts
```

The verifier contains the 28 numeric timestamps and creates one-byte synthetic payloads. It asserts all timestamps survive delivery and exactly the observed discontinuity occurs. It does not decode audio or require the BBB file. The existing media CI job runs it. The test preserves explicit rewind classification; it is not an audio-quality test or an endorsement of silently tolerating overlapping packets.

## Separately named normalized diagnostic publication

The following is a proposed comparison command, not a command run during the measurements. Run it only when other measurements have stopped, using a local relay and a built `moq` binary on PATH:

```sh
set -o pipefail
ffmpeg -hide_banner -loglevel warning \
  -stream_loop -1 -re -readrate_catchup 1 \
  -i demo/pub/media/bbb.mp4 \
  -map 0:v:0 -map 0:a:0 \
  -vf 'fps=24,setpts=N/(24*TB)' \
  -af 'aresample=44100:async=1:min_hard_comp=0:first_pts=0,asetpts=N/SR/TB' \
  -c:v libx264 -preset veryfast -crf 23 -g 48 \
  -c:a aac -ar 44100 -b:a 160k \
  -f mpegts -pes_payload_size 2930 - \
  | moq --connect http://localhost:4443 \
      --broadcast rd-bbb-normalized-diagnostic.hang import ts
```

This deliberately changes the source. Audio is decoded, timestamp gaps are filled, overlapping samples are trimmed, and the result is re-encoded on a continuous sample clock. Video is re-encoded at 24 fps on a continuous frame clock. Filters and encoders remain open across file loops. FFmpeg documents `async=1` as fill/trim compensation; lowering `min_hard_comp` makes it address the short authored gaps, and `first_pts=0` defines the initial audio boundary. See the [FFmpeg resampler documentation](https://ffmpeg.org/ffmpeg-resampler.html).

This publication is a proposed transport/playback comparison input. It changes compressed bytes, source gap behavior, video timing, bitrate and publisher CPU load. A successful run would not prove the original BBB publication was fixed or reproduce its exact load. Verify the normalized output's packet cadence and repeat the same render counters before using it as a steady-delivery baseline. Keep the original source as the adversarial timeline case.

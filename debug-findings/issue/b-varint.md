### Summary

On `dev`, `<moq-watch>` in auto mode (the "Auto" chip; `latency="real-time"` maps to it) computes its jitter term as `1.25 x minRTT` without rounding and passes the resulting `maxAge` straight into the SUBSCRIBE varint. On any path whose product is not an integer (every real path; localhost's 1 ms RTT lands on the 20 ms integer floor) the varint encoder throws, both media subscriptions fail with no retry, and the element sits at `status=live` with 0 bytes for as long as it lives. Split out of #3477, where it blocked measuring auto mode on `dev` against the public relay.

### Environment

- `upstream/dev` 30ef2a3de (chore: merge main into dev, 2026-09-06), `js/watch` and `js/net` unmodified apart from timestamp probes.
- Chrome 152.0.7977.82 and Safari 26.6 on macOS 26.6.1 (Mac mini, Apple M4).
- Public relay `https://cdn.moq.pro/demo`, broadcast `bbb.hang`, RTT 46 ms in the run quoted below (39 ms in a second run, same outcome).
- Not present on `upstream/main` (234569928), see below.

### Observed

Console 0.9 s after connect:

```
subscribe error: id=2 broadcast=bbb.hang track=0.avc3 error=The number 60.5 cannot be converted to a BigInt because it is not an integer
subscribe error: id=3 broadcast=bbb.hang track=0.aac error=The number 57.5 cannot be converted to a BigInt because it is not an integer
```

followed by an unhandled `spawn error`. Nothing resubscribes. For the whole 60 s window the element reports `status=live`, audio stalled, video stalled, 0 bytes received. The catalog subscription (integer priority, no `maxAge`) keeps working, which is why the status says live.

### Mechanism

- `js/watch/src/sync.ts` `#runJitter`: `jitter = max(20, minRtt * 1.25)` with no rounding (46 ms -> 57.5, 39 -> 48.75).
- `js/watch/src/media.ts` `subscribeMedia` passes `sync.out.maxAge` (codec floor + jitter, 60.5 for video and 57.5 for audio here) into `Subscription.maxAge` unchanged.
- `js/net/src/lite/subscribe.ts` writes it with `w.u53(this.maxAge)`, and `js/net/src/varint.ts` `encodeTo` converts through `BigInt`, which throws `RangeError` on a non-integer.
- The throw happens inside the media subscription's `spawn`, so nothing catches it and nothing retries.

### Why `main` does not show it

`upstream/main` rounds the wire value with `Math.ceil` in `js/watch/src/audio/subscription.ts` (added by #3114, with a unit test that feeds it 38.75 ms and 500.25 ms). `dev` never had that file: its `media.ts` (from #2926, reshaped by #3396) carries no rounding, and each merge of main into dev (bac2850c8, ac69338ad, b4cc67aa3, 30ef2a3de) resolved the conflict by dropping main's `subscription.ts`, so neither the rounding nor its test reached dev.

### Repro

`<moq-watch url="https://cdn.moq.pro/demo" name="bbb.hang" latency="real-time">` (or `delay="auto"`) on `dev`, against any relay with an RTT of 17 ms or more whose `RTT x 1.25` is not an integer. With a diagnostic `Math.ceil` on the wire value in `media.ts` the same page subscribes and plays; that is how the auto rows on `dev` in #3477 were measured.

Tested: `upstream/dev` 30ef2a3de1d469a591ee2c14ccdb81ded20857ec; `upstream/main` 234569928de0d45fc0d9b2e61769b17a89d0cd23 read for `subscription.ts`.

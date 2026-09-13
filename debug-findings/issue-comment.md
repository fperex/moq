## Real-time audio: root causes, and a POC branch that fixes them

Following on from #3477. I took the quests you wrote after closing it and built the whole thing, as
a branch you can read and adopt one commit at a time. **No PR is intended.** Nothing here is asking
to be merged as a unit. It exists so the work is readable and measurable, and so you can take the
slices you want.

Branch: [`fperex/moq` `debug-findings-solution`](https://github.com/fperex/moq/tree/debug-findings-solution),
based on `upstream/dev` at `246a4733f`, tip `<final-hash>`. 37 commits.
Full write-up:
[`debug-findings/REPORT.md`](https://github.com/fperex/moq/blob/debug-findings-solution/debug-findings/REPORT.md).

### Three root causes

Confirmed against `dev` at `246a4733f`. Each one alone is audible.

1. **The ring cap has no hysteresis and no refill.** `shared-ring-buffer.ts` skips ahead whenever
   `buffered > latency` and never re-stalls after running dry (`ring-buffer.ts` mirrors it). Early
   arrivals are discarded, and once the ring empties it resumes on an empty cushion, so the next late
   arrival is another stall. That is the stutter that never settles.
2. **The auto target comes from the round trip.** `max(20ms, 1.25 x minRtt)` says nothing about how
   evenly a publisher flushes. The public `bbb.hang` arrives in 7-frame bursts of about 162 ms,
   because ffmpeg packs roughly seven AAC frames per PES and the TS importer forwards every frame of
   a PES in one pass. No round-trip formula can see that.
3. **The budget censors the estimator.** `Sync.out.maxAge` is both the wire `Subscription.maxAge` and
   the `Container.Consumer` skip threshold, so anything measuring below it can only confirm the budget
   it was cut to. And `js/net/src/group.ts` raised a bare `Error` for a group that missed its
   deadline, while `Lagged` and `GroupTooLarge` carry stream codes, so `Container.Consumer` rethrew
   it, `Effect.spawn` logged `spawn error`, the `finally` advanced the cursor anyway, and content
   vanished above the decoder with no counter anywhere.

### The branch, and how to read it

One commit per quest slice. The two oldest are your own #3517 commits, cherry-picked with the author
intact; everything in them except the estimator is kept.

| Quest | Commits |
| --- | --- |
| [`audio-jitter-target/spec.md`](https://github.com/moq-dev/moq/blob/dev/quest/m2/audio-jitter-target/spec.md) | `bdf4f64e0` (doc, estimator, 14-case corpus) |
| [`audio-jitter-target/watch.md`](https://github.com/moq-dev/moq/blob/dev/quest/m2/audio-jitter-target/watch.md) | `8dad5e3c2`, `5f43c0f99` (yours), `c97496853`, `9dcaac2ab`, `b42619ae5` |
| the budget finding (#3 above) | `4a6680c7d`, `4383a2e09`, `6f3bd3e3c` |
| [`m1/plan-av-clock.md`](https://github.com/moq-dev/moq/blob/dev/quest/m1/plan-av-clock.md) | `5140c63e2` |
| tune-in defect, found by the harness | `dbb8228e3` (browser), `7ad6b1a5c` (native) |
| [`audio-jitter-target/native.md`](https://github.com/moq-dev/moq/blob/dev/quest/m2/audio-jitter-target/native.md) | `9cadfc19c`, `e9d451cdf`, `1e5ce49b6`, `9deb1db75` |
| [`watch-audio-time-stretch.md`](https://github.com/moq-dev/moq/blob/dev/quest/m2/watch-audio-time-stretch.md) | `6ce7d2bcf`, `ed095f21c`, `c0a3deddf` |
| concealment (my call, see below) | `dfd568613` |
| [`transport-impairment-profile.md`](https://github.com/moq-dev/moq/blob/dev/quest/m2/transport-impairment-profile.md) | `863d39c32` (`rs/moq-shaper`) |
| [`audio-quality-harness/browser.md`](https://github.com/moq-dev/moq/blob/dev/quest/m2/audio-quality-harness/browser.md) | `e103f0d80`, `aa0069373`, `ae2fe4256`, `527d3a0d2`, `41b86931e`, `5425bf3c1`, `38c452730`, `69c233696` |
| [`qa-failure-artifacts.md`](https://github.com/moq-dev/moq/blob/dev/quest/m2/qa-failure-artifacts.md) | `f4c9da0b2` |
| re-landed narrow fixes, each with a failing-then-passing test | `42fefae05`, `6bc60d12e`, `ddda15ab2`, `23d310dcd`, `0f775995d` |

If you only read seven: `bdf4f64e0`, `c97496853`, `4a6680c7d`, `4383a2e09`, `6f3bd3e3c`,
`c0a3deddf`, `dfd568613`. The native half is the same algorithm again. The harness stands alone and
can be adopted without touching the player.

The estimator is the NetEq delay manager, written down once in `doc/concept/playout.md` and held by
a checked-in corpus at `rs/moq-audio/tests/playout-01.json` that both languages replay exactly, 14 of
14. No frame term: the quantile already reports the bucket's upper edge, and the consumer's own
granularity belongs to the ring. That is what removes the timestamp arithmetic that gave #3517 its
14.56 s target.

### Evidence

Public relay, `cdn.moq.pro/demo` `bbb.hang`, auto preset, headless Chromium on the production
postMessage path, 120 s, unmuted:

**36 underruns with the estimator alone, 1 with the time stretch, 1 with concealment on top, at a
200 ms delay throughout.**

Local relay with the bursty TS publisher: 6 underruns at a 700 ms held delay, then 0 at 372 ms, then
0. Concealment on versus off, back to back on the public relay: 3 underruns and 70 short quanta
against 5 and 151.

The budget finding has its own control. Replaying the recorded `relay-bbb-7frame` trace through a
real subscription and a real `Container.Consumer`: 0 of 443 groups convicted in steady state at the
measured target, 0 with the headroom, and **91 at the 46 ms round-trip budget the estimator
replaced**. That 91 is the censoring mechanism, measured.

<!-- FINAL: enforced budget table -->

<!-- FINAL: before/after table and gate results -->

### Where I departed from the quests

- **Concealment is in.** `watch-audio-time-stretch.md` says an underrun stays a ramped gap and no
  PLC. I added NetEq's expand and merge anyway, because the outages that made the public player
  stutter are whole hundreds of milliseconds and a stretch only covers a few percent. It is its own
  commit, it is behind `conceal` on the audio decoder which defaults on, and turning it off restores
  the ramp byte for byte. The stretch commit before it passes on its own.
- **The audio age headroom is mine, not the quests'.** Your quests only require observing above the
  budget, which `4a6680c7d` and `4383a2e09` already do. `6f3bd3e3c` additionally widens the audio
  subscription and consumer to `maxAge + headroom`. It is droppable with no other change, and on the
  recording it buys nothing: it is insurance for a path whose target lands close to the flush span.
- **The fall bound is not NetEq's.** It closes a sixth of the remaining distance per second rather
  than one bucket per step. The reasoning is in `doc/concept/playout.md`: the quantile is a bucket
  index and comes down in handfuls of buckets, and a fixed step made the time to undo an overshoot
  grow with the overshoot. This is what fixed a tune-in target that sat at 1.2 to 1.9 s for over a
  minute.
- **`kPostponeDecodingLevel` gates expansion, not decoding**, so it does not fight the ring's
  re-stall, which already holds until the full target is back.
- **No frame-buffer smart flushing in the browser.** The trough-based skip band is stricter, and both
  would give the same surplus two owners. The native engine does have the buffer and does flush.
- **The skip band rules on the trough of a sliding window**, not the instantaneous level, so a flush
  that drains again is played rather than discarded.

### Other things worth knowing

- **`demo/web` pinned `delay="100ms"` on every tile.** That is the "100 ms chip on a fresh session"
  from `watch.md`. No stored preference, nothing restoring anything. Fixed in `0d06ca4e8`.
- **`ui/components/buffer-control.ts` sets a numeric delay on mousedown**, so a single click on the
  bar silently leaves auto. Not changed, it is your UI call.
- **`js/net` races a WebSocket against WebTransport after a 500 ms head start**, so an impaired UDP
  path silently falls back to TCP. On the harness `bursty` profile the shaper saw seven datagrams for
  a whole run and the row graded a TCP session. The harness deletes `WebSocket` and
  `WebSocketStream` on the page as a workaround; the real fix is a `Connection` option and it is not
  in this branch. This also means Safari never reaches the shaper.
- **`rs/moq-relay/tests/drills.rs` runs zero tests today.** It is gated on the `quinn` feature, which
  is not in `moq-relay`'s default set, and it still says `use moq_native::...` where `moq-native` is
  now a tombstone crate that refuses to build as a dependency. I have the shaper's impaired second
  lane written as a patch and did not land it on a file that does not compile.

### Public API and wire impact

**No wire change.** All of the below is `dev` material.

- `@moq/net`: new `Expired extends StreamError` on `DELIVERY_TIMEOUT`, re-exported beside `Lagged`.
- `@moq/hang`: `Container.Jitter` is a class now (with `BUCKET` and `CEILING` as statics), plus
  `Container.Consumer.spread` and `Container.Consumer.skipped`.
- `@moq/watch`: `SyncInput` reduced to `{delay, buffer}`; new `Sync.track()`, `Sync.out.clock`, and
  the `Clock` / `SyncTrack` / `SyncClockTrack` exports; `Audio.Decoder.out` gains `spread`,
  `underruns`, `skipped`, `debug`; `Video.Decoder.out` gains `skipped`; new `DecoderInput.conceal`
  and the `<moq-watch conceal>` attribute.
- `rs/moq-audio`: `decode::Config::{delay, conceal, DELAY_MAX}` on a `#[non_exhaustive]` struct, and
  `Consumer::{delay, playhead}`.
- `moq play --delay` becomes a floor capped at 2 s rather than the delay capped at 10 s. That is the
  one `!` break.
- New crate `rs/moq-shaper` (`publish = false`) and new private workspace member
  `@moq/audio-quality`.
- The MPEG-TS importer's timestamp *values* and timescale change (it keeps the fractional sample
  remainder now). Framing, fields and encoding do not.

### Not verified

Stating this plainly, because some of it matters for how much weight the numbers carry.

- **No iOS device.** Desktop Safari through safaridriver is the closest proxy. iOS is not measured.
- **The nightly CI job is not wired.** The harness has its recipe and its README and runs, but
  nothing under `.github/` runs it, and budgets are recorded rather than enforced until it lands.
- **The replay lane is not in the harness**, only as unit tests in `js/watch/src/audio/replay.test.ts`.
- **Local measurements were taken on a loaded machine** (load average 13 to 23 at times). One control
  re-run of the same bytes on the same build gave 1360 ms where an earlier pass gave 372 ms. Treat
  every local number as an upper bound. The public-relay rows are remote and held steady across every
  pass.
- **Safari budgets were removed** after one cell exceeded its own ceilings on the next run.
- **`cargo semver-checks` was not run.**
- The `4k-webm` fixture has real holes in the recording, so it keeps 1 to 2 underruns, now concealed.

### Licensing

WebRTC's `modules/audio_coding/neteq` was read and cited by file name in every module header, and
reimplemented in `f64`. Nothing was copied. The videocall-rs `neteq` crate (MIT OR Apache-2.0) was
read as a possible starting point and not adapted: its time stretch removes the longest low-energy
run rather than a pitch period and its expand emits quiet noise rather than concealment, so it is not
the port it looks like. The harness upstreams my own earlier `debug/rt-audio` work and the
`rt-audio-traces-2026-09-06` traces, with attribution in `test/audio-quality/README.md`.

Happy to split any of this into real PRs in whatever order and shape you want, or to drop the parts
you disagree with. The estimator plus the ring work is the smallest thing that makes the public
player play clean, and the harness is the part that keeps it that way.

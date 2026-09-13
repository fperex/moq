# Real-time audio playout: what was wrong, what this branch does about it

Branch: `fperex/moq` `debug-findings-solution`, based on `upstream/dev` (`246a4733f`).
Tip at the time of writing: `<final-hash>`. 37 commits, 138 files, +27750/-666.

## Summary

1. `<moq-watch>` at the "Real-time" / auto preset stutters (moq-dev/moq#2812, #3477).
2. Three separate defects produce it, and each one alone is enough to be heard.
3. The auto delay came from the round trip, which cannot see how unevenly a publisher flushes.
4. The audio ring skipped whenever it ran long and never re-stalled after running dry.
5. The age budget was also the container's skip threshold, so the estimator under it could only confirm the budget it was cut to.
6. This branch replaces the estimator with the algorithm NetEq uses, written down in `doc/concept/playout.md` and held by a checked-in corpus that both languages replay.
7. The ring then converges by time stretch rather than by skipping, and conceals an outage rather than playing silence.
8. `rs/moq-audio` gets the same engine, so `moq play` has a jitter buffer for the first time.
9. `test/audio-quality` measures all of it over a seeded impaired path, in Chromium and in real Safari.
10. On the public relay at auto, over 120 s: 36 underruns before the engine, 1 after.

No PR is intended. This is a proof of concept the maintainer can adopt one commit at a time.

## How to read the branch

One commit per quest slice, in the order they were written. Each one compiles, tests, and is
readable alone. The two oldest are the maintainer's own, cherry-picked from the closed PR #3517
with their author intact.

| # | Commit | Quest / stage | What it is |
| --- | --- | --- | --- |
| 1 | `8dad5e3c2` | #3517 (kixelated) | Auto sized from measured arrivals, ring slack, re-stall, `stall()`, underrun counter |
| 2 | `5f43c0f99` | #3517 (kixelated) | Short quantum counts as an underrun, stale arrival minimum expires |
| 3 | `bdf4f64e0` | `audio-jitter-target/spec.md` | `doc/concept/playout.md`, the NetEq estimator, the 14-case corpus and its generator |
| 4 | `c97496853` | `audio-jitter-target/watch.md` | Auto sized from the target, render quantum moved into the ring, advertised jitter the floor and 2 s the ceiling |
| 5 | `9dcaac2ab` | review follow-up | Arrival clock read before the container is parsed; the arrival test made real |
| 6 | `863d39c32` | `transport-impairment-profile.md` | `rs/moq-shaper`, a seeded userspace UDP path impairment with counters |
| 7 | `6ce7d2bcf` | `watch-audio-time-stretch.md` (native half) | Accelerate, preemptive expand, expand, merge, background noise, in Rust |
| 8 | `b42619ae5` | review follow-up | `Container.Jitter` is the class, not a namespace |
| 9 | `4a6680c7d` | budget finding, part 1 | `Expired` on `StreamCode.DeliveryTimeout` |
| 10 | `4383a2e09` | budget finding, part 2 | A censored group is counted, not a `spawn error` |
| 11 | `6f3bd3e3c` | budget finding, part 3 (fork addition) | Audio subscribes and consumes at `maxAge + headroom` |
| 12 | `0d06ca4e8` | finding | `demo/web` tiles start in auto instead of a hard-coded `100ms` |
| 13 | `64fd96e55` | CodeRabbit | Buzz fixture period sized from the signal it built |
| 14 | `5140c63e2` | `m1/plan-av-clock.md` | The audio playhead drives `Sync.reference`; `sync.track()` replaces the flat inputs |
| 15 | `dbb8228e3` | tune-in defect (browser) | A receiver's own reading stall stays out of the target; proportional fall |
| 16 | `9cadfc19c` | `audio-jitter-target/native.md` | The native estimator, same corpus, `f64` |
| 17 | `e9d451cdf` | `audio-jitter-target/native.md` | The native engine: frame buffer, decision loop, playhead |
| 18 | `7ad6b1a5c` | tune-in defect (native) | The same two rules in Rust |
| 19 | `1e5ce49b6` | `audio-jitter-target/native.md` | `decode::Config::delay` turns it on; `moq play --delay` becomes a floor |
| 20 | `9deb1db75` | native test | The native guards hold to the fourteenth corpus case |
| 21 | `ed095f21c` | `watch-audio-time-stretch.md` | The ring reader splits into `view`, `peek`, `commit` |
| 22 | `c0a3deddf` | `watch-audio-time-stretch.md` | The browser engine: the ring converges by stretch rather than by skipping |
| 23 | `f4c9da0b2` | `qa-failure-artifacts.md` | A failing run keeps its directory |
| 24 | `e103f0d80` | `audio-quality-harness/browser.md` | `test/audio-quality`: page, probe, driver, sink, analyzer, grader, schema |
| 25 | `aa0069373` | harness | The page denies the WebSocket fallback so the shaper is in the path |
| 26 | `ae2fe4256` | harness | Budgets recorded from the full matrix, not enforced |
| 27 | `527d3a0d2` | harness | The probe can read a build it was not written against |
| 28 | `41b86931e` | harness | The probe's generic helper is a function declaration, not an arrow |
| 29 | `5425bf3c1` | harness | `skipped_groups` and the clock source become real numbers |
| 30 | `38c452730` | CodeRabbit | A void row fails the run; the probe's remaining reads are guarded |
| 31 | `dfd568613` | concealment (user decision) | The browser twin of expand and merge, behind `conceal`, default on |
| 32 | `42fefae05` | re-land | MPEG-TS importer keeps fractional sample ticks |
| 33 | `6bc60d12e` | re-land | Authored audio gaps render as silence before encoding |
| 34 | `ddda15ab2` | re-land | A file's audio format is learned from its first decoded sample |
| 35 | `23d310dcd` | re-land | The video encoder's admission queue is bounded |
| 36 | `0f775995d` | re-land | Native chunks bridge into the Libav polyfill when one codec is missing |
| 37 | `69c233696` | `audio-quality-harness/browser.md` | A real Safari lane over safaridriver |

Suggested reading order for review: 3, 4, 9 to 11, 21, 22, 31. Those seven are the fix. The native
half (7, 16 to 20) is the same algorithm again and can be read second or skipped entirely. The
harness (6, 23 to 30, 37) stands alone and can be adopted without any of the player changes.

## Root causes

Three defects, confirmed against `upstream/dev` at `246a4733f`.

### 1. The ring cap has no hysteresis and no refill

`js/watch/src/audio/shared-ring-buffer.ts` skipped ahead whenever `buffered > latency`, and never
re-stalled after running dry. `ring-buffer.ts` mirrored it. Early arrivals were discarded, and the
moment the ring emptied it resumed on whatever landed next, on an empty cushion, so the next late
arrival was another stall. That is the stutter that never settles: at auto on the public relay,
most of a minute could be silence.

### 2. The auto target came from the round trip

`js/watch/src/sync.ts` computed `max(20ms, 1.25 x minRtt)`, plus a codec floor, with a flat 100 ms
fallback. The round trip says nothing about how evenly a publisher emits frames. The public
`bbb.hang` arrives in 7-frame bursts of about 162 ms, because ffmpeg packs roughly seven AAC frames
per PES and the TS importer forwards every frame of a PES in one pass. No round-trip formula can see
that, so the ring was sized for a retransmit and never held enough to play through a flush.

### 3. The budget censored the estimator

`Sync.out.maxAge` was both the wire `Subscription.maxAge` and the `Container.Consumer` skip
threshold. Any estimator measuring below it can only ever confirm the budget it was cut to. Worse,
`js/net/src/group.ts` raised a bare `Error` for a group that missed its deadline, while the sibling
verdicts `Lagged` and `GroupTooLarge` carried stream codes. `Container.Consumer` rethrew it,
`Effect.spawn` logged `spawn error`, the `finally` advanced the cursor anyway, and content
disappeared above the decoder with no counter anywhere.

### What upstream had already done

#3478 is fixed by #3508. #3479 is fixed by #3513 and #3516. #3477 was closed as a re-plan (#3576).
#2812 is still open. PR #3517 was closed unmerged: its estimator learned a frame duration from the
gap between consecutive media timestamps, so a tune-in that saw one frame of a stale group and then
the live edge read 14560 ms on its own head, and was still at 14360 ms ten seconds later. Everything
else in #3517 is kept here.

## What changed, per stage

### The written algorithm and the corpus

`doc/concept/playout.md` is the algorithm, 450 lines, written once so two languages can be held to
it: the observation point, relative arrival delay against a min-deque over 2 s of media time, the
reordered-arrival rule without sequence numbers, 500 ms max-over-interval resampling, the 100 x
20 ms histogram with its seeded prior and its cold-start forget ramp, the 95th percentile walk, the
rise and fall rules, re-anchoring, the "plus one frame" decision, a parity-trap list, and the corpus
contract.

The corpus is `rs/moq-audio/tests/playout-01.json`, 14 cases, generated by
`js/hang/src/container/jitter.vectors.ts` and freshness-checked in both languages. Every expected
target is an integer multiple of 20 ms, so an `f64` difference between V8 and rustc cannot break
parity. Both implementations replay it exactly, 14 of 14.

The corpus lives in `rs/moq-audio` for the same reason `moq-json`'s vectors live where they do: the
crate that must `include_str!` it owns it, and `cargo package` cannot reach outside a package root.
`js/hang` generates it, and the JS scope in `js/justfile` covers that one path.

### The estimator and its wiring

`js/hang/src/container/jitter.ts` is the estimator. It observes at container frame arrival, before
the age budget can skip a group, one clock read per wire frame, taken before `Format.decode` runs so
this receiver's own parsing cost is not folded into a measurement of the network.

`Sync` now has a floor and a ceiling rather than a formula. The rendition's advertised catalog jitter
is a publisher-declared flush span and the measured target is a measurement of the network, so auto
is the larger of the two, a fixed delay is their sum, and the ceiling is the estimator's own
histogram range. The render quantum left `playbackJitter()` and went into both rings' skip band,
where it was always describing something: a ring drains in whole blocks, so it sits a block above the
target between reads, and cutting audio for that is cutting audio the reader was about to play.
Native has no worklet, which is the other half of why it cannot be in a number two languages have to
agree on.

The shared ring is now sized for the 2 s ceiling at construction. It used to be sized from the
initial delay, so an auto target climbing past it would have been capped by the overflow path with
nothing saying why. A target above capacity throws instead.

### The budget

Three commits, the third droppable.

`Expired` is a `StreamError` on `StreamCode.DeliveryTimeout`, the code already registered for this,
so a caller that checks `err.code` reads the same answer whether the local budget gave up or a peer
reset the stream with it. `fromTransport` decodes it back.

`Container.Consumer` then marks the group truncated, counts it, and rethrows only a real failure.
`#checkMaxAge` feeds the same counter once per shifted group. The counter reaches
`Audio.Decoder.out.skipped` and `Video.Decoder.out.skipped` and shows as a Skipped row beside
Underruns. An underrun count alone cannot show this: the ring never ran dry, the frames simply never
got there. Every `instanceof StreamError` catch in `js/` was audited for the new subclass;
`watch/text/renderer.ts` and `watch/broadcast.ts` got the same correction, and nothing else changed.

The third commit is this fork's addition. Audio subscribes and consumes at `maxAge + headroom`, where
the headroom is the rounding between the two numbers and nothing more: one histogram bucket, one
frame duration, one stretch bound. `Sync.out.maxAge` itself is untouched, so video and the
`Sync.received` lookahead cap keep their semantics.

### The A/V clock

`Sync.reference` follows the audio playhead while audio plays. Both transports already knew where the
reader was, the shared ring through its read cursor and the postMessage ring through its state
message; each now reports it as a media position with the rate it is advancing at. Sync extrapolates
locally between samples, so the per-frame `wait()` never crosses a thread. A re-stall reports a rate
of zero and playback parks with it. A mute, an ended track, or a park that stops looking like a
refill hands the clock back to the wall clock at the last value the playhead gave.

`SyncInput` is down to `{delay, buffer}`. The advertised delay and the measured spread are per-track
handles now, from `sync.track("audio" | "video" | "text")`, which is also where a track nominates its
playhead. Captions join without another pair of inputs.

### The tune-in defect

This one was found by the harness and is worth reading on its own, because it is the bug that made
the first estimator look like it did not work.

A viewer tuning in on a busy machine sat at a 1.2 to 1.9 s auto target twenty seconds later, falling
at exactly 20 ms a second. Neither number came from the network. The receiver's main thread blocks
for about 1.5 s at tune-in, on the decoder polyfill, the worklet start, and the first keyframe.
Nothing about the path changes: frames land on time and queue, and the read loop stamps every one of
them with the clock it reads when it runs again. The first frame out of the queue measured 1590 ms
against a reference taken before the block, the 500 ms resample interval committed that as its
maximum, and within 258 ms the receiver had drained 1834 ms of media and was back to a 13 ms steady
delay. Blocking the main thread for 1500 ms against a local relay reproduces it at 1620 ms.

Two rules, one at each end.

An arrival that follows a gap in the receiver's own reading longer than the resample interval, and
that covers less media than the gap was long, drops the arrival reference. The backlog behind it is
then measured against the path as the receiver can now see it. Dropping the reference and not the one
arrival is the point: every frame in the backlog is equally late against a reference from before the
gap, so skipping the first would leave the second to set the same interval maximum. The media term is
what separates the receiver from the publisher: a 1 fps track is idle for longer than the interval on
every arrival while its timeline advances just as far.

The fall bound closes a sixth of the remaining distance per second, one bucket at the floor. What a
ring refills in a second scales with what it holds, so a fixed step brakes hardest exactly where the
target is furthest from what the histogram asks for. A sixth closes the histogram's whole range
inside the 29 s the histogram remembers, so the limiter can never outlast the observation that raised
the target.

Measured on one set of live arrivals from a local relay with a 1500 ms block, the target every two
seconds for the first thirty:

```
before   80 140 160 1480 1480 1480 1460 1440 1400 1340 1300 1260 1240 1180 1140 1120
fall     80 140 160 1480 1480 1480 1280 1120  860  600  480  400  380  320  280  260
both     80 140 160  160  160  240  240  240  220  180  160  160  180  180  180  160
```

All thirteen existing corpus cases are byte identical under both rules. The fourteenth,
`tune-in-stall`, records the shape and reads 1540 ms without the fix and 140 ms with it, in both
languages, to the millisecond.

### Time stretch

`js/watch/src/audio/playout/` holds one file per NetEq role and mirrors `rs/moq-audio/src/playout/`
file for file and constant for constant:

| File | Mirrors |
| --- | --- |
| `level.ts` | `buffer_level_filter.cc` |
| `decision.ts` | `decision_logic.cc` |
| `stretch.ts` | `time_stretch.cc`, `accelerate.cc`, `preemptive_expand.cc` |
| `expand.ts` | `expand.cc` |
| `merge.ts` | `merge.cc` |
| `noise.ts` | `background_noise.cc` |
| `sync.ts` | `sync_buffer.cc` |
| `index.ts` | the loop that runs them |

The ring reader split into `view`, `peek`, and `commit` first, with `read` as the three in a row, so
the worklet can look at the ring before deciding what to do with the media. No behaviour change:
every #3517 ring test passes unchanged.

Per 20 ms output block the engine filters the buffer level, and if the level sits above
`target + chunk + 20ms` it drops one pitch period, or below the target and above half of it repeats
one, by the WSOLA splice NetEq uses: a 4 kHz coarse search over 2.5 to 15 ms lags, one full-rate
normalised correlation at the peak, and a passive gate at eight times the background so room tone
splices without a correlation at all. At most 15 ms per 100 ms of output, so convergence is a few
percent and inaudible.

The skip-ahead is now the last resort. Its band is `target + chunk + 75ms`, and it rules on the
trough between two flushes rather than on the peak, so a flush that drains again is played rather
than discarded. The same 75 ms is the stretch term of the audio age budget's headroom, exported once
as `STRETCH_BOUND`.

Both rings publish what the engine did, so the media playhead is `READ - queued` and its rate the
measured one rather than an output frame count a stretch has moved.

### Concealment

When the ring runs dry mid-playback the reader carries the audio on instead of ramping to silence:
the pitch period of the last real audio, repeated with a voiced and unvoiced mix set by how periodic
the signal was, fading toward a noise floor measured from the stream itself, giving up after two
seconds. When the media comes back it is aligned against the concealment and crossfaded in. That is
NetEq's expand and merge. A hole that reaches the playhead with nothing behind it is no longer queued
as silence by the ring either: playing it would make a listener wait for the same missing audio
twice, once while the reader covers for it and again when the zeros arrive.

`conceal` on the audio decoder, default on, turns it off and the ramp is back byte for byte.

The invariant grows a term, since concealed frames are output but not media:

```
READ == output - concealed + stretched + queued + skipped
```

and the playhead rate follows at `1 + (dSTRETCHED - dCONCEALED)/dOUTPUT`, so video waits with the
audio rather than running through a concealed gap.

### The native engine

`rs/moq-audio/src/playout/` is the same engine in Rust, 4480 lines across 14 files, with the module
header carrying the role-to-`.cc` table. Three things differ from NetEq by design: PCM in and PCM
out, because decoding stays in `decode`; the sink pulls, because the speaker asks for one block at a
time on the device clock; and `f32` samples with `f64` arithmetic, because NetEq is fixed point only
because it targets DSPs.

`decode::Config::delay` turns it on, and `Consumer::read` then hands back one 10 ms block per call
rather than whatever packet came out of the decoder. The block is always there: what arrived is
folded in, what did not is concealed, and nothing waits on the network. That is what lets the
speaker's own clock pace the pulls.

It runs on the decode task, ahead of a 30 ms device cushion, not inside the device callback. The
callback mixes every sink on the device and may not allocate, lock, or log, and the engine does all
three, so a stream that had to conceal would cost every other stream on the device a dropout.

Arrivals are measured off the container, before the age budget. The budget then follows the target
rather than the config, and `Config::max_age` becomes the ceiling on how deep the buffer may grow
rather than the budget itself. A floor that does not fit under the budget is refused at construction:
playout claims three quarters of it, so a budget four thirds of the floor would pin the target to the
floor, and a measured buffer that can never measure anything is a fixed one with extra steps.

Replaying the same trimmed traces, the native engine settles on the same 80 ms and 240 ms targets the
browser does, and the corpus passes 14 of 14.

### The harness

`test/audio-quality` plays a broadcast in headless Chromium over an impaired UDP path and counts what
a listener would have heard. The matrix is codec x profile x ring: 48 kHz Opus over fMP4 and
44.1 kHz AAC over MPEG-TS with ffmpeg's default PES packing, six profiles from `moq-shaper`, and both
the isolated and the postMessage ring, which is the production path. 24 rows.

`rs/moq-shaper` is a new workspace crate, `publish = false`. It binds one socket, gives each observed
client 4-tuple its own upstream socket, and runs every datagram through one queue ordered by release
time with arrival order breaking ties, so a reorder is always a deliberate extra delay and never a
scheduler artifact. Each direction draws from its own seeded generator in a fixed order per datagram.
TCP on the listen port is pumped through untouched, because a relay serves `/certificate.sha256` over
HTTP on the same port and shaping a reliable transport would only measure how it retransmits. The
counters are as much the point as the impairment: a profile that silently treated nothing turns an
impaired run into an unimpaired pass, so a row whose active profile delayed nothing is void.

Four things void a row rather than passing it quietly: the shaper's counters must show it treated
traffic; the session must have negotiated WebTransport rather than the TCP fallback that never
reaches the shaper; the document's isolation must match the ring the row asked for; and an
`AudioContext` whose `currentTime` stops tracking wall time voids the row, because that produces a
full set of plausible counters and reads as a flawless run.

The metric schema in `src/schema.ts` is the deliverable that outlives this: units, clocks, stages as
exclusive spans with a named remainder, and an aggregation per metric, read by the page, the
analyzer, and the grader alike. Counters whose signals do not exist yet report null rather than zero,
and say which change would fill them in.

The Safari lane is real Safari over safaridriver, not Playwright's WebKit, which is a different
network stack, media pipeline, and AudioWorklet scheduler. Three things follow from the engine and
each changes what the lane may claim: `@moq/net` refuses WebTransport on WebKit, so the session is a
WebSocket, which is TCP, which the shaper passes through, so those rows record `shaper: none` and
offer only the two profiles whose treatment is already nothing; Safari has to be frontmost, because
an unfocused window answers an Element Click with `{"value":null}` and the context sits in WebKit's
`interrupted` state over total silence; and `renderCapacity` is Chromium's alone, so `render_load` is
null and `worklet_cadence` stands in.

## Evidence

### The public relay, at auto, 120 s

Headless Chromium, the production postMessage path, `cdn.moq.pro/demo` `bbb.hang`, unmuted, the real
`sites/watch` page built against this tree.

| Build | Delay | Underruns | Short quanta | Concealed | Merges | Skips |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| estimator only | 200 ms | 36 | - | - | - | 0 |
| plus time stretch | 200 ms | 1 | 59 | - | - | 0 |
| plus concealment | 200 ms | 1 | 124 | 200 ms | 2 | 1 |

The estimator-only build predates the engine and publishes no engine counters, so its short-quanta,
concealed and merge columns are absent rather than zero.

### Local relay, bursty publisher

The same page against a local relay publishing MPEG-TS with ffmpeg's default PES packing, which is
the arrival shape the public relay has.

| Build | Delay held | Underruns |
| --- | ---: | ---: |
| estimator only | 700 ms | 6 |
| plus time stretch | 372 ms | 0 |
| plus concealment | 372 ms | 0 |

### Concealment on versus off

Back to back on the public relay, the only difference being `conceal` on the element, set before the
page connected.

| conceal | Delay | Underruns | Short quanta | Concealed | Merges |
| --- | ---: | ---: | ---: | ---: | ---: |
| on | 200 ms | 3 | 70 | 360 ms | 3 |
| off | 200 ms | 5 | 151 | 0 | 0 |

On the rare-tail traces from the first investigation, the 165, 220 and 111 ms gaps, concealment turns
130 silent quanta into 0.

### Tune-in

The estimator-only build settled between 0.9 and 1.9 s and stayed there for a minute on a loaded
machine. With both tune-in rules it settles within 5 s, and the ramp is gone from every lane.

### Replay

Recorded arrival traces replayed through both rings on a simulated clock. `lan-bbb` and
`relay-bbb-7frame` play with zero underruns and zero skipped samples after the target settles,
against 1 and 9/26 underruns at the round-trip target. `4k-webm` keeps one dry ring and one too-late
frame, which are holes in the recording itself.

The A/V clock, replaying the recorded LAN trace through the real ring: video runs 7.1 ms ahead and
64.3 ms behind the audio a listener can hear, against 34.2 ms and 80.0 ms when it paced itself
against a wall clock.

### The budget

`budget-censors-the-tail` in `replay.test.ts` replays `relay-bbb-7frame` through a real subscription
and a real `Container.Consumer`. In steady state: 0 of 443 groups convicted at the measured target,
0 with the headroom, and 91 at the 46 ms round-trip budget the estimator replaced. The measured
target already clears this publisher's 139 ms flush span by a wide margin, so on this recording the
headroom buys nothing. It is insurance against a path whose target lands close to the flush, not a
fix for what was recorded. The 91 is the control that shows the censoring mechanism is real.

### CPU

`stretch.bench.test.ts` drives 60 s of quanta through the stubbed worklet forcing one operation per
100 ms. p999 of `process()` is 0.02 ms against a 0.67 ms budget, a quarter of the quantum, both while
stretching and while concealing.

### Harness, before and after the estimator

24 rows at 40 s, `upstream/dev` against the estimator-only tree, recorded in the run directory. The
shape is the same across the matrix: discarded audio falls sharply and the target inflates.

| Row | Skipped ms/min | Target p95 |
| --- | --- | --- |
| opus, high-rtt, plain | 11491 -> 1935 | 156 -> 1760 ms |
| opus, bursty, plain | 6921 -> 369 | 186 -> 1540 ms |
| aac, bursty, plain | 5828 -> 85 | 395 -> 440 ms |
| opus, mild, plain | 4912 -> 0 | 63 -> 1980 ms |
| opus, step, isolated | 5504 -> 0 | 67 -> 240 ms |

The inflated targets in that column are the tune-in defect, not the estimator: those runs are 40 s
long, the main-thread block happens at tune-in, and the fall bound at the time held the target up for
the rest of the run. They are the measurement that led to the two rules above, and they are what the
enforced budgets are re-measured against.

<!-- FINAL: enforced budget table -->

<!-- FINAL: before/after table and gate results -->

## Departures from the quests

Each of these is deliberate and each is isolated so it can be dropped.

**Concealment is core here.** `watch-audio-time-stretch.md` keeps an underrun a ramped gap and says
no packet loss concealment. The user asked for NetEq's expand and merge. It is its own commit
(`dfd568613`), it is switchable with `conceal` on the audio decoder, and turning it off restores the
ramp byte for byte. The stretch commit before it passes its own budgets alone.

**The audio headroom is this fork's addition.** The quests only require observing above the budget,
which commits 9 and 10 already achieve, and `native.md` treats `max_age` as an independent ceiling.
Commit 11 is droppable with no other change.

**No frame term in the estimator.** `Container.Jitter` reports the bucket's upper edge and nothing
else. The consumer's own granularity, the render quantum in the browser and the sink period natively,
belongs to the ring above the estimator. That is what removes the timestamp-derived spacing that
produced #3517's 14.56 s.

**The fall bound is not NetEq's.** NetEq falls one bucket per step. This falls a sixth of the
remaining distance, one bucket at the floor, and `doc/concept/playout.md` argues why: the quantile is
a bucket index and comes down in handfuls of buckets at a time, which a fixed step cannot follow, and
the time to undo an overshoot should not grow with the overshoot.

**`kPostponeDecodingLevel` is re-pointed.** NetEq uses the half-target hysteresis to postpone
decoding. Here it gates expansion, so it does not fight a refill: the ring's re-stall already holds
until the full target is back. The deviation is documented at the site.

**No frame-buffer smart flushing in the browser.** The trough-based skip band is stricter than a
partial flush toward target would be, and adding both would give the same surplus two owners. The
native engine has the frame buffer and does flush.

**The skip band rules on a trough.** A flush that drains again within the window is played rather
than discarded, so the band is not evaluated on the instantaneous level the quests describe.

## Findings for the maintainer

Things found while working that are separate from the fix.

1. **`demo/web` pinned `delay="100ms"` on every tile.** That is the "100 ms chip on a fresh session"
   from `watch.md`. Nothing was restoring anything, and no storage was involved. Fixed in
   `0d06ca4e8`.
2. **`ui/components/buffer-control.ts` sets a numeric delay on mousedown.** A single click on the bar
   therefore leaves auto without the user asking for a value. Not changed here; it is a UI decision.
3. **The released `latency` attribute falls back to a silent 100 ms** for an unparseable value, where
   its `delay` sibling warns and falls back to the element default. Made consistent in `c97496853`.
4. **`js/net` races a WebSocket against WebTransport after a 500 ms head start.** Any path that slows
   the QUIC handshake past that head start silently falls back to TCP. On the harness's `bursty`
   profile the shaper saw seven datagrams for a whole run, and the row measured a TCP session that
   never touched it. The harness works around it by deleting both `WebSocket` and `WebSocketStream`
   on the page before the module loads, which is a test hack. The real fix is an option on
   `Connection`, and it is not in this branch.
5. **`rs/moq-relay/tests/drills.rs` compiles zero tests today.** It is gated
   `#![cfg(all(feature = "quinn", feature = "websocket"))]`, and `quinn` is not in `moq-relay`'s
   default feature set, so `just test drill` runs nothing. It also still says `use moq_native::...`,
   and `moq-native` is now a tombstone crate that refuses to build as a dependency, so the file would
   not compile even with the feature on (34 API-rot errors when measured in session). A patch adding
   the shaper's impaired second lane, which `transport-impairment-profile.md` asks for, is written
   and was deliberately not landed on top of a test file that does not build.
6. **Safari takes the WebSocket path**, so the shaper does not apply to it and the Safari lane grades
   an unimpaired path. The lane records `shaper: none` rather than labelling an unimpaired run
   `bursty`.
7. **`conceal` needed an element attribute** to be settable from a page before connect, so
   `<moq-watch conceal>` exists. It is the only new attribute.

## Public API and wire impact

No wire change anywhere. All of the below is `dev` material.

**`@moq/net`**
- New `Expired extends StreamError`, re-exported as `Moq.Group.Expired` beside `Lagged`. A peer's
  `DELIVERY_TIMEOUT` reset now decodes to it rather than to a plain `StreamError`: same code, same
  base class.

**`@moq/hang`**
- `Container.Jitter` is now a class, not a namespace. `Container.Jitter.BUCKET` and
  `Container.Jitter.CEILING` are static readonly members rather than module exports.
- New `Container.Consumer.spread` and `Container.Consumer.skipped`.

**`@moq/watch`**
- `SyncInput` is reduced to `{delay, buffer}`; it loses `probe`, `audio`, `video`, `audioSpread` and
  `videoSpread`.
- `Sync.track()` is new, and `Sync.out.clock` names whichever track is driving playback.
- `Clock`, `SyncTrack` and `SyncClockTrack` are new exports.
- `Audio.Decoder.out` gains `spread`, `underruns`, `skipped` and `debug`.
- `Video.Decoder.out` gains `skipped`.
- `DecoderInput.conceal` is new, with the element attribute `<moq-watch conceal>`.
- `audioMaxAge` and `maxAgeHeadroom` are new in the audio config module.

**`rs/moq-audio`**
- `decode::Config::delay`, `decode::Config::conceal`, `decode::Config::DELAY_MAX`. `Config` is
  `#[non_exhaustive]`, so these are additive for callers who build through `new`.
- `decode::Consumer::delay` and `decode::Consumer::playhead`.
- `Consumer::read` returns one 10 ms block rather than a decoder packet when `delay` is set.

**`moq play`**
- `--delay` is a floor rather than the delay, and is capped at 2 s, the estimator's range, rather than
  the speaker ring's 10 s. That is the `!` break on this branch.

**New crate**
- `rs/moq-shaper`, `publish = false`. `Shaper::{bind, local_addr, report, run}`, `Config`, `Counters`,
  `Report`, `Profile::{parse, names}`, `Direction`, `Burst`, `ByteRate`, `Step`.

**New private workspace member**
- `@moq/audio-quality`, not published.

**Timestamp values, not format**
- The MPEG-TS importer now carries the fractional remainder of a sample duration between frames, so
  the timestamp values it emits change, and so does the timescale they are expressed in. The framing,
  the fields, and their encoding do not.

## Verification and limitations

### What was run

- `just fix`, `just check`, `just test` at every stage, scoped to the branch the way CI scopes them.
- The 14-case corpus, replayed in Bun and in nextest, exact integer equality on both sides.
- `bun test` over `js/hang/src/container`, `js/watch/src/audio`, and the sync tests.
- `just rs test -p moq-audio`.
- `just test audio-quality` over the full 24-row matrix, twice: once against `upstream/dev` and once
  against this tree.
- `just test audio-quality --runtime safari`, one 60 s run per row on macOS 26.6 Safari 26: eight
  rows graded, no voids, both rings.
- A CodeRabbit CLI triage per stage, each recorded. The findings that were real became their own
  commits: `64fd96e55`, `9dcaac2ab`, `38c452730`, and part of `5f43c0f99`.
- Listening rounds by the user after the estimator, after the stretch, and after concealment.
- Each of the five re-landed fixes has a test that fails without it and passes with it.

### What was not run, or not verified

- **No iOS device.** Desktop Safari over safaridriver is the closest proxy this branch has. iOS is
  not measured, and nothing here should be read as a claim about it.
- **The nightly CI job is not wired.** `test/audio-quality` has its recipe and its README, and
  `just test audio-quality` works, but no workflow under `.github/` runs it. Budgets are recorded,
  not enforced, until that lands.
- **The replay lane is not part of the harness.** Replay coverage exists as unit tests in
  `js/watch/src/audio/replay.test.ts`, not as a harness runtime with its own budget rows.
- **Local measurements were taken on a loaded machine.** Load average reached 13 to 23 during several
  passes, and everything driven by the local relay shares a CPU with the relay and two ffmpeg
  publishers. One control re-run of the same bytes on the same build gave 1360 ms where an earlier
  pass gave 372 ms. Treat every local number as an upper bound. The public-relay rows are remote,
  single-tile, and held steady across every pass they appear in.
- **Safari budgets were removed** after one cell exceeded its own ceilings on the next run. They were
  recorded at the worst observed times 1.5 and were not stable enough to keep.
- **`cargo semver-checks` was not run.**
- **The `4k-webm` fixture has real holes**, so it keeps 1 to 2 underruns, now concealed. That is the
  recording, not the player.
- **One pre-existing flaky `console.error` spy test** is fixed in the final commit on the branch.
- **`just test smoke-full` is the cross-language gate** for the `moq play` change and should be run
  before any of the native commits are adopted.

## How to run

```bash
# the whole branch, scoped the way CI scopes it
nix develop --command just fix
nix develop --command just check
nix develop --command just test

# the algorithm and its corpus, both languages
nix develop --command just rs test -p moq-audio
bun test js/hang/src/container/jitter.test.ts js/hang/src/container/jitter.vectors.test.ts

# the browser engine and the replays
bun test js/watch/src/audio

# regenerate the corpus; without --write it checks freshness instead
bun js/hang/src/container/jitter.vectors.ts --write

# the harness: the full matrix, about half an hour
nix develop --command just test audio-quality

# list the rows, run one, or enforce the budgets
nix develop --command just test audio-quality --list
nix develop --command just test audio-quality --codecs opus --profiles bursty --rings plain
nix develop --command just test audio-quality --enforce

# real Safari, local only, serialised, never in CI
nix develop --command just test audio-quality --runtime safari

# compare two run directories
bun test/audio-quality/clients/js/compare.ts <before-dir> <after-dir>

# cross-language interop, needed for the moq play change
nix develop --command just test smoke-full
```

A failing run keeps its directory, with each process's log, its generated relay config, and its
endpoints, and prints where it is.

## Attribution and licensing

**WebRTC.** `modules/audio_coding/neteq` in the Chromium tree is the specification for everything in
`js/watch/src/audio/playout/` and `rs/moq-audio/src/playout/`. It was read, cited by file name in each
module header, and reimplemented in `f64`. No source was copied. The constants and the algorithm
shapes are theirs; the fixed point is not carried over, because it exists to target DSPs.

**videocall-rs.** The `neteq` crate there is MIT OR Apache-2.0 and was read as a possible starting
point for the Rust side. Nothing was adapted from it. Its time stretch removes the longest low-energy
run rather than a pitch period, its expand emits quiet noise rather than concealment, and its buffer
level filter adds a jump detector NetEq does not have, so it is not the port it looks like. The
reasoning is in the module header of `6ce7d2bcf`.

**PR #3517.** The two cherry-picked commits keep their author. The arrival observation point, the
`spread` plumbing, the ring slack, the re-stall, `stall()`, the underrun counter, the worklet ramp,
and the stats and buffering-indicator wiring are all from there and are kept.

**The harness.** `sink.ts`, `compare.ts`, `src/probe.ts` and `analyze.ts` are adapted from this fork's
own earlier work on branch `debug/rt-audio`, against 130 raw ndjson traces published as release
`rt-audio-traces-2026-09-06`. Each module says so, and `test/audio-quality/README.md` has the
attribution section. What changed in upstreaming: the CDP driver became Playwright on the smoke
harness, the patched-in probes became public signals, which is what lets the same page measure a
published build, and the arrival impairment moved from a shell script driving the OS to `moq-shaper`
with a seed and its own counters.

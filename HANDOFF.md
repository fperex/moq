# Real-time audio playout: what was wrong, what this branch does about it

Branch: `fperex/moq` `debug-findings-solution`, rebased onto `upstream/dev` (`877a561d8`, was
`8f41d4d82`). This document sits at the branch tip: 88 commits, 163 files. The last change to the
player itself is `de641c6b5`; everything above it is delivery and the work in progress noted below.

This is a **draft pull request on a fork, opened so the work can be read, and not a submission**. No
pull request on `moq-dev/moq` is intended and nothing here asks to be merged as a unit. It exists so
that the investigation behind moq-dev/moq#2812 and #3477 is readable and measurable, and so the
slices worth taking can be taken one commit at a time, in any order. It is a proof of concept, and
if a slice should be reshaped before it is adopted, say which.

It is one document on purpose. It was three files under `debug-findings/`: the full report, a short
form written as an issue comment, and an operational handoff. They said the same things at three
lengths, and they are folded into this one file at the root of the branch so there is one thing to
read. Where they overlapped, the report's fuller wording is the one kept.

**How to read it.** "How to read the branch" below is the map: one commit per quest slice, each one
compiling and testable alone, with a suggested reading order of the eight commits that are the fix,
and the same commits grouped by the quest they come from. The tables are the evidence, and every
number in them is read out of a run's row JSON rather than off a printed line. "Findings for the
maintainer" is the part that is worth reading even if none of the code is adopted.

**What everything is graded against**, at the auto preset: a jitter target of 20 to 100 ms, a held
total under 150 ms on the LAN and under 200 ms through the public relay, audio and video within one
frame, and zero underruns after convergence. Firefox and Safari are graded like Chromium.

**Work in progress at this tip.** Findings past the seventeen below are being fixed as this is
written and will be appended here, each with the commit that fixes it: what a capture stop does to a
publisher's catalog, the fill and the spinner after an unmute, hiding and showing video, and the
console noise a watcher produces. Anyone reading an intermediate push should expect that list to
grow rather than read the seventeen as the end of it.

**Contents**

- [Summary](#summary)
- [How to read the branch](#how-to-read-the-branch)
- [Root causes](#root-causes)
- [What changed, per stage](#what-changed-per-stage)
- [Evidence](#evidence)
- [Findings for the maintainer](#findings-for-the-maintainer)
- [Public API and wire impact](#public-api-and-wire-impact)
- [Departures from the quests](#departures-from-the-quests)
- [Verification and limitations](#verification-and-limitations)
- [How to run](#how-to-run)
- [Open items and follow-ups](#open-items-and-follow-ups)
- [Attribution and licensing](#attribution-and-licensing)

## Summary

1. `<moq-watch>` at the "Real-time" / auto preset stutters (moq-dev/moq#2812, #3477).

2. Five separate defects produce it, and each one alone is enough to be heard.

3. The auto delay came from the round trip, which cannot see how unevenly a publisher flushes.

4. The audio ring skipped whenever it ran long and never re-stalled after running dry.

5. The age budget was also the container's skip threshold, so the estimator under it could only confirm the budget it was cut to.

6. This branch replaces the estimator with the algorithm NetEq uses, written down in `doc/concept/playout.md` and held by a checked-in corpus that both languages replay.

7. The ring then converges by time stretch rather than by skipping, and conceals an outage rather than playing silence.

8. `rs/moq-audio` gets the same engine, so `moq play` has a jitter buffer for the first time.

9. `test/audio-quality` measures all of it over a seeded impaired path, in Chromium, in real Safari, and against the recorded traces on a simulated clock, and grades it nightly.

10. On the public relay at auto, over 120 s: 36 underruns before the engine, 1 after.

11. A user then muted a real microphone and kept hearing the room. Concealment had no end: it faded
    into the measured background level and stayed there. It now ends in silence, as current WebRTC
    does, and a muted publisher says on the wire that its timeline paused instead of leaving the
    watcher to guess. See finding 10.

12. Firefox then underran where Chromium did not, on the same broadcast over the same relay at the
    same moment. That is not the path either: the Firefox content process stops executing for two
    to five hundred milliseconds at a time, and the estimator was reading the block as delay. The
    estimator now takes an explicit "the receiver was blocked" input. See finding 12.

13. A viewer then left, and every later viewer of the same browser publisher got a tile, an accepted
    subscription and no catalog. The publisher's catalog track stayed cached with nobody writing to
    it. See finding 13.

14. A browser publish stamped its microphone and its camera on two different epochs, so sound
    led picture by a third of a second for every viewer, and by the whole of it for a second after
    every unmute. See finding 14.

15. And real Safari played one run in eight in silence. The click started the audio context; the
    next catalog frame, the one that carries the codec description, closed it and built a
    replacement that was born suspended with the gesture already spent. See finding 15.

## How to read the branch

One commit per quest slice, in the order they were written. Each one compiles, tests, and is
readable alone. The two oldest are the maintainer's own, cherry-picked from the closed PR #3517
with their author intact.

| # | Commit | Quest / stage | What it is |
| --- | --- | --- | --- |
| 1 | `8ec63fe74` | #3517 (kixelated) | Auto sized from measured arrivals, ring slack, re-stall, `stall()`, underrun counter |
| 2 | `647d15b82` | #3517 (kixelated) | Short quantum counts as an underrun, stale arrival minimum expires |
| 3 | `76387d714` | `audio-jitter-target/spec.md` | `doc/concept/playout.md`, the NetEq estimator, the 14-case corpus and its generator |
| 4 | `12e015af5` | `audio-jitter-target/watch.md` | Auto sized from the target, render quantum moved into the ring, advertised jitter the floor and 2 s the ceiling |
| 5 | `6087621b6` | review follow-up | Arrival clock read before the container is parsed; the arrival test made real |
| 6 | `42c87a855` | `transport-impairment-profile.md` | `rs/moq-shaper`, a seeded userspace UDP path impairment with counters |
| 7 | `50e70f5b8` | `watch-audio-time-stretch.md` (native half) | Accelerate, preemptive expand, expand, merge, background noise, in Rust |
| 8 | `f05ea7e1e` | review follow-up | `Container.Jitter` is the class, not a namespace |
| 9 | `ce0d6d0ef` | budget finding, part 1 | `Expired` on `StreamCode.DeliveryTimeout` |
| 10 | `2f7c575a9` | budget finding, part 2 | A censored group is counted, not a `spawn error` |
| 11 | `85d39db8e` | budget finding, part 3 (fork addition) | Audio subscribes and consumes at `maxAge + headroom` |
| 12 | `a7c1a8182` | finding | `demo/web` tiles start in auto instead of a hard-coded `100ms` |
| 13 | `c6a256aaa` | CodeRabbit | Buzz fixture period sized from the signal it built |
| 14 | `4ab24271e` | `m1/plan-av-clock.md` | The audio playhead drives `Sync.reference`; `sync.track()` replaces the flat inputs |
| 15 | `6951b7d26` | tune-in defect (browser) | A receiver's own reading stall stays out of the target; proportional fall |
| 16 | `242ae8aa8` | `audio-jitter-target/native.md` | The native estimator, same corpus, `f64` |
| 17 | `edeef0297` | `audio-jitter-target/native.md` | The native engine: frame buffer, decision loop, playhead |
| 18 | `943a48c00` | tune-in defect (native) | The same two rules in Rust |
| 19 | `9db068e08` | `audio-jitter-target/native.md` | `decode::Config::delay` turns it on; `moq play --delay` becomes a floor |
| 20 | `1823f309a` | native test | The native guards hold to the fourteenth corpus case |
| 21 | `2201b7b30` | `watch-audio-time-stretch.md` | The ring reader splits into `view`, `peek`, `commit` |
| 22 | `c2d32a2db` | `watch-audio-time-stretch.md` | The browser engine: the ring converges by stretch rather than by skipping |
| 23 | `6b568e223` | `qa-failure-artifacts.md` | A failing run keeps its directory |
| 24 | `51c9a0647` | `audio-quality-harness/browser.md` | `test/audio-quality`: page, probe, driver, sink, analyzer, grader, schema |
| 25 | `1526eff93` | harness | The page denies the WebSocket fallback so the shaper is in the path |
| 26 | `744f0c38b` | harness | Budgets recorded from the full matrix, not enforced |
| 27 | `b098b17e0` | harness | The probe can read a build it was not written against |
| 28 | `3b2dbcd31` | harness | The probe's generic helper is a function declaration, not an arrow |
| 29 | `b3498efdc` | harness | `skipped_groups` and the clock source become real numbers |
| 30 | `ef9f11e06` | CodeRabbit | A void row fails the run; the probe's remaining reads are guarded |
| 31 | `e50230451` | concealment (user decision) | The browser twin of expand and merge, behind `conceal`, default on |
| 32 | `eedcfa5d1` | re-land | MPEG-TS importer keeps fractional sample ticks |
| 33 | `03820021b` | re-land | Authored audio gaps render as silence before encoding |
| 34 | `060f7de48` | re-land | A file's audio format is learned from its first decoded sample |
| 35 | `127febcac` | re-land | The video encoder's admission queue is bounded |
| 36 | `dd891b956` | re-land | Native chunks bridge into the Libav polyfill when one codec is missing |
| 37 | `3c4f0f6e9` | `audio-quality-harness/browser.md` | A real Safari lane over safaridriver |
| 38 | `6184239e7` | `audio-quality-harness/browser.md` | A deterministic replay lane, graded on its own rows |
| 39 | `2b9d492f0` | `audio-quality-harness/browser.md` | The nightly `audio-quality` job |
| 40 | `860aeac3d` | harness | The device's own rate is sampled; the unearned Safari budgets go |
| 41 | `b336e5d86` | harness | An underrun episode ends at the last sample that underran |
| 42 | `e5d36eb1f` | concealment (user decision) | `conceal` as an element attribute, settable before connect |
| 43 | `fcce8af55` | flake | The `console.error` spy is isolated in the consumer test |
| 44 | `697a67635` | harness | The budgets enforced, measured on the playout engine |
| 45 | `1af4609eb` | review | The review pass over the branch |
| 46 | `928ec4abf` | delivery | The report and the issue comment |
| 47 | `f65ab9351` | shaper defect | Jitter varies the delay without reordering datagrams |
| 48 | `b418434f6` | harness | The budgets re-recorded and enforced on the fixed shaper |
| 49 | `3f0e3221d`, `20480cbf3` | delivery | The report, filled in with the enforced budgets |
| 50 | `c153b2a69` | `m1/plan-av-clock.md`, user report | A hole in the source reaches the decoder, and a ring nothing is draining is flushed |
| 51 | `2a79fed4a` | delivery | The report and the issue comment, with the A/V desync fix |
| 52 | `014f74897` | mic hold (user report) | Both rings hold one chunk above the playout target |
| 53 | `5b144e010` | mic hold (user report) | The same one-frame hold in the native engine |
| 54 | `c3c95f06e` | harness | The real-microphone traces replayed and graded |
| 55 | `fbbac54b6` | delivery | The report and the issue comment, with the one-frame hold finding |
| 56 | `7ba93d562` | mute (user report) | A long outage ends in silence, not comfort noise |
| 57 | `44599d39f` | mute (user report) | A muted audio track declares its endpoint, both ends |
| 58 | `5ea2ec0ab` | mute (user report) | The same silence in the native engine |
| 59 | `cd2a4b456` | delivery | The report and the issue comment, with the mute finding |
| 60 | `aeaaf8908` | cold start (user decision) | The catalog jitter seeds the playout target instead of flooring it |
| 61 | `0014daca9` | harness | The budgets re-recorded on the rebased tree |
| 62 | `c6efeefef` | delivery | The report and the issue comment, with the cold-start rule |
| 63 | `99b62150d` | cold start (user decision) | The first measurement replaces the seeded playout target, as NetEq does |
| 64 | `9e2dabe74` | harness (intermittent) | The re-anchored decoder is never handed a chunk it refuses |
| 65 | `ce2e13112` | harness | The budgets re-recorded after the seed and the decoder fixes |
| 66 | `ec6d9761a` | delivery | Cross-browser results: four engines, three sources |
| 67 | `85583de68` | delivery | The Safari catalog defect retracted |
| 68 | `3c9388e56` | delivery | The handoff for whoever continues the branch |
| 69 | `8cabb3507` | harness (rebase) | The harness relay admits anonymous sessions under upstream's lease model |
| 70 | `8700f1fcc` | unmute spike (user report) | A flushed ring reports no playhead until it is re-anchored |
| 71 | `3dcea2ab4` | delivery | remark's own formatting over the report |
| 72 | `b86b03c94` | Safari unlock (user report) | The audio unlock is armed on the first gesture, so one click plays |
| 73 | `a8cbc93bb` | CodeRabbit | Each shaper direction draws its own seed, and a reorder without a delay is refused |
| 74 | `97c7afb76` | CodeRabbit | A capture that ends while still enabled declares an audio endpoint |
| 75 | `b85e57431` | CodeRabbit | The grader, beacon, probe and Safari lane fail loudly where they were silent |
| 76 | `02f3f143a` | CodeRabbit | The stereo merge case uses a distinct signal per channel |
| 77 | `f5087814b` | CodeRabbit | The native replay module's doc comment says four traces, not two |
| 78 | `d5886766f` | finding 12 | The estimator is told when the receiver itself was blocked |
| 79 | `a8fe99aeb` | finding 12 | The recorded Firefox window replayed and graded |
| 80 | `5484970e1` | CI | The nightly job runs the replay lane ahead of the Chromium matrix |
| 81 | `0b2e4cad7` | delivery | The report, the issue comment and the handoff, refreshed for the rebased tip |
| 82 | `cb10a2a66` | finding 13 | A served catalog track is released when its last subscriber leaves |
| 83 | `eb4331877` | finding 14 | Captured audio is stamped on the context clock, so both tracks share one epoch |
| 84 | `de641c6b5` | finding 15 | The audio context is keyed on its rate alone, so a later catalog frame cannot spend the gesture that started it |
| 85 | `180975961` | delivery | The quiet re-measure, the audio-context fix, and the gates at the tip |
| 86 | `f2bd8ad45` | delivery | The tip filled into the short form, and the handoff pointer |
| 87 | this one | delivery | This document: the report, the short form and the handoff folded into one file at the repository root |

Row 49 carries two commits, so the numbered rows cover one hash more than there are rows. Every hash
`git log --oneline upstream/dev..HEAD` prints is in the table, in that order, and the last row is
this commit.

Suggested reading order for review: 3, 4, 9 to 11, 21, 22, 31, 78. Those eight are the fix. The
native half (7, 16 to 20) is the same algorithm again and can be read second or skipped entirely.
The harness (6, 23 to 30, 37 to 39, 44, 47, 48, 65, 69, 75, 79, 80) stands alone and can be adopted
without any of the player changes.

The same commits, grouped by the quest they come from:

| Quest | Commits |
| --- | --- |
| [`audio-jitter-target/spec.md`](https://github.com/moq-dev/moq/blob/dev/quest/m2/audio-jitter-target/spec.md) | `76387d714` (doc, estimator, 14-case corpus) |
| [`audio-jitter-target/watch.md`](https://github.com/moq-dev/moq/blob/dev/quest/m2/audio-jitter-target/watch.md) | `8ec63fe74`, `647d15b82` (kixelated), `12e015af5`, `6087621b6`, `f05ea7e1e` |
| the budget finding (root cause 3 above) | `ce0d6d0ef`, `2f7c575a9`, `85d39db8e` |
| [`m1/plan-av-clock.md`](https://github.com/moq-dev/moq/blob/dev/quest/m1/plan-av-clock.md) | `4ab24271e`, `c153b2a69` (a hole in the source reaches the decoder) |
| tune-in defect, found by the harness | `6951b7d26` (browser), `943a48c00` (native) |
| [`audio-jitter-target/native.md`](https://github.com/moq-dev/moq/blob/dev/quest/m2/audio-jitter-target/native.md) | `242ae8aa8`, `edeef0297`, `9db068e08`, `1823f309a` |
| [`watch-audio-time-stretch.md`](https://github.com/moq-dev/moq/blob/dev/quest/m2/watch-audio-time-stretch.md) | `50e70f5b8`, `2201b7b30`, `c2d32a2db` |
| concealment (a departure, see "Departures from the quests") | `e50230451`, `e5d36eb1f` (the element attribute) |
| [`transport-impairment-profile.md`](https://github.com/moq-dev/moq/blob/dev/quest/m2/transport-impairment-profile.md) | `42c87a855` (`rs/moq-shaper`) |
| [`audio-quality-harness/browser.md`](https://github.com/moq-dev/moq/blob/dev/quest/m2/audio-quality-harness/browser.md) | `51c9a0647`, `1526eff93`, `744f0c38b`, `b098b17e0`, `3b2dbcd31`, `b3498efdc`, `ef9f11e06`, `3c4f0f6e9`, `6184239e7` (replay lane), `2b9d492f0` (nightly), `860aeac3d`, `b336e5d86`, `697a67635`, `b418434f6` |
| [`qa-failure-artifacts.md`](https://github.com/moq-dev/moq/blob/dev/quest/m2/qa-failure-artifacts.md) | `6b568e223` |
| re-landed narrow fixes, each with a failing-then-passing test | `eedcfa5d1`, `03820021b`, `060f7de48`, `127febcac`, `dd891b956` |
| the shaper defect found while re-measuring | `f65ab9351` |
| the one-frame hold, and the mute (root causes 4 and 5 in the branch's own numbering) | `014f74897`, `5b144e010`, `c3c95f06e`, `7ba93d562`, `44599d39f`, `5ea2ec0ab` |
| the cold start, so a declaration is a prior the first measurement replaces | `aeaaf8908`, `0014daca9` (the budgets it moved), `99b62150d` (the first measurement replaces the seed) |
| the unmute transient and the Safari unlock | `8700f1fcc` (a flushed ring reports no playhead), `b86b03c94` (the unlock is armed on the first gesture), `de641c6b5` (the context outlives a catalog update) |
| the receiver stall (Firefox), found by watching two engines at once | `d5886766f` (the estimator takes a stalled input), `a8fe99aeb` (the recorded window replayed and graded) |
| the browser publisher's catalog and its clock | `cb10a2a66` (a served catalog track is released when its last subscriber leaves), `eb4331877` (captured audio is stamped on the context clock) |
| CodeRabbit fixes over the whole branch | `a8cbc93bb`, `97c7afb76`, `b85e57431`, `02f3f143a`, `f5087814b` |
| CI, and the rebase onto the lease model | `2b9d492f0`, `5484970e1` (the nightly job), `8cabb3507` (the harness relay under `moq-auth`) |
| review, flake and delivery | `fcce8af55`, `1af4609eb`, `928ec4abf`, `3f0e3221d`, `ec6d9761a`, `85583de68`, `3c9388e56`, `3dcea2ab4`, `0b2e4cad7`, `180975961`, `f2bd8ad45`, plus this one |

## Root causes

Five defects. The first three were confirmed against `upstream/dev` when it was at `8f41d4d82`; the
last two are this branch's own, found by a listener on builds of it.

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

### 4. The ring held the target minus one frame

Reported after the three above, from a browser publisher's own microphone: 20 ms Opus, one frame per
group, watched at auto on a local relay. The Latency panel read `jitter buffer 20ms (auto)`, `total
buffer 20ms`, and the audio stuttered through continuous speech, while the `bbb` sources with their
300 ms floors played clean on the same build.

The estimator was right. 20 ms is its lowest value, the upper edge of the first histogram bucket, and
that microphone path really does deliver inside 20 ms. The ring was what was wrong: it un-stalled at
`WRITE - READ >= LATENCY`, refilled to the same after an underrun, and the level filter's lower bound
was the target itself. But the ring holds *unplayed* audio, and the engine takes a whole chunk out of
it to produce each block. A ring holding exactly the target therefore holds nothing unplayed at the
moment the engine asks, so it runs dry on the first arrival a millisecond late, re-stalls, refills to
the same empty level, and stutters there for as long as the call lasts.

NetEq does not have this: its target delay counts *the packet being played* as well as the ones
waiting, because its buffer level is the `packet_buffer` span plus what the sync buffer still holds.
The maintainer's #3517 carried a "+ one frame" for exactly this reason; the objection recorded in
`quest/m2/audio-jitter-target/spec.md` was to *learning* that frame from timestamp gaps, not to the
term. The branch's own `doc/concept/playout.md` had already decided that the term belongs to the
ring's slack, but the slack had only ever been applied to the skip band, never to the level the ring
holds.

### 5. The advertised jitter was carried twice

The rendition's catalog `jitter` is the publisher's declared flush span. `Sync` used it twice: as a
floor under `auto` and as a term added to a fixed delay. The TS importer advertises 302 to 372 ms on
the `bbb` sources; the estimator on the same path reads 40 to 180. So `auto` never came below the
declaration for the length of a session however well the path delivered, and the demo's `100ms`
preset actually waited 402 ms.

It is one quantity, not two. A flush span is exactly what the estimator goes on to measure, published
by the party that already knows it before the first frame lands. That makes it the best prior a
receiver has and a poor floor: a floor asserts something about the path that the receiver has since
measured for itself. NetEq guesses 80 ms (`kStartDelayMs`) at the same point only because RTP carries
nothing like a declared flush span.

### What upstream had already done

\#3478 is fixed by #3508. #3479 is fixed by #3513 and #3516. #3477 was closed as a re-plan (#3576).
\#2812 is still open. PR #3517 was closed unmerged: its estimator learned a frame duration from the
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

The corpus is `rs/moq-audio/tests/playout-01.json`, 17 cases, generated by
`js/hang/src/container/jitter.vectors.ts` and freshness-checked in both languages. Every expected
target is an integer multiple of 20 ms, so an `f64` difference between V8 and rustc cannot break
parity. Both implementations replay it exactly, 17 of 17.

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

#### The mute that put video 2.8 s ahead

Reported against the frozen site build after the branch was finished: changing the volume and the
latency presets a few times left the Latency tab showing video about 2.8 s ahead of audio, the two
visibly out of sync, and the audio bar still sitting on its target.

Neither bar was lying. The audio playhead was three seconds behind the live edge, and since this
stage the playhead is the clock, video was held back there with it. What put it there is a WebCodecs
behaviour one layer up. An `AudioDecoder` timestamps its output by accumulating decoded frame
durations from the chunk that opened its run rather than by copying each chunk's own timestamp, so a
hole in the source is swallowed. Muting stops the download (`emitter.ts` clears `enabled`), so the
subscription that resumes starts at the live edge and the media covering the mute was never sent.
Wrapping `AudioDecoder` on the page shows the swallow exactly: the chunks in step from 54357386 to
54360428 us across the mute, and the samples out carry on at 54357409, 54357433, 54357456, 23.2 ms
apart. Every sample after that lands in the ring three seconds in the past, the ring plays a stream
that is contiguous and so never skips, and the playhead stays behind the live edge for good. It is
not specific to a mute: a group the age budget skips is the same hole one frame wide, which is why
the reported sequence ends 843 ms behind live rather than back where it started.

The decode loop on `upstream/dev` has no hole handling either, and `terminal.ts` there is byte
identical, so the collapse itself predates this branch. What this stage changed is who follows it:
before, video paced against a wall clock and only the audio was late.

Two changes, both in `c153b2a69`. `Terminal.continues()` measures each frame against the last one at the
decoder's own frame duration and reports a hole; `Audio.Decoder.#reanchor` drains the decoder so the
frames in flight keep the run that is ending, then restarts it so the next chunk's own timestamp
opens the new one. `Audio.Decoder.#runFlush` drops what the ring still holds when the download
stops, because nothing drains it while the graph is disconnected and replaying it on the way back in
steps the playhead back to where the mute started. A flushed ring stops reporting a clock, so `Sync`
runs on the wall clock at the last audio-derived value until the ring anchors again.

Driving the reported sequence on this tree's `demo/web` against the local relay in headless
Chromium, sampling the painted video timestamp against `sync.now()` every 250 ms over 58 s:

| | before | after |
| --- | ---: | ---: |
| worst video-minus-audio skew | 3418 ms | 50 ms |
| samples worse than 200 ms, of 232 | 19 | 0 |
| video buffer at the end, at auto | 843 ms | 236 ms |
| underruns over the run | 6 | 0 |

The shared-memory ring and `conceal=false` give the same answer (64 ms and 46 ms worst skew, zero
underruns). `sync.replay.test.ts` carries the sequence as a regression test: a real ring, a real
estimator, a real `Sync`, a model decoder that collapses a hole the way Chromium does, and one
`sync.wait()` per video frame. It asserts the painted frame stays within a video frame plus a poll
of the playhead and that audio ends at the live edge, then reruns with each of the two changes
switched off as the control, where the playhead ends 5.9 s behind live and the picture 5.8 s ahead
of it. `terminal.test.ts` covers the hole test and its re-anchor; `sync.test.ts` covers a clock that
is lost and re-nominated at a different playhead.

Re-anchoring mid-group also has to hand the restarted decoder a chunk it will accept, which this
stage did not, and which killed the decode loop outright about one harness run in three. See finding
11\.

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
the signal was, muted block by block under NetEq's muting slope until it is digital silence, and
giving up entirely after two seconds. When the media comes back it is aligned against the
concealment and crossfaded in. That is NetEq's expand and merge. (An earlier commit on this branch
faded the tail into the measured room tone instead of to silence; finding 10 is why it no longer
does.) A hole that reaches the playhead with nothing behind it is no longer queued
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
browser does, and the corpus passes 17 of 17.

### The chunk above the target

One rule, in the same four places in both engines: the level a ring holds is `target + chunk`, where
`chunk` is the size of the most recent insert, measured on the way in and republished on every
arrival rather than learned from timestamp arithmetic.

- Both rings un-stall at `WRITE - READ >= target + chunk` and a refill after an underrun reaches the
  same level, bounded by what the ring can physically hold so an oversized decode cannot name a level
  no refill could reach.
- The buffer level filter's band becomes `low = target + chunk`, `high = low + 20 ms`. `high` does
  not move: it was already `target + chunk + 20 ms`. What moves is the floor, so a ring sitting
  exactly where it is meant to sit is no longer read as one that needs expanding.
- The skip band stays where it was, so the band above the level the ring holds is exactly the stretch
  bound: everything inside it is something the time stretch closes without dropping a sample.
- `rs/moq-audio` gets the same rule in `decision.rs` (`Decision::hold`), and the engine's two flush
  paths are collapsed onto one so a target that has just fallen does not convict from the pull side
  what it tolerates on the insert side.

The audio age budget's headroom is unchanged and still exactly covers it: `Jitter.BUCKET + frame +
STRETCH_BOUND` is the bucket the estimator rounded up by, the chunk held on top of the target, and
the stretch band.

`Sync.out.delay` stays the estimator's answer, because it is also the wire subscription's age budget
and what video paces against. The player's Latency panel now separates the two: "Jitter buffer" is
that value and "Total buffer" is `delay + chunk`, which is what a listener actually waits. The chunk
comes from the ring's own `audio.out.debug` snapshot, so no new public signal was added for it.

### The cold start

The declaration moves from `Sync` into the estimator, in both languages. `Container.Jitter` takes a
`start`, rounded up to a whole bucket, never below NetEq's 80 ms guess and never above the
histogram's 2 s range; `Container.Consumer` takes it as a `jitter` prop from the rendition config,
and `decode::Consumer` reads `catalog.jitter` for `Jitter::seeded`.

**The first measurement replaces that start outright**, however far below it the measurement lands.
A seed is a prior, not an observation: the fall bound exists to keep one measurement from yanking
the buffer out from under the last one, and a declaration is not a measurement for it to protect.
NetEq is the same shape, `target_level_ms_ = underrun_optimizer_.GetOptimalDelayMs().value_or(kStartDelayMs)`
in `delay_manager.cc`, where the start delay is only what stands in until the optimizer has a value
and there is no fall bound at all. Running the seed through the bound instead, which is what the
first version did, left a 310 ms declaration sitting above a 20 ms path for tens of seconds on every
tune-in, and an unseeded 80 ms start above it for three. From the first observation half a second in
the target is a measurement, and rise and fall apply between measurements from there.

`Sync` is then one term: `auto` is the measurement and a fixed delay is the number the viewer asked
for. `SyncTrack.advertised` has no reader left and goes.

`playout-01.json` gains a `seeded` case: a 310 ms declaration starts the target at 320 ms
and the first resampled observation takes it to the 20 ms the steady trace settles on. A case
carrying `start_ms` is replayed from it in both languages. The 80 ms default is a seed on the same
rule, so nine of the fourteen existing cases lose their first seconds of walk-down too; every one of
them reaches the same settled target as before, and the arrival traces are untouched.

The native `--delay` floor is untouched. That one is a caller asserting something the arrivals do
not say, which is a different thing from a publisher describing its own encoder.

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

### The microphone traces

Two new fixtures, trimmed the same way as the other three: `mic-local` is a browser publisher's
microphone over a local relay, `mic-remote` the same publisher through the public relay at a 45 ms
round trip. Both are 20 ms Opus, one frame per group, and both settle the estimator on its lowest
value, 20 ms, in both languages.

Replayed at that settled target, which is the state a call reaches within a minute and stays in
(`fixed: 20`, counted after 1 s, identical on both rings):

| trace | concealment | underruns | short quanta | level trough |
| --- | --- | ---: | ---: | ---: |
| `mic-local` | on | 1 -> 1 | 0 -> 0 | 0.0 -> 2.3 ms |
| `mic-local` | off | 2 -> 1 | 11 -> 7 | 0.0 -> 2.3 ms |
| `mic-remote` | on | 0 -> 0 | 0 -> 0 | 14.7 -> 19.7 ms |
| `mic-remote` | off | 1 -> 0 | 1 -> 0 | 0.0 -> 19.7 ms |

The trough is the number the finding is about: before, the ordinary cadence took the ring to empty;
after, it rests a chunk higher and the floor is the target. `mic-local` keeps one underrun either
way, and it is not the rule: the trace carries one arrival 31 ms late, past the 95th percentile the
estimator reports by design, and past what 40 ms covers. Concealment carries it, which is why no
quantum reaches the device short.

At the estimator's own target with its cold-start cushion still in the ring (the `auto` lane, counted
after 4 s) both traces are clean before and after: zero underruns, zero short quanta, zero skipped
samples. Twelve seconds is not long enough for a 20 ms ring to be pinned by an underrun, which is why
the fixed lens is the one that shows it.

In the harness replay lane the same change moves the recordings that already had underruns:
`4k-webm` on the shared ring goes from 14.1 to 7.0 underrun episodes per minute and from 2.9% stalled
quanta to none. `lan-bbb` on the postMessage ring picks up one underrun in a ten second window where
it had none; that trace's arrivals run slower than its own media at the tail, so its buffer sits
within a few milliseconds of empty either way. Every replay budget was re-recorded from the measured
run and the lane is enforced.

### The real microphone, headed

Real Chromium with a window on the screen, the machine's own microphone through
`--use-fake-ui-for-media-stream` (the fake *device* is not used: its synthetic signal breaks the
encoder), one `publish.html` publishing camera and microphone and one `watch.html` watching it, both
against the local relay, sampled every 250 ms for 60 s and counted over the last 50.

| build | ring | target | held | level min / p50 / max | underruns | A/V skew p50 |
| --- | --- | ---: | ---: | --- | ---: | ---: |
| before | shared | 40 ms | 60 ms | 22.2 / 69.1 / 114.7 ms | 0 | 1.8 ms |
| after | shared | 20 ms | 40 ms | 35.7 / 55.7 / 67.7 ms | 0 | -0.2 ms |
| before | postMessage | 40 ms | 60 ms | 53.7 / 77.0 / 97.0 ms | 0 | -14.6 ms |
| after | postMessage | 40 ms | 60 ms | 34.5 / 47.8 / 61.2 ms | 0 | -15.3 ms |

Stated plainly: this path is clean enough that neither build stuttered in a minute. What the runs do
show is where the ring rests. Before, the shared ring ran down to 22 ms of unplayed audio against a
40 ms target, which is the state one late arrival turns into silence. After, its floor is 36 ms
against a 20 ms target, and the whole band is narrower: the engine is holding the level it was asked
to hold instead of drifting between the target and empty.

### The three pages, live, after the cold start

One 90 s headless Chromium run per cell, counted from 20 s in, unmuted at `delay="auto"`, re-measured
on a quiet machine at the tip. `demo/web` served plain is the production path and gets the
postMessage ring; the same build with COOP/COEP gets the shared one; the third is the copied moq.dev
site aliased at this checkout's `js/`. Every row's `AudioContext` opened at 44100 Hz, the Bluetooth
output device's own rate, so the chunk the ring holds on top of the target is 23.2 ms of AAC.

| Page | Source | Ring | Target | Held | Level p50 / min | Underruns | Skips | Concealed | Accel | Expand | RTT | Skew p50 / p95 |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| demo, plain | `bbb-smooth.hang`, local | postMessage | 60 ms | 83.2 ms | 82.7 / 58.1 ms | 0 | 0 | 0 | 2 | 1 | 1 ms | -42.1 / 50.4 ms |
| demo, plain | `bbb.hang`, local | postMessage | 180 ms | 203.2 ms | 208.4 / 111.1 ms | 0 | 0 | 0 | 4 | 0 | 1 ms | -17.4 / 48 ms |
| demo, plain | `bbb.hang`, `cdn.moq.pro/demo` | postMessage | 200 ms | 223.2 ms | 216.9 / 70 ms | 0 | 0 | 0 | 32 | 34 | 39 ms | -18.7 / 33.6 ms |
| demo, isolated | `bbb-smooth.hang`, local | shared | 60 ms | 83.2 ms | 81.3 / 51.9 ms | 0 | 0 | 882 | 18 | 1 | 1 ms | -11.6 / 18.8 ms |
| demo, isolated | `bbb.hang`, local | shared | 180 ms | 203.2 ms | 200.4 / 86.2 ms | 0 | 0 | 0 | 1 | 1 | 1 ms | -0.8 / 7.4 ms |
| demo, isolated | `bbb.hang`, `cdn.moq.pro/demo` | shared | 220 ms | 243.2 ms | 242.1 / 104.3 ms | 0 | 0 | 0 | 11 | 16 | 44 ms | -20.2 / 40.6 ms |
| site | `demo/bbb-smooth.hang`, local | postMessage | 80 ms | 103.2 ms | 101.3 / 6.9 ms | 2 | 0 | 13230 | 22 | 1 | 1 ms | -14.4 / 40.8 ms |
| site, rerun | `demo/bbb-smooth.hang`, local | postMessage | 80 ms | 103.2 ms | 103 / 34.4 ms | 0 | 0 | 0 | 5 | 1 | 1 ms | -14.7 / 46.7 ms |
| site | `demo/bbb.hang`, local | postMessage | 180 ms | 203.2 ms | 200.2 / 102.7 ms | 0 | 0 | 0 | 3 | 0 | 1 ms | -32.6 / 42.4 ms |
| site | `bbb.hang`, cdn.moq.pro | postMessage | 240 ms | 263.2 ms | 238.5 / 110.7 ms | 0 | 0 | 0 | 28 | 31 | 46 ms | -19.2 / 47.1 ms |

The two cdn rows from the demo pages are reached at `cdn.moq.pro/demo` rather than at the host alone,
because the public relay now closes a session opened at its root: the page opened one, subscribed to
the announce prefix `""`, was dropped and reconnect-looped, and no tile ever appeared. Both rows were
attempted twice against `https://cdn.moq.pro` and failed to start both times, so the path-qualified
substitutes are what the table carries. The site row needs no substitute because the site page
connects to `<relay>/<project>` and so never opens a root session at all.

The smooth publisher settles at 60 ms on both demo pages against the 302 ms its catalog advertises,
which is the whole point of the cold-start change: the declaration is where the estimate starts and
the measurement takes it from there. The bursty one settles at 180 ms, which is its real 140 ms flush
span plus a bucket. The public relay settles at 200 to 240 ms with a 39 to 46 ms round trip. Held is
the target plus the 23.2 ms chunk in every row, so the three cdn rows sit 23.2 ms above the 200 ms
relay rule by the chunk and by nothing else, and the two bursty LAN rows sit above the 150 ms LAN
rule because the source is the bursty publisher rather than because the estimator missed.

Two rows are worth stating rather than smoothing over. The site page on the smooth local source
underran twice, at 26.3 s and 48.8 s, with the ring draining to 6.9 ms and 300 ms of concealment
behind it; the immediate rerun was clean, ring minimum 34.4 ms, and it is the only local page that
has produced an underrun at all. And the isolated smooth row conceals 882 samples, 20 ms, with no
underrun behind them.

Every row negotiated WebTransport, and only the isolated page reports `crossOriginIsolated`, so each
one ran the ring it was meant to. `sync.out.delay` is the estimator's answer alone now, so what a
listener waits is that plus the chunk the ring holds.

### Conferencing targets

The thresholds a WebRTC conference is held to, applied to the microphone runs: one browser publisher
on the pinned USB device, one watcher, the local relay, 60 s counted from 20 s in. "Held" is the
estimator's target plus the chunk the ring keeps on top of it, which is what the listener waits. The
lead column is explained below.

| case | ring | jitter target (20-100 ms) | held (LAN < 150 ms) | underruns after convergence | lead |
| --- | --- | ---: | ---: | ---: | ---: |
| Chromium, steady | postMessage | 40 ms | 60 ms | 0 | +1.1 ms |
| Chromium, steady | shared | 40 ms | 60 ms | 0 | +44.3 ms |
| Firefox, steady | postMessage | 40 ms | 60 ms | 0 | +5.6 ms |
| WebKit, steady | postMessage | 40 ms | 60 ms | 0 | +4.1 ms |
| Safari 26, steady | postMessage | 40 ms | 60 ms | 0 | -2.9 ms |
| Safari 26, mute and preset sequence | postMessage | 40 ms | 60 ms | 0 | +2.1 ms |
| WebKit, mute and preset sequence | postMessage | 40 ms | 60 ms | 0 | +5.7 ms |
| Chromium, mute and preset sequence | shared | 40 ms | 60 ms | 0 | +39.4 ms |
| `mic-local` fixture, both rings | | 20 ms | 40 ms | 0 | not measured: arrival-only trace |
| `mic-remote` fixture, both rings | | 20 ms | 40 ms | 0 | not measured: arrival-only trace |

Every case is inside every threshold. The LAN total is 60 ms against a 150 ms ceiling on every engine
and both rings, so the question of why it might sit above does not arise.

**What the skew metric can and cannot resolve.** A/V skew here is the painted video timestamp less
the audio playhead the player reports, sampled on a 250 ms grid. It has a floor of one frame plus one
display refresh, because the painted frame is the newest one due and it was painted at the last
vsync: 58 ms at 24 fps and 50 ms at 30 fps. It has a ceiling of one playhead reporting interval,
because the reported playhead is not extrapolated while the one video is paced against is: 14.5 ms of
worklet state messages at 44.1 kHz, 13.3 ms at 48 kHz, and one 50 ms poll on the shared ring. Every
settled sample on every row of this pass is inside that envelope to within 3 ms, and no postMessage
row ever paints ahead of the playhead by more than one state message, the largest positive sample
anywhere being +14.4 ms. Audio and video are within one frame on every row.

So the pair to grade is signed, not absolute. The **lead** column above is the signed p95: -13.6 to
+5.7 ms on every row but the two shared-ring microphone rows, which read +39.4 and +44.3 ms and are
the 50 ms poll's frozen phase rather than a lead, since both `skew` and `videoLead` moved by the same
40 ms while the ring's measured depth did not move at all. The **lag**, the signed p05, is inside the
floor everywhere: -3.6 to -50.4 ms at 24 fps and -23.1 to -37.2 ms at 30 fps.

The `Skew p95` column the earlier tables printed is the p95 of `|skew|` over that same distribution,
which is **41 to 49 ms by construction** (0.95 of one frame plus one refresh). Measured values of 30
to 50 ms are therefore at or below the metric's own worst case, and grading them against one frame
grades the sampler rather than the player. The pre-fix "1 to 19 ms" column in the older browser table
was the *signed* p95 under the same name, so the two columns are not comparable and the distribution
did not move between them; the statistic that did move is `videoLead`, from 390 ms before finding 14
to 64 to 91 ms after it.

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

Two things inflate the targets in that column, and neither is the estimator. The first is the
tune-in defect: those runs are 40 s long, the main-thread block happens at tune-in, and the fall
bound at the time held the target up for the rest of the run. They are the measurement that led to
the two rules above. The second was not known until the budgets were being enforced: the shaper's
own jitter was reordering datagrams (finding 8), so on every jittered profile QUIC was
retransmitting and the target was tracking the video stream's congestion response. The numbers below
are re-measured on the fixed shaper and on 60 s rows.

### The enforced budgets

`budgets.json` was last re-recorded in `ce2e13112`, after the cold-start change and the decoder
anchor, from two 60 second runs of the whole matrix: the worst of the two times 1.5, a hard 0 on the
counters the engine has to keep at zero wherever both runs measured zero, a share capped at 1 and a
convergence time capped at the row's own run. `a8fe99aeb` then added the two `mic-firefox` replay
rows.

A row is enforced when its two runs agreed within that same 1.5 on every graded metric, which is a
strict test: a metric one run measured as zero and the other did not is a disagreement, because the
ratio is unbounded. **Three Chromium rows clear it**, all three of them `fixed-250`, which is the
profile that adds a constant delay and nothing else. The other twenty-one keep the `recorded`
marker, which prints a breach and calls it out without failing the run, until the nightly runner
records its own. An earlier version of this report said ten of twenty-four rows were enforced with
120 checks; that was the previous recording, and the re-record on a tree whose targets settle within
a second rather than walking a declaration down for 40 s moved most of the rows out of agreement
with themselves.

| Row | Enforced | underrun ep/min | skipped ms/min | silence | target p95 | converge s |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| opus, near-zero, isolated | | 1.7 | 989.1 | 0.183 | 240 | 84 |
| opus, near-zero, plain | | 0 | 0 | 0.389 | 240 | 46.5 |
| opus, mild, isolated | | 0 | 0 | 0.477 | 480 | 60.3 |
| opus, mild, plain | | 0 | 662.8 | 0.177 | 2160 | 73.5 |
| opus, bursty, isolated | | 0 | 1959.3 | 0.15 | 1020 | 87.8 |
| opus, bursty, plain | | 0 | 3295 | 0.564 | 2520 | 81.3 |
| opus, step, isolated | | 0 | 419.4 | 0.088 | 690 | 73.8 |
| opus, step, plain | | 0 | 4377.9 | 0.436 | 2880 | 88.2 |
| opus, high-rtt, isolated | | 1.7 | 70.5 | 0.007 | 480 | 85.2 |
| opus, high-rtt, plain | | 0 | 947.1 | 0.102 | 510 | 78.8 |
| opus, fixed-250, isolated | yes | 0 | 0 | 0.41 | 375 | 0 |
| opus, fixed-250, plain | | 0 | 0 | 0.422 | 375 | 0 |
| aac, near-zero, isolated | | 0 | 0 | 0.21 | 420 | 71.6 |
| aac, near-zero, plain | | 0 | 134.4 | 0.075 | 270 | 3 |
| aac, mild, isolated | | 0 | 351.5 | 0.402 | 990 | 60.8 |
| aac, mild, plain | | 0 | 2238 | 0.552 | 1710 | 87.8 |
| aac, bursty, isolated | | 0 | 2762.7 | 0.464 | 2640 | 87.8 |
| aac, bursty, plain | | 1.7 | 5172.9 | 0.075 | 1770 | 81 |
| aac, step, isolated | | 1.7 | 140.2 | 0.061 | 540 | 54.8 |
| aac, step, plain | | 1.7 | 818.2 | 0.177 | 480 | 60.4 |
| aac, high-rtt, isolated | | 0 | 85.9 | 0.401 | 330 | 11.6 |
| aac, high-rtt, plain | | 0 | 555.6 | 0.45 | 570 | 57.3 |
| aac, fixed-250, isolated | yes | 0 | 0 | 0.171 | 375 | 0 |
| aac, fixed-250, plain | yes | 0 | 0 | 0.191 | 375 | 0 |

The matrix run at the branch tip passed all 36 enforced checks across the 24 rows and breached 17
recorded ceilings. Those breaches are the reason the twenty-one are not enforced yet, rather than
pinned at a number that would fail on the weather.

| Row | Metric | Measured | Ceiling |
| --- | --- | ---: | ---: |
| aac, bursty, isolated | underrun episodes/min | 1.1 | 0 |
| aac, bursty, isolated | underrun ms/min | 272.1 | 0 |
| aac, bursty, isolated | skipped ms/min | 3609.7 | 2762.7 |
| aac, bursty, plain | skipped groups/min | 21.8 | 9.8 |
| aac, high-rtt, isolated | target p95 | 340 | 330 |
| aac, high-rtt, isolated | converge s | 42.7 | 11.6 |
| aac, high-rtt, plain | skipped ms/min | 2895.3 | 555.6 |
| aac, near-zero, plain | converge s | 3.5 | 3 |
| opus, bursty, isolated | underrun episodes/min | 1.1 | 0 |
| opus, bursty, isolated | underrun ms/min | 272.5 | 0 |
| opus, bursty, plain | underrun episodes/min | 1.1 | 0 |
| opus, bursty, plain | underrun ms/min | 273.6 | 0 |
| opus, mild, isolated | stalled quanta share | 0.005 | 0 |
| opus, mild, isolated | skip-aheads/min | 1.1 | 0 |
| opus, mild, isolated | skipped ms/min | 44 | 0 |
| opus, step, isolated | underrun episodes/min | 1.1 | 0 |
| opus, step, isolated | underrun ms/min | 271 | 0 |

Two observations about that list. `aac-high-rtt-isolated` converging in 42.7 s against an 11.6 s
ceiling is well outside the run-to-run spread the rest of the table shows, and it is open: nothing
here explains it. The rest is one shape repeated. Ten of the seventeen are a hard zero breached by a
single episode at 1.1 a minute and the 272 ms of concealment that episode cost, and a hard zero is
what the recording rule produces when both recorded runs happened to measure zero on a counter that
is not reliably zero. That is a recording artefact rather than a regression, and it is what the
`recorded` marker exists to absorb.

One row voided on the same run: `opus-near-zero-isolated`, on the clock guard, with
`AudioContext.currentTime` drifting 4.92 percent from wall clock over 10 s. A void row is reported
rather than enforced on a recorded budget, and a drifting context is exactly the state that would
otherwise produce a full set of plausible counters.

The replay lane is enforced in full, because it is deterministic: 148 checks across twelve rows,
every ceiling exactly what was measured, no void row. `lan-bbb` and `relay-bbb-7frame` hold zero
skips and zero discarded samples on both rings at an 80 ms and a 240 ms target. `4k-webm` keeps 7
underrun episodes a minute and 1267.2 skipped ms, which are the holes in the recording. `mic-local`
and `mic-remote` are clean at 40 ms and 20 ms. `mic-firefox` is the receiver-stall recording from
finding 12, at a 300 ms target.

**Residuals.** Seventeen rows carry a measured ceiling on a counter the engine is supposed to keep
at zero. Each is work that is left, not a bar that was cleared.

| Row | skip-aheads/min | underrun episodes/min |
| --- | ---: | ---: |
| opus, near-zero, isolated | 13.0 | 1.7 |
| opus, mild, plain | 8.2 | |
| opus, bursty, isolated | 13.0 | |
| opus, bursty, plain | 41.0 | |
| opus, step, isolated | 4.9 | |
| opus, step, plain | 63.8 | |
| opus, high-rtt, isolated | 1.7 | 1.7 |
| opus, high-rtt, plain | 4.9 | |
| aac, near-zero, plain | 3.3 | |
| aac, mild, isolated | 4.9 | |
| aac, mild, plain | 24.6 | |
| aac, bursty, isolated | 34.3 | |
| aac, bursty, plain | 18.0 | 1.7 |
| aac, step, isolated | 3.3 | 1.7 |
| aac, step, plain | 13.0 | 1.7 |
| aac, high-rtt, isolated | 1.7 | |
| aac, high-rtt, plain | 11.4 | |

Seven of the twenty-two entries are a ceiling of 1.7, which is one event in a minute measured once
and not the other time. The real remainder is the `bursty` and `step` skip-ahead ceilings,
`opus-step-plain`'s 63.8 worst of all: a 160 ms flush arriving as one burst still outruns what 15 ms
of stretch per 100 ms of output can absorb, so the band still fires. Bringing those to zero is the
next piece of work on the engine, not something this branch claims.

### Before and after, on the fixed shaper

`upstream/dev` at `246a4733f` (the base the before-run was taken on) against this branch, same
desktop, one row at a time. **The two sides
are not the same length**: the baseline was recorded in Stage 8a at 40 s a row and this branch's
rows are 60 s. The per-minute counters are comparable; `target p95` and `silence` are not strictly,
because the target has 50% more run to settle in and the silence share is taken over a longer
window. The gate is `budgets.json`, which is two 60 s runs of this tree against each other.

| Row | underrun ep/min | skipped ms/min | silence | target p95 |
| --- | ---: | ---: | ---: | ---: |
| opus, near-zero, isolated | 0 -> 1.1 | 621.3 -> 587.6 | 0.093 -> 0.118 | 63 -> 100 |
| opus, near-zero, plain | 0 -> 0 | 0 -> 0 | 0.149 -> 0.245 | 63 -> 80 |
| opus, mild, isolated | 0 -> 0 | 0 -> 44.7 | 0.143 -> 0.345 | 63 -> 280 |
| opus, mild, plain | 8.6 -> 0 | 4911.5 -> 0 | 0.471 -> 0.1 | 63 -> 160 |
| opus, bursty, isolated | 8.6 -> 2.2 | 6158.2 -> 486.4 | 0.293 -> 0.1 | 67 -> 340 |
| opus, bursty, plain | 3.4 -> 1.1 | 6921.2 -> 1612.1 | 0.436 -> 0.382 | 185.8 -> 1720 |
| opus, step, isolated | 3.4 -> 0 | 5503.6 -> 0 | 0.107 -> 0.05 | 67 -> 300 |
| opus, step, plain | 0 -> 0 | 1111.7 -> 1481.1 | 0.286 -> 0.258 | 67 -> 1500 |
| opus, high-rtt, isolated | 0 -> 0 | 2013.8 -> 46 | 0.443 -> 0 | 142 -> 280 |
| opus, high-rtt, plain | 0 -> 1.1 | 11491.3 -> 44.3 | 0.307 -> 0.059 | 155.8 -> 180 |
| opus, fixed-250, isolated | 0 -> 0 | 0 -> 0 | 0.333 -> 0.259 | 297 -> 294 |
| opus, fixed-250, plain | 0 -> 0 | 0 -> 0 | 0 -> 0.281 | 297 -> 294 |
| aac, near-zero, isolated | 0 -> 0 | 0 -> 0 | 0 -> 0.136 | 395 -> 372 |
| aac, near-zero, plain | 0 -> 0 | 0 -> 0 | 0.064 -> 0.045 | 395 -> 372 |
| aac, mild, isolated | 0 -> 0 | 253 -> 0 | 0.489 -> 0.241 | 395 -> 372 |
| aac, mild, plain | 0 -> 0 | 715.9 -> 0 | 0.657 -> 0.314 | 395 -> 372 |
| aac, bursty, isolated | 0 -> 0 | 74.7 -> 3530.7 | 0.271 -> 0.309 | 395 -> 1000 |
| aac, bursty, plain | 0 -> 0 | 5827.9 -> 518.8 | 0.329 -> 0.005 | 395 -> 640 |
| aac, step, isolated | 0 -> 0 | 0 -> 0 | 0.121 -> 0.032 | 395 -> 372 |
| aac, step, plain | 0 -> 1.1 | 0 -> 0 | 0.007 -> 0.123 | 395 -> 372 |
| aac, high-rtt, isolated | 0 -> 0 | 0 -> 0 | 0.716 -> 0.267 | 507.5 -> 372 |
| aac, high-rtt, plain | 0 -> 0 | 0 -> 0 | 0.567 -> 0.294 | 475 -> 460 |
| aac, fixed-250, isolated | 0 -> 0 | 0 -> 0 | 0.213 -> 0.118 | 625 -> 622 |
| aac, fixed-250, plain | 0 -> 0 | 0 -> 0 | 0 -> 0.141 | 625 -> 622 |

The shape is the one the branch is for. Where the baseline was discarding audio to hold a
round-trip-sized buffer it now holds a measured one and discards nothing: `opus-high-rtt-plain`
drops from 11.5 s of skipped audio a minute to 44 ms, `opus-mild-plain` from 4.9 s and 8.6 underrun
episodes to zero of both, `opus-step-isolated` from 5.5 s and 3.4 to zero, `aac-bursty-plain` from
5.8 s to 519 ms with the silence share going from 0.329 to 0.005. The targets rise to pay for it,
which is the trade: a buffer that can absorb a 160 ms flush cannot also be 63 ms deep.

Two rows go the other way and are stated rather than explained away. `aac-bursty-isolated` skips
more than the baseline did (74.7 ms -> 3530.7 ms a minute) while its target climbs to 1000 ms: the
burst profile against the TS publisher's own multi-frame PES packing is the one arrival shape where
the estimator and the skip band still argue, and it is the same cell that would not agree with
itself across two runs. `opus-step-plain` skips 1481 ms against 1112 ms at a 1500 ms target. Both
are `recorded` rows and both are in the residual list above.

### Browser coverage

Chromium is not the only engine a viewer brings, and Firefox and Safari matter more than their share
here because the WebSocket fallback has an arrival shape of its own. So the same build was played in
four engines against one browser publisher on the real microphone, 60 s a row, sampled every 250 ms.
The reference is a WebRTC conference: a 20 to 100 ms jitter target, under 150 ms held on the LAN,
audio and video within a frame, and no underruns once converged.

Engines: Chromium 153.0.8010.12, Firefox 155.0, Playwright WebKit 26.6, and real Safari 26 driven
through `safaridriver`. Held is the settled target plus the chunk the ring holds, which is what a
listener actually waits. Skew is the painted video timestamp minus the audio playhead, so a negative
number is video behind audio; read it against the resolution stated under "Conferencing targets"
above. `videoLead` is the newest received frame less the playhead, which is the statistic finding 14
moved.

These are the rows re-measured on the fixed publisher. The microphone is the shape a conference has,
and it is the shape both publisher findings live in, so it is what was re-run. The file-source rows
per engine are from the earlier build and are carried below exactly as they were measured.

| Engine | Page | Ring | Transport | Target | Held | Level p50 / p95 / min | Underruns | Skips | Skew p50 / p95 | videoLead p50 | ctxRate |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Chromium | plain | postMessage | webtransport | 40 ms | 60 ms | 60.1 / 80.1 / 30.1 ms | 0 | 0 | -19.2 / 33.9 ms | 75.5 ms | 48000 Hz |
| Chromium | isolated | shared | webtransport | 40 ms | 60 ms | 60.2 / 80.2 / 40.2 ms | 0 | 0 | +23.9 / 44.4 ms | 114.3 ms | 48000 Hz |
| Firefox | plain | postMessage | webtransport | 40 ms | 60 ms | 60.1 / 80.1 / 40.1 ms | 0 | 0 | -15.2 / 36.2 ms | 81.4 ms | 48000 Hz |
| WebKit | plain | postMessage | websocket | 40 ms | 60 ms | 60.1 / 80.1 / 20.1 ms | 0 | 0 | -11.2 / 30.1 ms | 64.4 ms | 48000 Hz |
| Safari 26 | plain | none | none | | | | | | | | |
| Safari 26, retry | plain | postMessage | websocket | 40 ms | 60 ms | 50.1 / 70.1 / 30.1 ms | 0 | 0 | -17.4 / 36.5 ms | 69.8 ms | 48000 Hz |

Counters are the delta over the settled window, which starts 20 s in. The publisher is one Chromium
page on the real device with echo cancellation, auto gain, noise suppression and Opus DTX all off,
confirmed on the element's own track rather than on a second `getUserMedia`, and restarted before
every row.

Three things the table says. The estimator lands on 40 ms on every engine and both rings, so they
agree with each other to the bucket. Held is 60 ms everywhere, a third of the LAN ceiling. And no row
underran or skipped, including the two that ran the WebSocket fallback.

Firefox negotiated WebTransport rather than the WebSocket fallback, because the user-agent gate in
`js/net/src/connection/browser.ts` admits Firefox from 153.0 and this is 155.0. So the WebSocket lane
here is WebKit and Safari, not Firefox. Firefox no longer underruns after convergence on this tip;
the episodes an earlier pass recorded were its own content process blocking its read loop and the
estimator taking the block as path delay, which is finding 12.

The shared-ring row's `+23.9 ms` skew p50 and its 114.3 ms `videoLead` are the 50 ms poll's reading
offset, not a deeper buffer: both statistics moved by the same 40 ms against the plain row while the
ring's held and level agree to 0.1 ms. That is the "Conferencing targets" resolution again.

**The first real-Safari attempt produced no audio at all.** One Element Click was delivered,
`document.hasFocus()` was true, the `mic.hang` tile was found and its catalog arrived, video kept
painting for the whole minute, and the `AudioContext` read `suspended` at all twenty samples of the
five second post-click timeline and never reported a playhead within 60 s. The retry played, with the
context `suspended` at 34 ms and `running` from 288 ms onward. That is one run in eight on this
build, and it is finding 15: the click did start a context, and the next catalog frame closed it and
built a replacement that was born suspended. After `de641c6b5` the same driver, the same one click,
ran 8 of 8 with the context `running` 4 to 12 ms after the click and a single context per run. The
two Playwright microphone rows were re-run on that commit as a control and are unchanged: Chromium
held 60 ms with 0 underruns and skew p50 -10.2 ms, Firefox held 60 ms with 0 underruns and skew p50
-16.8 ms.

**The file sources, per engine, on the earlier build.** The same engines against `bbb-smooth.hang` on
the local relay and `bbb.hang` on the public one, 90 s a row, sampled every 250 ms. They were not
re-run after the two publisher fixes, because neither fix can reach a file publisher: both `bbb`
sources come off one container timeline and so carry no epoch offset at all. Chromium's rows for the
same two sources are in "The three pages, live" above.

| Source | Engine | Transport | Target | Held | Underruns | Concealed | Skew p50 / p95 |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| `bbb-smooth.hang`, LAN | Firefox | webtransport | 100 ms | 123 ms | 1 | 40 ms | -24 / 3 ms |
| `bbb-smooth.hang`, LAN | WebKit | websocket | 80 ms | 103 ms | 0 | 0 | -21 / 2 ms |
| `bbb-smooth.hang`, LAN | Safari 26 | websocket | 60 ms | 83 ms | 0 | 0 | -22 / 3 ms |
| `bbb.hang`, cdn.moq.pro | Firefox | webtransport | 200 ms | 223 ms | 0 | 0 | -26 / 1 ms |
| `bbb.hang`, cdn.moq.pro | WebKit | websocket | 200 ms | 223 ms | 0 | 0 | -20 / -1 ms |
| `bbb.hang`, cdn.moq.pro | Safari 26 | websocket | 200 ms | 223 ms | 1 | 60 ms | -21 / 2 ms |

The estimator lands in the 20 to 100 ms band on every engine for both LAN sources and the engines
agree to within one 20 ms bucket. The public relay settles at 200 ms on all three, 223 ms held once
the 23.2 ms AAC chunk is counted. The skew columns here are the **signed** p50 and p95, which is the
statistic the older tables printed under that name, so they are not comparable with the p95 of the
absolute value printed in the microphone table above; "Conferencing targets" says which is which and
why.

### The mute and preset sequence, per engine

The user's sequence on the microphone broadcast: ten seconds at auto, mute for three, unmute, then
2000 ms, 100 ms and auto presets for eight seconds each, five quick mute/unmute pairs, and ten
seconds idle. Skew is measured from the mute onwards, because the opening ten seconds are the cold
start rather than the toggle.

| Engine | Worst skew | Where | Skew p50 | Underruns |
| --- | ---: | --- | ---: | ---: |
| Firefox | 3256 ms | 0.2 s after unmute | -14 ms | 0 |
| WebKit | 3076 ms | 0.1 s after unmute | 3 ms | 0 |
| Safari | not measured | the ring never started on that build | - | - |

Real Safari on that build reached a tile and a catalog and no audio playhead, so there was nothing to
measure a skew against. What that was is the retraction below and finding 15: a click did start the
context, and the catalog frame that follows it closed that context and replaced it with a suspended
one.

Both engines that ran it spike the same way at the same place: unmuting after three seconds of mute
leaves video roughly three seconds ahead of the audio playhead for about a second, then it recovers.
It is the muted interval reappearing as skew, and it is the same shape in an engine on WebTransport
and an engine on a WebSocket, so it is the player rather than the transport. It survived the fixes
the branch had at the time of this run, and the paragraph below is what it turned out to be.

The mechanism is the port hop the postMessage ring reports its playhead over, which is the ring a
page gets unless it is cross-origin isolated. A mute flushes the ring, and the state message already
on the port when `reset` posts describes the ring the flush threw away, so its playhead is a whole
mute behind the one the reader resumes from. It was also the last thing the main thread heard until
the graph was connected again, because a disconnected worklet is never pulled and so never sends
another, which is the second the spike lasts. The worklet now echoes the timeline of the flush it
last applied and the main thread drops any message from an older one. The shared ring needs no
counter: a flushed ring is unanchored and simply publishes no playhead until the next insert
re-anchors it. A timestamp comparison would not do in either case, because the stale message carries
a position the ring really was at, and one the reader will never resume from does not look any
different from one it has not reached yet. `sync.replay.test.ts` replays the sequence over the
fallback transport with that message delivered, and the skew it measures goes from 2992 ms to 37 ms.

The sequence was then run again on a served build of the tip, against one Chromium publisher on the
real microphone. The spikes are gone. What `8700f1fcc` left behind was 332.9 ms in Firefox, and that
residual was not the player at all: it was the publisher's own audio and video epochs sitting a third
of a second apart, which a mute exposes because it takes the audio clock away and hands the picture to
the video arrivals. That is finding 14, fixed in `eb4331877`. What is left is one held interval: the
target plus the chunk the ring holds, 60 ms in these runs, and every worst reading is that interval
wide.

| Engine | Ring | Worst skew | Where | Skew p50 | Underruns |
| --- | --- | ---: | --- | ---: | ---: |
| Safari 26 | postMessage | -41.1 ms | 1.3 s after `delay 100ms` | -13.9 ms | 0 |
| WebKit | postMessage | 64.3 ms | 0.2 s after the fifth quick unmute | -14.2 ms | 0 |
| Chromium | shared | 73.7 ms | 0.2 s after the fourth quick unmute | -6.9 ms | 0 |
| Firefox | postMessage | -46.8 ms | 3.0 s before the auto preset | -18.7 ms | 0 |

The first three rows are the quiet re-measure, one row at a time with nothing else loading the
machine; the Firefox row is from the first pass on the same tip and was not re-run. Every row passes
the 200 ms toggle rule with room to spare, 41.1 to 73.7 ms, and none of them underran anywhere in the
sequence. Where an engine peaks after an unmute it peaks 0.2 s after it, which is the unmute
transient rather than a preset change.

**Real Safari ran the sequence for the first time**, and it is the tightest of the four: worst skew
-41.1 ms, p50 -13.9 ms and p95 30.4 ms from the mute onwards, zero underruns, one Element Click, the
WebSocket transport. Re-run on `de641c6b5` it is unchanged: worst -43.6 ms, 1.6 s after the
`delay 100ms` marker, p50 -15.9 ms, zero underruns.

**WebKit's idle-tail underrun did not repeat.** The previous WebKit toggle recorded a single underrun
8.3 s after the last unmute, in the idle tail. This run records none, so that was a one-off rather
than a property of the sequence.

**Chromium on the shared ring records one skip, and it is the preset doing its job.** 1900 ms
skipped, at 24.0 s, 0.3 s after the `delay 100ms` marker: the ring discarding the 1.9 s it was
holding for the `2000ms` preset the sequence had just left. Counted against the zero-skips rule that
is a failure on a local row; by cause it is the only thing a drop from 2000 ms to 100 ms can mean.

One limitation of the measurement, on all four rows. Each records six intervals with no
`audio.out.timestamp` at all, one of about 3.0 s and five of 0.5 to 0.76 s, lining up one for one
with the six mutes. A muted player publishes no playhead, so the skew metric is blind for the 6.0 to
6.8 s the tile is muted, which is by design (see `8700f1fcc`) and not a gap the engine could fill.

### Browser publishers

| Publisher | Watcher | Result |
| --- | --- | --- |
| Firefox 155 | Chromium | published; target 20 ms, held 40 ms, level p50 40 ms, zero underruns, skew -19/-2 ms |
| WebKit 26.6 | Chromium | could not run: `no video permission`, `no audio permission` |

The Firefox publisher is the tightest row in this whole pass: a 20 ms target over a 20 ms Opus
chunk, 40 ms held end to end on the LAN. Its track reports `echoCancellation`, `autoGainControl` and
`noiseSuppression` all false, so that is the raw device.

WebKit could not be made a publisher here, and the reason is the harness rather than the engine.
Playwright's WebKit rejects `newContext({ permissions: ["microphone"] })` with `Unknown permission:
microphone`, and it has no `--use-fake-ui-for-media-stream` equivalent, so `getUserMedia` is denied
and the publish element logs `no video permission` / `no audio permission` and never announces. What
the engine does support was checked directly: `AudioEncoder` and `VideoEncoder` both exist and
`AudioEncoder.isConfigSupported({codec: "opus"})` is true, and the session itself reaches
`connected` over a WebSocket. `MediaStreamTrackProcessor` is absent, which
`js/publish/src/video/processor.ts` already has a fallback for. So WebKit publishing is untested
rather than broken.

### Retracted: real Safari does get a browser publisher's catalog

An earlier pass recorded this as the one hard engine defect: real Safari 26.6 on the WebSocket
transport never receiving the catalog of a broadcast published from a browser, while the two
ffmpeg broadcasts on the same session delivered theirs in under five seconds. That conclusion does
not hold. Re-tested against the same relay, the same page and the same headed Chromium publisher
(real microphone and camera, Opus at 16 kHz and `avc1.640028`), real Safari gets the catalog every
time, in about the same 140 ms as the ffmpeg broadcasts on the same session.

| Run | Publisher age when Safari connected | Result |
| --- | --- | --- |
| 30 s, no interaction | 2 min | catalog at 143 ms, against 140 ms and 141 ms for the two ffmpeg broadcasts |
| 90 s, publisher started 30 s in | 0 | catalog within 5 s of the announcement, then stable |
| 60 s, alongside a non-browser subscriber | 5 min | both got it; the non-browser client at 4 ms |
| 60 s, tile clicked and muted/unmuted every 5 s | 25 min | catalog and video for the whole run |

Subscriber churn does not degrade it either: 24 cycles of connect, subscribe to `catalog.json` and
leave, a quarter of them abandoning the session without closing anything, answered in 3 ms to 9 ms
every time.

What does reproduce the reported symptom exactly, and reproduces it for any engine, is subscribing
to a broadcast whose publisher has died without closing its session. Killing the publisher's browser
process outright leaves the relay with a WebTransport session it has no way to know is gone, and for
the length of the QUIC idle timeout it keeps the broadcast announced and keeps accepting
subscriptions to it:

```text
  1s announced=true  catalog=TIMEOUT
 ...
 35s announced=true  catalog=TIMEOUT
 36s announced=false catalog=reset(StreamError: remote error: 33)
```

Thirty seconds of `subscribe ok` followed by silence, then a retraction and a loud RESET\_STREAM once
`DEFAULT_IDLE_TIMEOUT` in `rs/moq-tokio/src/quic.rs` expires. That reset carries stream code `0x33`,
which `js/net/src/error.ts` names `NotFound`. Inside that window the tile is on the
page, the session is `connected`, no group ever arrives, and nothing is written to the console: the
reported signature, line for line. The subscriber in the trace above is a Bun `@moq/net` client on
the WebSocket transport, so none of it is Safari. `rs/moq-relay/src/websocket.rs` says the same thing
from the other side, in the comment explaining why the WebSocket path needs its own keep-alive:
without one, "every broadcast it published stays announced for that entire window".

The original evidence supports that reading rather than the engine one. `check2.json` from that pass
is a Chromium watcher on the native WebTransport transport showing the identical all-null shape, on
`demo/mic-chromium-mu0hvt72.hang`, recorded at a point where the publisher log shows that name had
already been replaced by `demo/mic-chromium-mu0j4p5m.hang`. And the Safari-versus-WebKit comparison
that the claim rested on was not simultaneous: WebKit passed on `mu0j4p5m` at 20:56, Safari failed on
it at 21:00 and 21:02, and no non-Safari watcher was run inside that window to tell a broken engine
apart from a publisher that had stopped serving.

Nothing here is a defect in `js/net`, `js/watch`, `js/publish` or the relay's WebSocket path. What is
left is a diagnosability gap worth its own scope: a subscribe to an announced broadcast whose
publisher is gone is acknowledged and then silent for the whole idle-timeout window, which a viewer
cannot tell apart from a publisher that is merely slow to produce its first group.

One softer Safari note from the same runs, fixed in two steps: the `moq-watch` element built its
`AudioContext` only once the catalog named an audio rendition, and `unlockOnGesture` was armed at
that moment, so the click that selected the tile had already passed. In Chromium and Firefox the
unconditional `resume()` succeeded anyway; in real Safari it did not, and a viewer had to click a
second time after the video appeared before they heard anything. `b86b03c94` armed the listeners from
the moment audio is enabled, before any context exists, and `resume()` runs when one appears and on
every gesture until it is running.

Measured with one Element Click on a tile for a broadcast that had not started yet, so the click
always preceded the catalog: 6 of 6 runs play on one click, counting a run only when the context
reached `running` and rendered output grew. Real Safari 26 is 4 of 4, twice on a 48kHz broadcast and
twice on a 16kHz one, with Chromium and Firefox 1 of 1 each, every run on a Bluetooth headset whose
own rate is 44100Hz and so matches neither. The muted-tile path measured the same way: 4 of 4 (Safari
twice, Chromium and Firefox once each, on a broadcast already publishing so the graph was pre-built
while muted, `suspended` before the click everywhere except Chromium, where its autoplay policy had
already started it, and `running` within 572ms after).

**One conclusion drawn there is wrong, and correcting it is finding 15.** That pass read "a page's
activation carries to a context created later", from a context that appeared about 2.3 s after the
click and resumed anyway. It does not carry. WebKit honours a `resume()` outside a handler only while
the page's activation is still live, which is a few seconds; past that the context stays suspended
for good, video keeps painting and nothing is ever rendered. Both of that pass's measurements sat
inside that grace, which is why they passed, and a 2.3 s delay is not evidence of anything beyond it.
What did hold is the other half: one activation starts one context, which is why building a context
inside the gesture handler was tried and rejected (at 16kHz the primed 48kHz context was still open
and `running` when the graph rebuilt at the decoded rate, and the replacement stayed `suspended`, 0
of 2 against 2 of 2 for arming alone). The same statement now reads: a gesture is reliably spent only
on the context that exists when it lands, so the graph must keep that context rather than rebuild
around it.

## Findings for the maintainer

Things found while working that are separate from the fix.

1. **`demo/web` pinned `delay="100ms"` on every tile.** That is the "100 ms chip on a fresh session"
   from `watch.md`. Nothing was restoring anything, and no storage was involved. Fixed in
   `a7c1a8182`.

2. **`ui/components/buffer-control.ts` sets a numeric delay on mousedown.** A single click on the bar
   therefore leaves auto without the user asking for a value. Not changed here; it is a UI decision.

3. **The released `latency` attribute falls back to a silent 100 ms** for an unparseable value, where
   its `delay` sibling warns and falls back to the element default. Made consistent in `12e015af5`.

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
   `<moq-watch conceal>` exists (`e5d36eb1f`). It is the only new attribute.

8. **The shaper's own jitter was reordering datagrams, and it was grading the wrong thing.** Each
   datagram drew its release time as `now + delay + jitter * gaussian`, independently of every other
   one, so on any profile with non-zero jitter a later datagram was routinely released before an
   earlier one. QUIC read that as loss, retransmitted, and backed off, so a profile named `mild` was
   measuring congestion response. Real jitter is queueing delay on a FIFO path: it varies the delay
   and preserves the order, and only the reorder draw is meant to overtake, which is what makes a
   reorder a deliberate act the counters can attribute. Fixed in `f65ab9351`: each lane remembers
   when the datagram in front of it leaves and clamps the next one to that, before any reorder delay.
   On the 60 s opus plain rows, target p95 falls from 1960 ms to 420 ms on `mild` and from 1760 ms to
   360 ms on `high-rtt`.

   The mechanism is worth stating, because it is the player behaving correctly on a path that was
   lying. The reordering cost the *video* stream, not the audio one: audio is small and fits a
   datagram, video is a stream that QUIC throttled as it retransmitted. Under the reordering shaper
   the measured audio spread stayed at 100 to 180 ms while the video spread ran at 1.6 to 2.0 s, and
   `Sync` in auto takes the larger of the two across tracks, so the audio buffer was dragged to 1.5
   to 3 s by a number that had nothing to do with audio arrivals. Every jittered row's inflated
   `target p95` in the recorded budgets was that, and every one of them came down when the shaper
   stopped reordering. Whether one track's spread should be allowed to size another track's buffer is
   a real question for the maintainer, separately from the shaper defect; this branch keeps the
   `max()` across tracks that #3517 had.

9. **The harness has to address the shaper by `127.0.0.1`, not by `localhost`.** Chromium resolves
   `localhost` to `::1` first, and `moq-shaper` binds IPv4. With the WebSocket fallback still in the
   page that produces a silent fallback to TCP straight past the shaper, which the production page
   would do too; with the fallback removed, as the harness removes it, the page simply never
   connects. Neither failure says what went wrong. Every URL the harness hands the page is literal
   `127.0.0.1` for that reason. It is also a second argument for finding 4: a page that races a
   WebSocket against WebTransport turns a name-resolution mismatch into a working but unimpaired
   session, and there is no option on `Connection` to refuse that.

10. **Publisher mute played as concealment, then room noise, for as long as the mute lasted.** A user
    published from a real microphone, muted it, and the watcher carried on making sound. Two
    mechanisms, one on each side.

    On the wire, a mute is invisible. The publish element's `muted` turns the audio encoder off, the
    frames stop, and nothing says whether the next one is late or never coming. A capture of the
    audio track across a 10 s mute, taken from the watcher's own connection, carried no marker of
    any kind: group 590 at 14.81 s, then group 591 at 24.86 s, contiguous sequence, ten seconds of
    presentation missing. The only thing that eventually stopped playback was the rendition leaving
    the catalog, which is a different track, arrives on its own schedule, and on a loaded or remote
    relay can lag the audio it describes by a lot.

    In the reader, concealment had no end. Commit 31 deviated from the pinned Chromium tree on
    purpose and faded the concealment into the background level rather than to zero, on the reading
    that ending an outage in digital silence was a regression. It is not: current WebRTC does end
    there. `Expand::Process` scales each block by `mute_factor`, lowers it by the muting slope, and
    pins it to zero outright past the third consecutive expansion, and
    `BackgroundNoise::GenerateBackgroundNoise` ignores both the slope and the `TooManyExpands()` it
    is handed and never raises its own mute factor, which `ChannelParameters::Reset` leaves at 0. On
    a file or a tone the difference is inaudible, because the estimated background is the digital
    floor. On a microphone it is the room, and the listener hears it forever.

    Both are fixed. Concealment now fades to silence and the ceiling is silence, in both engines.
    The publisher writes the empty frame hang already defines as an audio endpoint when muting stops
    the encoder, and declares a break before the first frame when it resumes; the watcher carries
    the endpoint to the ring, which renders silence with no concealment, no underrun, and hands the
    clock to wall time at once.

    Measured on this worktree's `demo/web`, headed Chromium, the real microphone, the local relay,
    the shared-memory ring, 12 s of speech then 12 s paused then 12 s of speech. The pause is the
    capture graph suspended rather than the element muted, so the subscription outlives it and the
    engine's own behaviour is what is being measured:

    | Ring | | RMS p50 over the pause | peak | first silent 100 ms bucket | silent from then on |
    | --- | --- | ---: | ---: | ---: | ---: |
    | shared | before | 2.2e-4 | 1.6e-3 | never, over 12 s | no |
    | shared | after | 0 | 4.3e-4 | 0.2 s | yes |
    | postMessage | before | 3.1e-5 | 1.2e-4 | never, over 12 s | no |
    | postMessage | after | 0 | 6.1e-5 | 0.2 s | yes |

    The postMessage pair ran in a quieter room, and it shows the mechanism plainly: over that pause
    the before run's RMS *rose*, from 1.9e-5 while real audio was playing to 3.1e-5 once concealment
    took over, because the comfort noise it settled on was louder than the room the microphone was
    actually sending.

    The largest sample-to-sample step anywhere in the pause is 9.2e-5, so it fades rather than cuts,
    and audio is back in the first 100 ms bucket after the resume. The engine still conceals the
    outage (`concealed` grows by 11.4 s of samples in both runs, since nothing declared it): what
    changed is where the concealment ends up. Both rings were measured, because the shared one is
    what a cross-origin isolated page gets and the postMessage one is what production serves.

    With the element's own mute, and so the endpoint, the local relay delivers the catalog update
    within ~100 ms and `<moq-watch>` tears the whole audio graph down when the rendition leaves the
    catalog, which is faster than the probe's resolution. What the run does show is the counter:
    `audio.out.debug.concealed` over the same sequence went from 46,244 samples before to 0 after.
    The endpoint's own path is covered by unit tests on both rings instead.

11. **The re-anchor above handed the decoder a chunk it refuses, and the audio never came back.**
    `DataError: Failed to execute 'decode' on 'AudioDecoder'` in roughly one run in three of
    `chromium-opus-48000-mild-isolated`, always within a second of a rendition handover. This one is
    the branch's own: `c153b2a69` introduced it, and it does not pre-exist upstream. `upstream/dev`'s
    audio decode loop has no `#reanchor` and no `Terminal.continues`, so the throwing call site is
    not there at all; its only reset site is the container discontinuity in `#onNext`, which is
    always followed by a group's first frame. The harness agrees: no run recorded before the hole fix
    carries it (`aq-final-1` at 02:14, `aq-enforce` at 03:13), and every run after it carries exactly
    one (`aq-int-1` at 16:20, `aq-int-2` at 16:45, `aq-int-enforce` at 17:12). `c153b2a69` is dated
    13:02, between the two groups, and a sweep of every recorded run directory finds the string in
    those three and nowhere else.

    The mechanism is one line. `Container.Consumer` marks only a group's *first* frame `keyframe:
    true`, and deliberately so: `Cmaf.Format` never reports an audio keyframe, because packagers flag
    every audio sample a sync sample and each one would otherwise open an epoch. WebCodecs is the
    other way round: a decoder that was just configured, reset, or flushed accepts only a chunk
    marked `key`. `#reanchor` resets and reconfigures the decoder and then the loop decodes the very
    frame that reported the hole, and that frame is mid-group far more often than not, so Chromium
    threw. The throw escaped `effect.spawn`, which ends the decode loop for the life of the session:
    the ring drains, `stalled` latches true, and RMS sits at zero for the rest of the run. The
    DataError is not a symptom of the audio dying, it is what kills it.

    Instrumented and reproduced deterministically at 240 s, where the publisher's catalog update at
    about 183 s replaces the audio subscription:

    ```
    received catalog / subscribe close id=1 / subscribe start id=3   the handover
    decode ts=182860000 key=true  grp=79 idx=0    first frame of the run, forced key
    decode ts=182903229 key=false grp=79 idx=1    43.2 ms later, no hole reported yet:
                                                  nothing had decoded, so there was no
                                                  frame duration to measure one against
    reanchor at ts=182946438 key=false grp=79     43.2 ms again, now measurable: a hole
    reanchored state=configured                   flush, reset, configure
    decode ts=182946438 key=false ...             DataError
    ```

    The 43.2 ms spacing is the handover joining a group already in flight under the subscription's
    own max age, which is why the re-anchor was right to fire. What was wrong is the chunk it was
    then handed.

    Fixed by `audio/anchor.ts`: a small `Anchor` that remembers the decoder was restarted and types
    the chunk that reopens the run `key`, whatever the container called it. That is the same claim
    the container already makes at every group boundary, and it is sound for exactly the reason
    re-anchoring on an arbitrary frame is sound: every frame of Opus, AAC and MP3 is independently
    decodable. Nothing is wrapped in a catch, so a decode that still fails surfaces the way it does
    today. Both decode loops and both drain sites (`#reanchor`, `#declareEnd`) mark it, since a flush
    alone ends the run the decoder will accept a chunk into.

    `anchor.test.ts` drives a mock decoder that refuses a non-key chunk the way Chromium does; four
    of its five cases fail against the old `frame.keyframe ? "key" : "delta"`. Six 240 s harness runs
    of the row after the fix, each of which reached the handover, record zero occurrences.

    One nuance worth passing on. The observed failure is this branch's, but the class of it is not
    quite. The `#onNext` epoch reset exists on `upstream/dev` too, and it also resets, reconfigures,
    and then decodes whatever the consumer hands back. That is normally a group's first frame, so it
    is normally a key. The exception is `Consumer.#checkReset`: a publisher rewind resumes from the
    earliest surviving group, and a survivor may already be part delivered, in which case the frame
    after the discontinuity is mid-group. No run here has hit it, so this is a reading of the code
    rather than a measurement, but the `Anchor` closes it wherever it is adopted. `Video.Decoder` has
    no equivalent exposure: it configures once per run and never resets, and its frames are not all
    independently decodable anyway, so it keeps the container's own flag.

12. **Firefox's underruns after convergence are not the path.** Watching the same broadcast over the
    same relay at the same moment, Chromium's worst reading gap was 46 ms against Firefox's 499 ms,
    and a second Firefox round was clean at 32 ms. What Firefox records as a late arrival is its own
    content process stalling for two to five hundred milliseconds at a time: the worklet keeps
    rendering, `context.currentTime` advances 24 ms over 924 ms of wall clock, the painted video
    timestamp barely moves, and the decoder's p99 of 402 ms is the length of the stall its callback
    waited behind rather than any work the codec did. The damage lands in the estimator.
    `Jitter.observe` already discards a receiver's own reading gap, dropping the arrival reference
    when `idle` and `idle - progress` both exceed one resample interval, and in this trace it never
    fired once: the worst gap was `idle - progress` of 499 ms against a 500 ms threshold, with six
    more between 150 and 500 ms. Each one entered the delay measurement at full weight and stayed in
    the histogram for about twenty-nine seconds of wall-clock memory, so the target climbed from
    40 ms to 780 ms and took about forty seconds to decay back, one bucket per sample. Replaying the
    recorded arrival series through the real estimator, ring and stretcher on the simulated clock
    reproduces it with no browser present: four underruns and an 820 ms peak from the Firefox trace,
    none and 80 ms from the Chromium trace recorded beside it. The guard's shape is right and its
    media term does its job. Only the threshold missed, and widening the target is the symptom
    rather than the fix. Spacing alone cannot separate a 400 ms receiver block from a 400 ms flush,
    so the fix observes the receiver directly: a 50 ms event-loop timer beside the consumer marks
    the arrivals read in the tick after a block of 100 ms or more, and `Container.Jitter.observe`
    takes that as an explicit input, in both languages, and drops the reference for it. The corpus
    gains `receiver-stall` (target stays at 20 ms) and `receiver-stall-unflagged` (the same arrivals
    reach 400 ms, the documented fallback), and the recorded Firefox window is `mic-firefox.json` in
    the replay lane: the estimator peak falls from 1600 ms to 300 ms, the residual being blocks the
    recording's 250 ms sampler could not resolve, and the underruns during the block itself remain,
    because a receiver that stops executing for 674 ms cannot be buffered for without the 1.6 s of
    latency the old target hid it with.

    Two rounds of 120 s each, one Chromium publisher on a pinned USB microphone feeding a Firefox
    watcher and a Chromium watcher of the same broadcast at the same moment, both on the plain page.
    Counters are deltas from 20 s in.

    | Round | Engine | Target p50/max | Level p50/p95/min | Underruns after 20 s | Concealed | A/V skew p50/p95 | Worst gap |
    | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
    | 1 | Firefox | 40/780 ms | 70.9/751.7/0 ms | 1 | 1240 ms | 20.1/39.4 ms | 499 ms |
    | 1 | Chromium | 40/40 ms | 68/81.3/41.3 ms | 0 | 0 | 21.7/41.6 ms | 46 ms |
    | 2 | Firefox | 40/40 ms | 67.8/81.2/47.3 ms | 0 | 0 | 18.4/38 ms | 32 ms |
    | 2 | Chromium | 40/40 ms | 71/84.8/44.1 ms | 0 | 0 | 20/40 ms | 14 ms |

    The microphone is a USB device at 48 kHz, 2 channels, with echo cancellation, noise suppression,
    auto gain and DTX all off. This machine has no built-in microphone, so the publisher is pinned to
    that device by `deviceId` and the run aborts if the live track is on anything else.

13. **A browser publisher stopped seeding catalogs once its first viewer left.** The first watcher
    played; every watcher after it got `subscribe ok` and no catalog frame, so no rendition was
    chosen and the tile sat empty. The publisher logged `publish error: track=catalog.json
    error=remote error: 1` per track as the first watcher went, which is `StreamCode.Cancel`, the
    routine unsubscribe, and restarting the publisher was the only way back: in a call, where viewers
    come and go, that makes a browser publisher single use. Reproduced in Chromium and in Firefox.
    Upstream code, untouched by this branch.

    Three things line up. `js/net/src/broadcast.ts` `subscribe()` dedups on a cached track producer
    it holds strongly, and drops the entry only when that producer closes, so repeat subscriptions
    fan out from one request. Its own comment says the publishing side leaves `register` false, but
    the publishing wire subscribes through a broadcast `Consumer` (`js/net/src/lite/publisher.ts`
    `runSubscribe`), and `Consumer.subscribe` is the call that sets it. And nothing on the publishing
    side closed that producer: `js/publish/src/broadcast.ts` served each subscription from a child
    scope released on `track.closed`, which only its own cleanup would cause. The wire closes the
    subscriber it read from, not the producer behind it.

    So the entry outlived the viewer, and the next SUBSCRIBE fanned out from a catalog track nobody
    writes to between catalog updates. `Json.Snapshot.Producer` publishes the catalog with
    `deltaRatio: 0`, one whole catalog per group and the group closed behind it, so the retained seed
    ages out after `DEFAULT_MAX_AGE_MS`, 5000 ms in `js/net/src/track.ts`. Past that a subscriber
    gets an accepted subscription and no frame, for as long as the publisher runs.

    What hides it is the relay: a watcher arriving within 30 s is served from the relay's own cached
    track and never reaches the publisher at all. The trigger is any re-subscribe after the relay
    releases that cache on its idle timeout, which is what makes it look intermittent.

    Fixed in `cb10a2a66`: the serving scope is released on `Promise.race([track.closed,
    track.unused()])`, so a track that loses its last subscriber leaves the cache, and the next
    subscription raises a fresh request the catalog producer seeds with the current catalog. Serving
    is registered before the close cleanup too, so the snapshot producer drains while the track it
    writes into is still open. Two tests in `js/publish/src/broadcast.test.ts` fail without it. On the
    bench, three watchers of one microphone publisher with 50 s gaps between them all played.

    Two neighbours are recorded rather than fixed. `Rendition.track` documents a demand gate,
    "producers should encode only while this is set", that no longer exists: the publisher encodes
    with zero viewers. Making it real is larger than it looks, because it immediately exposes two
    more, an audio encoder that does not re-anchor after a gated interval (40.7 s of A/V skew on the
    first viewer after one) and a `Container.Legacy.Producer.close()` that throws `group is closed`
    once its track has gone. Those three belong together in one quest rather than in this branch.

    The other shape this fix could take is in `js/net`: hold the publishing side's dedup weakly, the
    way `rs/moq-net/src/model/broadcast.rs` holds its tracks in a `WeakCache`, so an unused track
    leaves the cache on its own. It was not taken because the subscribing side leans on the strong
    entry: it re-checks demand level-triggered, so a tile unmuted a moment later resumes the same
    subscription instead of opening another. Which layer should own it is the maintainer's call.

14. **A browser publish put its two tracks on two different epochs, and sound led picture by a third
    of a second.** `js/publish/src/audio/capture.ts` handed the worklet `zero: performance.now() *
    1000` when the node was constructed, and the worklet stamped each quantum `sampleCount /
    sampleRate + zero`. A capture graph renders a couple of quanta as soon as it is built, then its
    clock stalls about 245 ms while the microphone opens, then runs in real time, so sample 0 carried
    the wall time of the node's construction rather than of the audio it describes, backdated by the
    priming and the stall together. Video has no such gap: `js/publish/src/video/processor.ts`
    `Epoch.stamp` anchors on the first frame's arrival, and a probe inside the page reads it within a
    millisecond of the wall clock. Upstream code, untouched by this branch.

    Measured with that probe on both captures: audio lagged the wall clock by 235 to 272 ms across
    the probe runs, against 0 to -0.3 ms for video, so the epoch offset is the audio lag. The saved
    probe files read 235.0, 238.9 and 249.3 ms; 272 ms is the run quoted in `eb4331877`'s own commit
    message. The same thing read from the watcher's side is
    the video lead, `sync.out.timestamp` minus `audio.out.timestamp`: 352 to 464 ms across five
    publisher runs, and 0 on the file publishers, whose two tracks come off one container timeline.

    Every viewer of a browser publish heard sound that far ahead of the picture, and the skew metric
    could not see it, because video is painted at the audio playhead. It is also the whole unmute
    transient: during a mute nothing nominates a clock, so `Sync.received()` skips video to `maxAge`
    off the live edge (measured at `syncTs - 33`, the 20 ms delay plus one frame), and the unmute
    hands the clock back and walks the picture the offset's worth back down. That is the 332.9 ms
    Firefox still showed after `8700f1fcc`.

    Fixed in `eb4331877`: the worklet posts `currentFrame`, its position on the context's own sample
    clock, and the main thread stamps `zero + frame / sampleRate` with `zero = Time.Micro.now() -
    context.currentTime` read as one pair. The pairing is re-derived whenever an observation runs
    more than 20 ms ahead of the anchor, which is a device opening, a suspend or the machine
    sleeping, and which the framer then sees as the discontinuity it is. A context that cannot say
    where it is in time fails the capture stream rather than shipping a silent offset.
    `getOutputTimestamp()` was measured and rejected: it reports zeros across the priming quanta and
    then sits 24 ms later than `currentTime`, because it describes output rather than capture.

    After: the probe reads 5.0, 5.1 and -8.2 ms over three publisher runs, and the watcher's video
    lead in steady state is 68 to 91 ms (68.6, 73.2, 83.2, 90.5), which is the playout hold rather
    than an epoch. The worst
    skew over the mute sequence falls from 333 ms to -46.8 ms in Firefox, -38 ms in Chromium and
    60.2 ms in WebKit. The new case in `js/watch/src/sync.replay.test.ts` replays the sequence with a
    video arrival feed and a configurable publisher offset: 36.7 ms when the two clocks agree,
    344.7 ms with them 350 ms apart.

    What is left is the camera pipeline's own latency, which sits inside the video arrival anchor and
    cannot be measured from inside the page. An external reference, a clap or a flashing screen
    recorded off the two ends, is what would resolve it, and it is a follow-up rather than something
    this branch settles.

15. **Real Safari played a broadcast's video in silence about one run in eight, and the click had
    already been spent.** On the demo page the click landed on the tile, the tile unmuted, video
    painted for the whole minute, and the `AudioContext` read `suspended` at every sample and never
    reported a playhead. Measured through `safaridriver` with exactly one Element Click per run
    against a microphone broadcast: 7 of 8 runs played, 1 did not.

    Two things spent the activation, and each alone is enough. The graph was rebuilt whenever
    anything in the decoder config changed, and a browser publisher's Opus rendition gains its
    `description` in a *later* catalog frame, so the context the click had just started was closed
    and replaced about 30 ms later by one born suspended. And the unlock was armed only while audio
    was enabled, so the click that unmutes a tile armed its listeners a microtask after its own
    gesture had already passed. Neither should have worked at all. Both did, most of the time,
    because WebKit honours a `resume()` outside a handler while the page's activation is still live,
    which is a few seconds; once that lapses the context stays suspended for good. The retraction
    above records the earlier reading of that grace as a page activation carrying to a context
    created later, and corrects it.

    Fixed in `de641c6b5`. The context is built by an effect keyed on the rate it runs at and nothing
    else, so a later catalog frame rebuilds the worklet and ring *under* a context that is already
    playing. A decoded rate that differs from the catalog's is still a new context, because a
    context's rate is fixed for its lifetime and that is the one case worth paying for. The unlock is
    armed for the decoder's lifetime rather than as a consequence of the click, so a gesture is spent
    on the context that exists when it lands, and it bails where there is no `document` instead of
    assuming a browser. `js/watch/src/audio/decoder.test.ts` counts the contexts a decoder builds:
    one case clicks on a muted tile and expects the context it started to be running, the other feeds
    a catalog frame that only adds the codec description and expects the same context, still running,
    still the only one built. Both fail without the fix.

    After: 8 of 8 real-Safari runs reach `running` 4 to 12 ms after the one click and hold a playhead,
    with a single context per run. Chromium and Firefox microphone rows and the real-Safari mute and
    preset sequence are unchanged, and are in the tables above.

    **One behaviour change to decide on, because it is visible on the demo page.** A gesture anywhere
    on the page now starts the context of *every* tile that has one, since the unlock is no longer
    gated on a tile being unmuted. On the five-tile demo page that is five `AudioContext`s started by
    the first click. They render nothing while their tiles are muted or disconnected, so the cost is
    five idle contexts rather than five sounds. Three shapes:

    - **Keep it.** Simplest, and one gesture reliably unlocks every tile, including the one the
      viewer unmutes a minute later. The cost is the idle contexts.
    - **Start only the tile that was clicked, and arm the rest.** Needs the gesture's target, which
      means the unlock stops being a document-level listener and starts knowing about elements.
    - **Build contexts lazily behind one shared silent unlock context.** A different shape for the
      whole audio graph, and the largest change of the three.

    Recommended: keep it, and say so in the element's docs. An idle `AudioContext` is cheap next to a
    viewer who hears nothing and does not know why, and the two alternatives both buy the saving with
    a coupling the current design does not have.

16. **CodeRabbit over the whole branch: 22 findings, 18 fixed, 4 rejected.** The review exceeded the
    free plan's 150-file cap, so it ran per top-level directory instead. The eighteen real ones
    became `a8cbc93bb`, `97c7afb76`, `b85e57431`, `02f3f143a`, `f5087814b` and this docs commit. The
    four rejected: a suggested `max_age` clamp on the native target that
    `playout::delay::Constraints::ceiling()` already applies one layer down; a claim that
    `playwright@^1.63.0` is unpublished, which `bun.lock` and two sibling harnesses contradict; and
    two on the same line asking for `runs-on: ubuntu-24.04` where the comment above it explains that
    `ubuntu-latest` is deliberate parity with `smoke.yml` and `wasm.yml`.

17. **Upstream's `moq-auth` lease changed what an empty `public` means.** `#3688` made `auth.public`
    a path pattern rather than a prefix, so the harness relay's `public = ""` went from granting
    everything to granting nothing, and every Chromium row would have been voided on a rejected
    session. `8cabb3507` gives it the `"**"` upstream gave the demo and smoke configs. Worth knowing
    for any other config in the wild that still carries the empty string.

## Public API and wire impact

No wire format change anywhere. One wire *semantics* addition: an audio endpoint bounds the source
media rather than the track, so a publisher that pauses declares one and declares a discontinuity
before the frame that resumes. `drafts/draft-lcurley-moq-hang.md` and `doc/concept/hang.md` say so;
the bytes are the empty frame and the empty group that both already define. All of the below is
`dev` material.

**`@moq/net`**

- New `Expired extends StreamError`, re-exported as `Moq.Group.Expired` beside `Lagged`. A peer's
  `DELIVERY_TIMEOUT` reset now decodes to it rather than to a plain `StreamError`: same code, same
  base class.

**`@moq/hang`**

- `Container.Jitter` is now a class, not a namespace. `Container.Jitter.BUCKET` and
  `Container.Jitter.CEILING` are static readonly members rather than module exports.
- `Container.Jitter`'s constructor takes an optional `JitterProps` with a `start`, the publisher's
  declared flush span the cold-start target is taken from. `JitterProps` is a new export.
- `Container.Jitter.observe(timestamp, now, observation)` takes a `JitterObservation` of
  `{reordered?, stalled?}` where it used to take a bare `reordered` boolean. That is a breaking
  change to a published method signature, which is the one reason this slice belongs on `dev` rather
  than `main`. `JitterObservation` is a new export.
- `js/hang/src/container/stall.ts` is new: a `Stall` monitor, one 50 ms event-loop timer per
  document, that tells a consumer whether this receiver was blocked. It is **not** exported from
  `@moq/hang/container`; `Container.Consumer` owns the only instance.
- New `ConsumerProps.jitter`, which passes that declaration through from the rendition config.
- New `Container.Consumer.spread` and `Container.Consumer.skipped`.

**`@moq/watch`**

- `SyncInput` is reduced to `{delay, buffer}`; it loses `probe`, `audio`, `video`, `audioSpread` and
  `videoSpread`.
- `SyncTrack.advertised` is removed. The rendition's declared flush span reaches the estimator as its
  cold start instead, so there is nothing left here to read it.
- A numeric `delay` is now the whole delay. It used to have the advertised flush span added to it, so
  a viewer asking for 100 ms on a source declaring 300 waited 400.
- `Sync.track()` is new, and `Sync.out.clock` names whichever track is driving playback.
- `Clock`, `SyncTrack` and `SyncClockTrack` are new exports.
- `Audio.Decoder.out` gains `spread`, `underruns`, `skipped` and `debug`.
- `AudioBuffer.timestamp` is `Getter<Time.Micro | undefined>` rather than `Getter<Time.Micro>`: a
  ring that has been flushed and not yet re-anchored has no playhead, and zero is not that.
  `audio.out.timestamp` keeps its type and is simply undefined for longer. The `timeline` field on
  the postMessage ring's state and reset messages, which is what lets the main thread drop a message
  composed before a flush, is internal to that transport and not exported.
- `unlockOnGesture` takes a `Getter<AudioContext | undefined>` rather than a context, so the gesture
  listeners are armed before any context exists. Internal to `js/watch`, not exported.
- `de641c6b5` changes nothing on the surface. The `AudioContext` moves into a private effect keyed on
  a new private `#rate` computed, so the worklet and ring rebuild under it instead of replacing it,
  and `unlockOnGesture` is armed for the decoder's lifetime and returns without arming anything where
  there is no `document`. Behaviour does change on a page with several tiles: a gesture anywhere now
  starts the context of every tile that has one, not only of an unmuted tile. See finding 15, which
  states the cost and the alternatives.
- `Video.Decoder.out` gains `skipped`.
- `DecoderInput.conceal` is new, with the element attribute `<moq-watch conceal>`.
- `audioMaxAge` and `maxAgeHeadroom` are new in the audio config module.
- Internal to the audio ring, not exported: `AudioBuffer.end()` on both transports, `RingView.ended`
  on the reader surface, and an `ENDED` control slot, which takes the shared ring from 18 to 19.

**`@moq/publish`**

- No API change. `Audio.Encoder` writes an endpoint when it stops encoding and a break when it
  resumes, which is behaviour rather than surface.
- `cb10a2a66` adds nothing and removes nothing: a served catalog track is now released when its last
  subscriber leaves as well as when it closes. Same messages, same groups; what changes is that a
  later subscriber is seeded instead of being left with an accepted subscription and no frame.
- `eb4331877` is also surface-neutral. The port message the capture worklet posts is a `Quantum`
  rather than an `AudioFrame`, both internal to `js/publish/src/audio` and neither exported. The
  audio timestamps a publisher sends change value, by the epoch error they carried, and the framing
  does not.

**`rs/moq-audio`**

- `decode::Config::delay`, `decode::Config::conceal`, `decode::Config::DELAY_MAX`. `Config` is
  `#[non_exhaustive]`, so these are additive for callers who build through `new`.
- `decode::Consumer::delay` and `decode::Consumer::playhead`.
- The native estimator's `Jitter::observe(timestamp, now, Observation)` takes the same
  `{reordered, stalled}` pair as the browser's. Both the method and
  `playout::delay::Observation` are `pub(crate)`, so this is parity rather than public surface, and
  nothing sets `stalled` natively: a tokio task that stops polling stops reading the socket with it.
- The catalog's `jitter` seeds the native estimator's cold start, which is behaviour rather than
  surface. The `delay` floor is untouched: a caller who knows something the arrivals do not say is a
  different thing from a publisher describing its own encoder.
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

## Departures from the quests

Each of these is deliberate and each is isolated so it can be dropped.

**Concealment is core here.** `watch-audio-time-stretch.md` keeps an underrun a ramped gap and says
no packet loss concealment. The user asked for NetEq's expand and merge. It is its own commit
(`e50230451`), it is switchable with `conceal` on the audio decoder, and turning it off restores the
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

## Verification and limitations

### What was run

- `just fix`, `just check`, `just test` at every stage, scoped to the branch the way CI scopes them.
- The 17-case corpus, replayed in Bun and in nextest, exact integer equality on both sides.
- `bun test` over `js/hang/src/container`, `js/watch/src/audio`, and the sync tests.
- `just rs test -p moq-audio`.
- `just test audio-quality` over the full 24-row matrix, twice: once against `upstream/dev` and once
  against this tree.
- `just test audio-quality --runtime safari`, one 60 s run per row on macOS 26.6 Safari 26: eight
  rows graded, no voids, both rings.
- `just test audio-quality --runtime replay --enforce`, which is a second and grades twelve rows
  against ceilings that are exactly what was measured.
- A CodeRabbit CLI triage per stage, each recorded. The findings that were real became their own
  commits: `c6a256aaa`, `6087621b6`, `ef9f11e06`, `b336e5d86`, and part of `647d15b82`.
- A CodeRabbit CLI pass over the whole branch against `upstream/dev`, run per top-level directory
  because the branch is past the free plan's 150-file cap: 22 findings, 18 fixed, 4 rejected. See
  finding 16.
- A quiet re-measure at the tip, one row at a time with nothing else loading the machine: the three
  pages against the local and public relays, the microphone row per engine on a fixed browser
  publisher, and the mute and preset sequence in real Safari, WebKit and Chromium. Every number in
  the tables above is read out of that run's row JSON rather than off a printed line.
- Eight real-Safari runs on `de641c6b5` and eleven on the commit below it, one Element Click each,
  counting a run only when the context reached `running` and a playhead appeared.
- Listening rounds by the user after the estimator, after the stretch, and after concealment.
- The A/V desync the user reported after all of that, reproduced and re-measured in headless
  Chromium on a fresh `demo/web` build of this tree against the local relay: the user's own sequence
  of mutes and latency presets, sampled every 250 ms, on both rings and with concealment both ways.
  Worst painted-video-minus-audio skew 3418 ms before and 50 ms after; the regression test reruns the
  same sequence with each half of the fix removed.
- Each of the five re-landed fixes has a test that fails without it and passes with it.
- One pre-existing flaky `console.error` spy test was fixed on the way past, in `fcce8af55`.

### Gates on the final tree

Three passes, each stated with the tip it ran on, one command at a time.

At `3dcea2ab4`, 72 commits above `upstream/dev`:

| Gate | Exit | What it covered |
| --- | ---: | --- |
| `just check upstream/dev` | 0 | Every package the branch touches, scoped as CI scopes it |
| `just check-all` | 0 | Every package, every language, including the bindings and the docs site |
| `just test all` | 0 | 4569 Rust tests (8 skipped), 1942 Bun tests across fifteen packages, 63 Python |
| `just test smoke-full` | 0 | 32 of 32 cross-language publish/subscribe pairs |
| `just drafts check` | 0 | 10 drafts, including the hang draft this branch changes |
| `just test audio-quality --runtime replay --enforce` | 0 | 10 rows, 124 enforced checks |
| privacy grep over the branch's added lines | 0 hits | No home path, name, address, token, or session id |
| CodeRabbit CLI, per directory | 22 findings | 18 fixed, 4 rejected with reasons; see finding 16 |

At the tip `5484970e1`, 81 commits above `upstream/dev`:

| Gate | Exit | What it covered |
| --- | ---: | --- |
| `just fix upstream/dev` | 0 | No tracked change |
| `just check upstream/dev` | 0 | Every package the branch touches, scoped as CI scopes it |
| `just test default upstream/dev` | 0 | 4573 Rust tests (8 skipped), 1956 Bun tests across fifteen packages, 63 Python |
| `cargo nextest run -p moq-audio -p moq-shaper` | 0 | 200 tests |
| `just test audio-quality --runtime replay --enforce` | 0 | 12 rows, 148 enforced checks, 0 void |
| `just test audio-quality --enforce` | 0 | 24 Chromium rows at 60 s, 36 enforced checks, 0 enforced breaches |

At the tip `de641c6b5`, 85 commits above `upstream/dev`, after the three fixes behind findings 13, 14
and 15:

| Gate | Exit | What it covered |
| --- | ---: | --- |
| `just fix upstream/dev` | 0 | No tracked change beyond the three delivery documents |
| `just check upstream/dev` | 0 | Every package the branch touches, scoped as CI scopes it |
| `just test default upstream/dev` | 0 | 4573 Rust tests (8 skipped), 1965 Bun tests across fifteen packages, 63 Python |
| `just test audio-quality --runtime replay --enforce` | 0 | 12 rows, 148 enforced checks, 0 void |
| `bun test` in `js/publish` | 0 | 141 tests across 20 files |
| `bun test` in `js/watch` | 0 | 366 tests across 31 files |

The Chromium matrix was not re-run at this tip: the three fixes above it are one `js/watch` effect and
two `js/publish` capture changes, and the matrix has no browser publisher in it, so no row's inputs
moved. The replay lane, which does cover the player, is re-run above and is clean.

The Chromium matrix at `5484970e1` breached 17 recorded ceilings and voided one recorded row,
`opus-near-zero-isolated`, on `AudioContext.currentTime` drifting 4.92 percent from wall clock over
10 s. Both are in the enforced-budgets section above, with every measured value against its ceiling.

**`check-all`, `test all` and `smoke-full` were last run thirteen commits below the tip.** Those
thirteen commits touch `js/watch`, `js/hang`, `js/publish`, `rs/moq-shaper`, `rs/moq-audio`, the
harness, the nightly workflow and the delivery documents. Every one of those is inside the scope the
`check` and `test` at the tip cover, so nothing in them is unchecked; what is not re-run is the rest
of the workspace, which they do not touch, and the cross-language interop lane.

One caveat on the CPU bench in `stretch.bench.test.ts`: its ratio assertion
(`max(stretch) / max(normal) < 30`) fails about one run in fifteen on this machine and passes the
rest, with the absolute budget (0.67 ms) never close. It is a wall-clock ratio on a shared machine
rather than a regression, and it is the one flake left in the suite.

### The budgets, and what the harness will and will not enforce

`test/audio-quality` re-records its budgets from two 60 second runs of the whole matrix: the worst of
the two times 1.5, a hard 0 on the counters the engine has to keep at zero wherever both runs
measured zero, a share capped at 1, and a convergence time capped at the row's own run. A row is
enforced only when its two runs agreed within that same 1.5 on every graded metric, and a metric one
run measured as zero and the other did not counts as a disagreement, because the ratio is unbounded.
An enforced row is therefore one that played the same way twice. **Three of twenty-four are enforced
today**, all three of them `fixed-250`, the profile that adds a constant delay and nothing else. Ten
cleared it on the previous recording, and the re-record on a tree whose targets settle within a
second rather than walking a declaration down for 40 s moved most of the rows out of agreement with
themselves; that is the honest answer rather than a better one. The replay lane is enforced in full,
148 checks across twelve rows, because it is deterministic. Every row, every breach against its
ceiling, and every residual is in "The enforced budgets" above.

### What was not run, or not verified

- **No iOS device.** Desktop Safari over safaridriver is the closest proxy this branch has. iOS is
  not measured, and nothing here should be read as a claim about it.
- **The nightly job has never run on the nightly runner.** `2b9d492f0` adds the `audio-quality` job
  to `.github/workflows/nightly.yml` and it runs `--enforce`, but every number in `budgets.json` was
  measured on one desktop. The first nightly run is what says whether these ceilings hold on the
  runner's hardware, and the rows that are still `recorded` are the ones waiting for it.
- **Local measurements were taken on a loaded machine.** Load average reached 13 to 23 during several
  passes, and everything driven by the local relay shares a CPU with the relay and two ffmpeg
  publishers. One control re-run of the same bytes on the same build gave 1360 ms where an earlier
  pass gave 372 ms. Treat every local number as an upper bound. The public-relay rows are remote,
  single-tile, and held steady across every pass they appear in.
- **Safari budgets were removed** after one cell exceeded its own ceilings on the next run. They were
  recorded at the worst observed times 1.5 and were not stable enough to keep. The Safari lane runs
  and prints; it does not grade.
- **`cargo semver-checks` was not run.**
- **The `4k-webm` fixture has real holes**, so it keeps 1 to 2 underruns, now concealed. That is the
  recording, not the player.
- **`just test smoke-full` is the cross-language gate** for the `moq play` change and should be run
  before any of the native commits are adopted. It was run on the rebased tree: 32/32.
- **The `mild`, `bursty` and `step` Chromium rows do not reproduce themselves.** Two 60 s runs of the
  same tree disagree by 2.2 against 36 skip-aheads a minute and by 460 against 1700 ms of target p95,
  which is why twenty-one of twenty-four rows keep the `recorded` marker. Part of that was the cold
  start: an `auto` row spent 20 to 40 s of its window walking the declaration down, and a target that
  is still moving is one the ring skips against. That is fixed above, in the estimator and in
  `doc/concept/playout.md` rather than in the budgets: the first measurement replaces the seed
  outright, so an `auto` row is on its measured target within a second. `budgets.json` was
  re-recorded against that in `ce2e13112`, and the rows still disagree with themselves: three clear
  the test now where ten did before, which is the honest answer rather than a better one.
- **No listening round has happened on this tip, `de641c6b5`.** The user last listened several
  commits ago. The flushed-ring fix, the receiver-stall input, the five CodeRabbit commits and all
  three of the fixes behind findings 13, 14 and 15 have landed since, and none of them has been
  heard. Every number above is an instrument reading.
- **The two cdn rows from the demo pages could not be run as written.** `https://cdn.moq.pro` with no
  path is what `demo/web` points at, and the public relay closes a session opened at its root, so
  both rows failed to start twice and are recorded that way. `cdn.moq.pro/demo` stands in on both
  pages, and the site page reaches the same relay on its own path. Whether the relay should refuse a
  root session, or the demo page should stop opening one, is not this branch's to settle.
- **`test/audio-quality/clients/js` has no unit test target.** The grader, the beacon, the probe and
  the Safari lane are exercised only by running the harness end to end, which is why the six
  fail-quietly defects in `b85e57431` were found by a reviewer rather than by a test. Giving that
  package a `bun test` target is a follow-up this branch did not take.
- **`aac-high-rtt-isolated` converging in 42.7 s against an 11.6 s ceiling is unexplained.** It is
  the one breach in the matrix run that is outside ordinary run-to-run spread, and it is open.
- **The intermittent `DataError: Failed to execute 'decode' on 'AudioDecoder'` is diagnosed and
  fixed.** See finding 11. It did not predate the hole fix: the earlier note that it appears in the
  stage 8b logs is wrong, and a sweep of every recorded run directory finds it only in the three runs
  taken after `c153b2a69`. It was reproduced deterministically at 240 s, where the publisher's catalog
  update near 183 s replaces the audio subscription, and six 240 s runs after the fix, each reaching
  that handover, record zero.

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

# the recorded traces through the same player, no relay, shaper, or browser: a second
nix develop --command just test audio-quality --runtime replay --enforce

# real Safari, local only, serialised, never in CI
nix develop --command just test audio-quality --runtime safari

# compare two run directories
bun test/audio-quality/clients/js/compare.ts --before <before-dir> --after <after-dir>

# cross-language interop, needed for the moq play change
nix develop --command just test smoke-full
```

A failing run keeps its directory, with each process's log, its generated relay config, and its
endpoints, and prints where it is.

### The listening bench

The measurements above that are not the harness were taken on a small bench built out of the
repository's own recipes. It is written down here because the tables are worth nothing if they cannot
be reproduced. Every URL handed to a browser is literal `127.0.0.1`: Chromium resolves `localhost` to
`::1` first, which is finding 9.

**The relay.** From `demo/relay`, `cargo run --bin moq-relay -- localhost.toml`, which is that
directory's default recipe. QUIC and HTTP on 4443, and the config already grants anonymous access
(`public = "**"`, which is what finding 17 is about).

**The publisher.** From `demo/pub`, the smooth source is the `ts` recipe:

```bash
just ffmpeg-ts media/bbb.mp4 | moq --connect http://localhost:4443 --broadcast bbb.hang import ts
```

`ffmpeg-ts` already passes `-pes_payload_size 0`, and that flag is the whole difference between the
two sources the tables name: with it, one AAC frame per PES and a 140 ms flush span, which is the
smooth row; without it, ffmpeg's default packing of roughly seven frames per PES and the 302 to
372 ms the catalog then declares, which is the bursty row and the arrival shape the public relay has.
The copied site's local rows need the broadcast published under a `demo/` prefix, because that page
connects to `<relay>/<project>` rather than to the relay root.

**The pages.** `bun install`, then from `demo/web`:

```bash
VITE_RELAY_URL=http://localhost:4443 bun --bun vite build
```

which writes `demo/web/src/dist`. Serve that build twice from any static server: once plain, which is
the production postMessage ring, and once with

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

which is the cross-origin isolated page and the shared-memory ring. `vite dev` and `vite preview`
cannot serve the plain page: `demo/web/vite.config.ts` applies `crossOriginIsolation()` from
`js/common/vite-plugin-isolate.ts` to both, so the vite server is always the shared ring. Only the
isolated page should report `crossOriginIsolated`, and checking that per page is what keeps a row
from grading the ring it did not run.

**The copied moq.dev site**, for the third page, is built with its package aliases pointed at this
checkout's `js/` rather than at a published release, and its watch page takes its source and relay
from the query string: `/watch/?project=<project>&name=<broadcast>&relay=<url-encoded relay>`. The
`?project=` is not optional, and it is also why the site row never hit the root-session failure that
the two cdn rows from `demo/web` did.

**The drivers.** Four engines and one publisher, all driven headlessly except where an engine refuses
to be:

- Playwright Chromium, Firefox and WebKit, from the versions the smoke harness already pins, opening
  the served page, clicking the tile once to spend the gesture, and sampling from there.
- Real Safari through `safaridriver`, which is a different network stack, media pipeline and
  AudioWorklet scheduler from Playwright's WebKit and is the only way to measure Safari at all. Two
  rules it does not forgive: **exactly one Element Click per run**, because a second one hides
  precisely the defect finding 15 is about, and **Safari frontmost**, because an unfocused window
  answers an Element Click with `{"value":null}` and the context then sits in WebKit's `interrupted`
  state over total silence.
- The publisher is a headed Chromium page on `publish.html` with `--use-fake-ui-for-media-stream`,
  and never the fake device, whose synthetic signal breaks the encoder. The page has no device
  picker, so the device is chosen from inside it: `enumerateDevices` after the permission grant, the
  USB capture device picked **by label**, handed to the element's microphone source, and then the
  element's own live track read back. The run aborts unless that track is the device asked for and
  its `sampleRate` is 48000. Echo cancellation, auto gain, noise suppression and Opus DTX are all
  off, confirmed on the element's own track rather than on a second `getUserMedia`, and the publisher
  is restarted before every row.
- The mute and preset sequence, which is the toggle table above: ten seconds at auto, mute for three,
  unmute, then the `2000ms`, `100ms` and `auto` presets for eight seconds each, five quick
  mute/unmute pairs, and ten seconds idle. Skew is measured from the mute onwards, because the
  opening ten seconds are the cold start rather than the toggle.

**The sampler.** Every 250 ms it reads the active tile's `<moq-watch>` signals the way
`test/audio-quality/clients/js/src/probe.ts` does (the target `sync.out.delay`, the ring level,
underruns, concealed, skipped, short quanta, the negotiated transport, `crossOriginIsolated` and the
round trip), and additionally the painted video timestamp against the audio playhead, which the
harness does not measure. Counters are deltas from 20 s in.

That last pair has a resolution, and every skew number above is read against it. The metric has a
floor of one frame plus one display refresh, 58 ms at 24 fps and 50 ms at 30 fps, because the painted
frame is the newest one due and it was painted at the last vsync. It has a ceiling of one playhead
reporting interval, 14.5 ms of worklet state messages at 44.1 kHz, 13.3 ms at 48 kHz and one 50 ms
poll on the shared ring, because the reported playhead is not extrapolated while the one video is
paced against is. The pair to grade is therefore the signed lead (p95) and the signed lag (p05), not
the p95 of the absolute value, which over that distribution is 41 to 49 ms whatever the player does.

**The driver scripts themselves are not on the branch.** They were written as bench scaffolding
outside the repository and they are not in a state worth committing as they stand. The judgement
worth recording rather than acting on tonight is that they have a natural home:
`test/audio-quality/clients/js` already carries `driver.ts`, `safari.ts`, `webdriver.ts`, `sink.ts`
and `replay.ts`, which do most of this against the harness page, so folding the headed publisher, the
per-engine matrix and the toggle sequence in beside them is the right shape. That is a follow-up,
listed below, and it is the same follow-up as giving that package a `bun test` target.

## Open items and follow-ups

### The state of the branch

`debug-findings-solution` on the fork `fperex/moq`, base `dev`, opened as draft pull request #3 there
and nowhere else. The last change to the player itself is `de641c6b5`; the commits above it are this
document, and the fixes named under "Work in progress at this tip" as they land. An earlier state of
the work is archived on `debug-findings-solution-wip-20260912`.

Two things that produced numbers above are deliberately not on the branch: the full run matrix the
quiet re-measure wrote, and the bench driver scripts. Every number from the matrix that matters is
folded into this document, which is the thing to read; the drivers are described in full under "The
listening bench" and have a home proposed below.

### Quests worth opening

- **The publisher demand gate.** `Rendition.track` documents a gate, "producers should encode only
  while this is set", that no longer exists: a browser publisher encodes with zero viewers. Making it
  real is larger than it looks, because it immediately exposes two more defects, an audio encoder
  that does not re-anchor after a gated interval (40.7 s of A/V skew on the first viewer after one)
  and a `Container.Legacy.Producer.close()` that throws `group is closed` once its track has gone.
  Those three belong together in one quest rather than in this branch. Finding 13 has the detail.
- **The camera's own pipeline latency.** Finding 14 fixed the publisher's two epochs, and what is
  left sits inside the video arrival anchor and cannot be measured from inside the page. An external
  reference is what would resolve it: a clap, or a flashing screen, recorded off both ends at once.
- **The multi-tile audio context decision.** Finding 15's fix arms the unlock for the decoder's
  lifetime, so a gesture anywhere on the page now starts the context of every tile that has one,
  which on the five-tile demo page is five idle contexts on the first click. The three shapes and the
  recommendation (keep it, and say so in the element's docs) are in finding 15. It is the
  maintainer's call and it is the only behaviour change on this branch that a page can see without
  listening to it.
- **A `bun test` target for `test/audio-quality/clients/js`**, and the bench drivers folded in beside
  `driver.ts`, `safari.ts` and `webdriver.ts` while it happens. The grader, the beacon, the probe and
  the Safari lane are exercised only by running the harness end to end, which is why the six
  fail-quietly defects in `b85e57431` were found by a reviewer rather than by a test.
- **Whether one track's spread should size another track's buffer.** `Sync` in auto takes the `max()`
  across tracks, which #3517 had and this branch kept. The shaper defect (finding 8) is what made it
  visible: the reordering hurt the video stream, the video spread ran at 1.6 to 2.0 s while audio
  stayed at 100 to 180 ms, and the audio buffer was dragged to 1.5 to 3 s by a number that never came
  from an audio arrival. The shaper is fixed; the question is not.
- **Which layer owns the publish-side dedup.** Finding 13 is fixed in `js/publish` by releasing the
  serving scope when the track loses its last subscriber. The other shape is a weak cache in
  `js/net`, the way `rs/moq-net/src/model/broadcast.rs` holds its tracks, and it was not taken
  because the subscribing side leans on the strong entry to resume a tile unmuted a moment later.
- **A diagnosability gap, from the retraction.** A subscribe to an announced broadcast whose
  publisher is gone is acknowledged and then silent for the whole QUIC idle-timeout window, which a
  viewer cannot tell apart from a publisher that is merely slow to produce its first group. Nothing
  is broken; there is simply no way to tell.
- **An option on `Connection` to refuse the WebSocket race**, which is finding 4 and, with finding 9,
  is two ways the same silent fallback hides an impaired or misaddressed UDP path. The harness works
  around it by deleting `WebSocket` and `WebSocketStream` on the page, which is a test hack.
- **`rs/moq-relay/tests/drills.rs`**, which compiles zero tests today (finding 5). The shaper's
  impaired second lane is written as a patch and was deliberately not landed on top of a test file
  that does not build.

### Open measurements

- **The twenty-one `recorded` harness rows.** They print a breach and do not fail a run. What would
  move them is the nightly runner recording its own budgets on its own hardware; every ceiling in
  `budgets.json` today was measured on one desktop.
- **`aac-high-rtt-isolated` converging in 42.7 s against an 11.6 s ceiling.** It is the one matrix
  breach outside ordinary run-to-run spread, and nothing here explains it.
- **The hard-zero ceilings breached by a single episode.** Ten of the seventeen breaches are a 1.1 a minute
  episode and the 272 ms of concealment it cost, against a ceiling of zero that the recording
  rule produced because both recorded runs happened to measure zero on a counter that is not reliably
  zero. That is a recording artefact rather than a regression, and it is what the `recorded` marker
  exists to absorb.
- **The clock-drift void on `opus-near-zero-isolated`**, `AudioContext.currentTime` drifting 4.92
  percent from wall clock over 10 s. The guard did its job; why the context drifted is open.
- **The `bursty` and `step` skip-ahead residuals**, worst at 63.8 a minute on `opus-step-plain`. A
  160 ms flush arriving as one burst still outruns what 15 ms of stretch per 100 ms of output can
  absorb, so the band still fires. That is the next piece of work on the engine, and this branch does
  not claim it.
- **The sampler's own resolution.** Skew is read on a 250 ms grid, and the signed lead and lag are
  what it can resolve; the p95 of the absolute value is 41 to 49 ms by construction and grading
  against it grades the sampler. A finer instrument, or a painted-frame callback rather than a poll,
  is what would settle the residual tens of milliseconds either way.
- **WebKit's idle-tail underrun did not repeat.** One underrun 8.3 s after the last unmute, in the
  idle tail, on the previous toggle pass; none in the re-measure. Recorded as a one-off rather than a
  property of the sequence, and worth watching rather than chasing.
- **The two cdn rows from the demo pages cannot be run as written.** `demo/web` points at
  `https://cdn.moq.pro` with no path and the public relay closes a session opened at its root, so the
  page subscribes to the announce prefix `""`, is dropped, and reconnect-loops without ever showing a
  tile. `cdn.moq.pro/demo` stands in on both rows. Whether the relay should refuse a root session, or
  the demo page should stop opening one, is not this branch's to settle.
- **The `wasm32` debug artifacts** and **the `demo/web` tile arming residual**, both carried from an
  earlier pass, neither reproducing on this tip; the arming residual measured fine.
- **One flake is left in the suite**, the CPU bench's wall-clock ratio assertion in
  `stretch.bench.test.ts`, about one run in fifteen, with the absolute budget never close.

### The listening state, plainly

**Nothing on this tip has been heard.** The last listening round was several commits below it. The
flushed-ring fix (`8700f1fcc`), the Safari unlock (`b86b03c94`), the receiver-stall input
(`d5886766f`), the five CodeRabbit commits, and all three of the fixes behind findings 13, 14 and 15
(`cb10a2a66`, `eb4331877`, `de641c6b5`) have landed since, and none of them has been listened to.
Every number in this document is an instrument reading. The bench above is what a listening round
would be run on: the relay, the plain page, the copied site page, and one smooth `bbb.hang` publisher
on the fixed recipe.

## Attribution and licensing

**WebRTC.** `modules/audio_coding/neteq` in the Chromium tree is the specification for everything in
`js/watch/src/audio/playout/` and `rs/moq-audio/src/playout/`. It was read, cited by file name in each
module header, and reimplemented in `f64`. No source was copied. The constants and the algorithm
shapes are theirs; the fixed point is not carried over, because it exists to target DSPs.

**videocall-rs.** The `neteq` crate there is MIT OR Apache-2.0 and was read as a possible starting
point for the Rust side. Nothing was adapted from it. Its time stretch removes the longest low-energy
run rather than a pitch period, its expand emits quiet noise rather than concealment, and its buffer
level filter adds a jump detector NetEq does not have, so it is not the port it looks like. The
reasoning is in the module header of `50e70f5b8`.

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

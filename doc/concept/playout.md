---
title: Playout
description: How a receiver sizes its audio jitter buffer from arrival timing
---

# Playout

A receiver has to decide how far behind the live edge to play. Too little and
the ring runs dry, which the viewer hears as a click or a gap. Too much and
every word arrives late. This page is the algorithm that decides, written once
so the browser and the native player produce the same number from the same
trace.

It is normative. Both implementations are held to it by one checked-in
conformance corpus, [`rs/moq-audio/tests/playout-01.json`][corpus], rather than
to each other.

The design is WebRTC's NetEq. The algorithm is not in the file its name
suggests: `delay_manager.cc` composes it, and the parts live in
`underrun_optimizer.{h,cc}`, `reorder_optimizer.{h,cc}`, `histogram.{h,cc}`
and `packet_arrival_history.{h,cc}` under `modules/audio_coding/neteq/`. Those
files are BSD-3 plus a patent grant, so this is a reimplementation in `f64`
from the described algorithm, not a port. WebRTC's Q15/Q30 fixed point exists
for 2010-era DSPs; floating point removes a whole class of cross-language
parity bug.

[corpus]: https://github.com/kixelated/moq/blob/main/rs/moq-audio/tests/playout-01.json

## Units

Three quantities, three axes, and every implementation converts to
milliseconds at the door.

| Quantity | Axis | Type on the wire | Inside the estimator |
| --- | --- | --- | --- |
| Frame timestamp | Media | `Time.Micro`, microseconds since the broadcast epoch | `f64` milliseconds |
| Arrival | Wall clock, monotonic | `Time.Milli` | `f64` milliseconds |
| Target | Duration | `Time.Milli` | `f64` milliseconds, always a whole bucket |

The arrival clock only has to be monotonic and local. It is never compared with
the sender's clock: every formula below is a difference of differences, so a
constant offset between the two cancels.

Branded time types are structurally plain numbers in TypeScript, so a media
timestamp and a wall-clock instant type-check against each other. Convert both
to unbranded milliseconds on entry and brand again only when the target is
published. That is the shape of the bug the first attempt shipped.

## The observation point

Measure each frame as the container consumer decodes it out of a group, and
before the age budget can skip that group.

Order matters. The consumer resolves the group against the timeline first (a
reneged straggler is dropped, a rewind re-anchors the baseline), then observes,
then checks the age budget. Observing after the budget would only ever confirm
the budget the stream was cut to: frames the budget threw away are exactly the
late ones the estimate exists to size for.

One arrival time per wire frame. A CMAF frame carries several samples that
reached the receiver together, so sampling the clock per sample spreads one
arrival across the decode loop instead of measuring the network.

Marker frames carry no media and are not observed.

## Relative arrival delay

For a frame `p`:

```
delay(p) = max(0, (arrival(p) - arrival(ref)) - (timestamp(p) - timestamp(ref)))
```

`ref` is the fastest recent arrival: the frame minimising `arrival - timestamp`
over a window of the last 2000 ms **of media**. Keep it in a monotonic deque,
pushing each admitted arrival after popping every entry at least as slow.

The window is on the media axis, matching `PacketArrivalHistory::IsObsolete`:
an arrival leaves the reference when the timeline has moved 2000 ms past its
timestamp, not when the receiver has been running 2000 ms longer. A sender that
stalls therefore cannot age out the only reference it has.

The point of measuring against the best-case path rather than against the
previous frame is that an inter-arrival estimator is structurally blind to a
slow build-up. A hundred frames each 2 ms late read as a hundred tiny
observations. Here they read as a delay climbing to 200 ms, which is what the
buffer actually has to absorb.

## Reordered arrivals are excluded

A frame whose timestamp is not strictly newer than the newest admitted
timestamp is reordered. There are no sequence numbers to unwrap, so the
timestamp is the test.

A reordered frame is excluded from both the reference deque and the histogram.
Its arrival is early relative to its timestamp, so `arrival(p) - arrival(ref)`
is positive while the timestamp difference is negative, and the media-time
distance between the two frames is added straight into the delay. That is the
same failure this whole page exists to prevent, a media-time distance leaking
into a delay measurement, and it arrives through the front door:
`Container.Consumer` takes groups off the wire in delivery order and sorts them
afterwards, so out-of-order observation is ordinary input.

Everything else about the frame is unaffected: it is still published, still
decoded, still played.

Costing reordering explicitly as delay against loss, the way WebRTC's
`ReorderOptimizer` does, is a later step. The target is the underrun estimate
alone until then.

## Max-over-interval resampling

The histogram takes at most one observation per 500 ms: the largest delay seen
in that interval.

```
if (now - intervalStart > 500) {
    add(intervalMax)
    intervalStart = now
    intervalMax = 0
}
intervalMax = max(intervalMax, delay)
```

Three details, in the order they bite:

- The comparison is strict. An interval closes when more than 500 ms has
  elapsed, not at exactly 500 ms.
- The interval restarts at the arrival that closed it, not on a fixed 500 ms
  grid.
- The arrival that closes an interval joins the **new** interval. It is not
  counted in the interval it closed.

This is what makes the forget factor a wall-clock time constant instead of a
per-frame one, and it decorrelates the observations that feed the histogram. A
publisher sending 50 frames a second and one sending 1 frame a second then
converge at the same speed. Applying the forget factor per arrival instead is
the mistake the first attempt shipped, and it reads plausible either way, which
is the kind that survives review.

## The histogram

100 buckets of 20 ms, covering 0 to 2000 ms, holding a normalised probability
per bucket.

**Seed.** `bucket[i] = 0.5^(i+1)`, which sums to 1. The forget factor starts at
zero.

**Add.** Given an observation in milliseconds:

```
index = floor(ms / 20)
if (index >= 100) return       // dropped, not clamped
for each i: bucket[i] *= forget
bucket[index] += 1 - forget
adds += 1
forget = clamp(1 - 2 / (adds + 1), 0, 0.983)
```

The sum stays 1, so there is no correction loop. WebRTC has one only because
Q30 rounding drifts.

**Dropped, not clamped.** An observation of 2500 ms is discarded. WebRTC's
`if (index < histogram_.NumBuckets())` reads like a bounds check and is
behaviour: clamping it into the last bucket instead would let one absurd
arrival pin the target at 2000 ms for the length of the histogram's memory.

**The start ramp.** `forget` is 0 on the first add, so the first observation
replaces the seeded prior outright rather than nudging it. It reaches the
steady-state 0.983 at `adds >= 117`. Without the ramp a cold start crawls for
tens of seconds; `start_forget_weight = 2` is WebRTC's value.

**Memory.** 0.983 per observation and one observation per 500 ms is about
`500 / (1 - 0.983)`, roughly 29 seconds of wall clock. That claim only holds if
an interval with no arrival also decays, which is the next section.

**Quantile.** Walk from bucket 0 subtracting mass until the remaining tail
drops to `1 - 0.95`:

```
sum = 1 - bucket[0]
index = 0
while (sum > 0.05 && index < 99) { index += 1; sum -= bucket[index] }
optimal = (index + 1) * 20
```

The comparison is strict, and bucket 0 is subtracted before the loop rather
than inside it. The result is the bucket's **upper** edge, because the delay
the bucket holds is somewhere inside it and covering the whole bucket is what
covers the quantile.

A quantile of an empirical distribution, rather than a mean plus k deviations,
because network delay is one-sided and heavy-tailed. A Gaussian assumption
sizes that tail wrong in both directions.

## Empty intervals

An interval in which nothing arrived produces no observation, and therefore no
decay step. Left alone, a pause preserves whatever the path looked like before
it, and the 29 second memory above is not true.

So empty intervals decay, lazily, on the next arrival that closes an interval:

```
empty = min(60, floor(elapsed / 500) - 1)
repeat empty times: add(0)
```

They are added after the closed interval's own maximum, which is the order they
happened in.

The cap is 60 intervals, 30 seconds, which is past the histogram's own memory.
A pause longer than that converges to the same near-reset as a pause of exactly
that length, so the cap costs nothing and bounds the work one arrival can do.

A real timer was rejected. A normalised histogram cannot forget without an
observation, so a timer would have to synthesise the same zero observations
this does, and it would make the estimator untestable on a simulated clock and
unportable to a runtime with a different timer surface.

## The target

The quantile's upper edge is what the histogram asks for. The published target
follows it asymmetrically.

**Before any observation**, the target is 80 ms, WebRTC's `kStartDelayMs`. It
is a guess, held only until the first resampled observation lands half a second
in.

**Rise is immediate.** A late frame has already proven the buffer is too
shallow, and every moment spent ramping up costs an underrun the viewer hears.
There is no rise limiter because there does not need to be one: the histogram's
range caps the target at 2000 ms, and a single observation can only move the
quantile by the mass one add carries.

**Fall is one bucket per second**, and multi-step:

```
steps = floor((now - lowered) / 1000)
if (steps > 0) {
    lowered += steps * 1000
    target = max(optimal, target - steps * 20)
}
```

Falling is the opposite case. Nothing is proven by a quiet second, the cost of
being wrong is another underrun, and the viewer notices a buffer that shrinks
faster than this. The multi-step form is what makes a 1 fps track and a 50 fps
track shrink at the same wall-clock rate; stepping once per arrival would tie
the fall to the frame rate.

**No floor.** The estimator never applies one. The rendition's advertised
`jitter` is the publisher's declared flush span, a property of the encoder, and
the target is a measurement of the network. They are different quantities that
share a word. Whoever combines them owns that decision: in `@moq/watch` the
advertised value is the floor and the measured target is the estimate, so auto
delay is `max(advertised, target)` and a fixed delay is `advertised + target`.

## Re-anchoring

A timeline discontinuity moves the media axis underneath the measurement.
`reanchor()` clears the reference deque, the newest timestamp, and the open
interval. It keeps the histogram.

The reasoning is that the histogram holds delays, and a jump in the timeline
does not move a delay. The reference deque holds absolute pairs from a timeline
that no longer exists, and the open interval spans the jump, so both go.

## The "plus one frame" question

The first attempt added a learned frame duration on top of the quantile. It
learned that duration as the running minimum of positive gaps between observed
timestamps, so the first gap set it with nothing to validate against. A tune-in
that saw one frame of a stale group and then the live edge set it to the
distance between them: 14.56 seconds, raised instantly and lowered 20 ms per
second afterwards. The regression is in the corpus as `tune-in-stale`.

The fix is structural rather than a better source for the frame duration. **The
estimator does not add a frame at all.** The quantile already reports the
bucket's upper edge, which is up to 20 ms above the delay actually observed, so
the term it was standing in for is already there.

What the extra frame was really covering is the consumer's own granularity, and
that belongs above the estimator, in the ring that feeds the output device:

- In the browser, the AudioWorklet renders in fixed 128-sample quanta, so the
  ring's skip band is `target + chunk + quantum`. `WORKLET_QUANTUM` is 128
  samples, 2.67 ms at 48 kHz.
- Natively there is no worklet. The equivalent is the **sink period**, the
  number of frames the output device asks for per callback, which `cpal`
  reports per stream. The ring uses that in the same place.

Keeping it there is what lets one corpus hold both languages. A step that
carried the browser's render quantum would produce a different target series
from the same trace on native, and the corpus could not hold.

## Parity traps

The same list, from the Rust side. Each of these reads correct and is not.

- `1 - 2 / (adds + 1)` is `1.0 - 2.0 / ((adds + 1) as f64)`. Integer division
  makes the ramp jump straight to 1.
- No `vector_sum` correction loop. It is a fixed-point artifact.
- Observations at or above 2000 ms are dropped, not clamped into bucket 99.
- The reference window is 2000 ms of **media**, not of wall clock.
- The arrival that closes a resample interval belongs to the next interval.
- Both the resample comparison and the quantile walk use strict `>`.
- The quantile subtracts bucket 0 before the loop, not inside it.
- Empty-interval decay runs after the closed interval's maximum, capped at 60.
- The target starts at 80 ms, not at 0 and not at the first quantile.

## The corpus

[`rs/moq-audio/tests/playout-01.json`][corpus] holds the arrival traces and the
target series each must produce. It lives in `rs/moq-audio` because that is the
crate which has to `include_str!` it and `cargo package` cannot reach outside a
package root, the same reason `rs/moq-json/tests/vectors.json` lives where it
does.

`js/hang/src/container/jitter.vectors.ts` generates it. Run it bare to check
the file is current, or with `--write` to regenerate. `jitter.vectors.test.ts`
does the same check inside the test suite.

Every trace is built procedurally from a seeded PRNG, so a reviewer can read
the shape rather than a wall of numbers. Every `target_ms` is a whole multiple
of 20, so an `f64` difference between V8 and rustc can never break parity.

The schema:

```json
{
  "algorithm": "moq-playout-01",
  "constants": { "bucket_ms": 20, "buckets": 100, "...": "..." },
  "cases": [
    {
      "name": "steady",
      "description": "...",
      "arrivals": [{ "timestamp_us": 0, "arrival_ms": 0 }],
      "target_ms": [80]
    }
  ]
}
```

An arrival may carry `reordered: true` to force the reordered path, or
`reanchor_before: true` to call `reanchor()` first. `target_ms[i]` is the
target after arrival `i`. There is no catalog input: the estimator sees arrival
timing and nothing else.

The cases, and what each one holds:

| Case | What it proves |
| --- | --- |
| `steady` | Paced arrivals converge from 80 ms to 20 ms. |
| `steady-far` | The same series 2000 ms down a slower path gives the same targets. |
| `burst-2` | A publisher flushing 2 frames at once reads as its flush span. |
| `burst-7` | The 7-frame PES packing the public relay serves. |
| `slow-buildup` | A path degrading 2 ms per frame, which an inter-arrival estimator cannot see. |
| `step-change` | A one-off jump in path delay does not become permanent. |
| `reordered` | Out-of-order arrivals move nothing. |
| `tune-in-stale` | A stale frame then the live edge never inflates the target. |
| `pause-10s` | A gap decays the histogram toward a reset. |
| `pause-10min` | The 60-interval catch-up cap. |
| `discontinuity` | `reanchor()` keeps the distribution and drops the reference. |
| `outlier` | A 2500 ms arrival is dropped rather than clamped. |
| `sparse` | 1 frame per second falls at the same wall-clock rate as 50. |

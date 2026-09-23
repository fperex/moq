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

## The receiver's own reading gap

The arrival clock is sampled by the consumer's read loop. When that loop does
not run, the time it spent not running lands in the next arrival it stamps, and
the estimator has no way to tell that from the path being slow.

So, for two consecutive admitted arrivals:

```
idle     = arrival(p) - arrival(prev)
progress = timestamp(p) - timestamp(prev)
if (idle > 500 && idle - progress > 500) {
    // the receiver was not reading; drop the arrival reference
    min.clear()
}
```

The reference goes, the histogram and the newest timestamp stay. The first
frame after the gap becomes the new reference, so the backlog behind it is
measured against the path as the receiver can now see it rather than against a
reference taken before the gap.

Dropping the reference, rather than dropping the one arrival, is the point. A
receiver that stops reading for 1500 ms comes back to a backlog, and it reads
that backlog in a couple of hundred milliseconds. Every frame in it is that
same 1500 ms late against a reference from before the gap, so skipping only the
first would leave the second to set the same interval maximum.

**The media term is what tells the receiver apart from the publisher.** A track
that genuinely sends one frame a second is idle for longer than the resample
interval on every single arrival. Its timeline advances as far as the wall clock
does, so `idle - progress` stays at whatever the path's jitter is. A receiver
that was not reading comes back to media it has to catch up on, so its idle time
exceeds the media it covered by the length of the block. Without the media term
a 1 fps track drops its reference on every arrival and reads every delay it ever
measures as zero; the `sparse` corpus case is the one that catches that.

**The threshold is the resample interval** because that is the unit the
histogram is fed in. A gap shorter than one cannot be the whole of an
observation, and what it can inject into the one it lands in is bounded by its
own length.

**A receiver that can see it was blocked says so, rather than leaving the
spacing to infer it.** `observe` takes a `stalled` input alongside `reordered`,
and an arrival carrying it drops the reference exactly as the rule above does.
It exists because the spacing cannot decide anything under the threshold: a
content process blocked for 400 ms and a publisher flushing every 400 ms produce
the same arrivals, so a lower threshold buys the second one's damage to catch
the first. What separates them is whether this receiver was running, which is
not in the arrival timing at all but is directly observable where the receiver
lives. In the browser `Container.Consumer` watches its own event loop
(`js/hang/src/container/stall.ts`): it hands the loop an ordinary task, a
`MessageChannel` message rather than a timer, and reads back how long the loop
took to get to it, and separately notices a stretch in which no turn of the loop
happened at all. Either one past 100 ms is a block. How late a timer runs
measures neither, because a hidden tab is rationed to one timer a second with
its loop running and its socket read as before, and a loop running flat out
delivers its timers late while answering every read on time. The estimator
itself stays free of timers and of any clock but the one an arrival is stamped
with, which is what lets one corpus hold every language. A receiver with nothing watching it is left
with the spacing rule, which is why that rule stays. The `receiver-stall` and
`receiver-stall-unflagged` corpus cases are the same arrivals with and without
the input.

**A path that stalls and then bursts is indistinguishable from this** and is
therefore also discounted. That is a deliberate false negative. The receiver
cannot tell "nobody handed me anything" from "I was not asking", and the
measurement it would keep is one it took while blind. A path that is genuinely
getting worse shows up as a delay climbing across arrivals the receiver did
read, which this rule does not touch, and the `slow-buildup` case holds that
line.

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
forget = clamp(1 - 2 / (adds + 1), 0, 0.9)
```

The sum stays 1, so there is no correction loop. WebRTC has one only because
Q30 rounding drifts.

**Dropped, not clamped.** An observation of 2500 ms is discarded. WebRTC's
`if (index < histogram_.NumBuckets())` reads like a bounds check and is
behaviour: clamping it into the last bucket instead would let one absurd
arrival pin the target at 2000 ms for the length of the histogram's memory.

**The start ramp.** `forget` is 0 on the first add, so the first observation
replaces the seeded prior outright rather than nudging it. It reaches the
steady-state 0.9 at `adds >= 19`. The ramp lets a cold start replace its prior
without waiting for the steady-state decay; `start_forget_weight = 2` is WebRTC's value.

**Memory.** Each observation retains 90% of the previous distribution. With
one observation per 500 ms, even a distribution made entirely of old delays
falls below the quantile's 5% tail after 29 new observations, about 15 seconds:
`0.9^29 < 0.05`. Repeated high delays continue to contribute fresh mass, so
sustained jitter keeps its buffer. A temporary queue can fade after the path
recovers. The published target then falls at the bounded rate below.

The mean age of the history is not a recovery deadline: a high quantile can
remain elevated after most of its old mass has decayed. Empty intervals must
also decay, as the next section specifies.

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
it, regardless of how much wall-clock time passed.

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

**Before any observation**, the target is the publisher's declared flush span,
rounded up to a whole bucket and never below 80 ms.

The declared span is the best prior a receiver has. It is the same quantity
this estimator goes on to measure, published by the only party that already
knows it, and NetEq guesses 80 ms (`kStartDelayMs`) only because RTP carries
nothing like it. Never below that guess, because the network adds to a flush
span rather than replacing it, and never above the histogram's range, or the
declaration would name a target no observation could bring down.

A receiver that is handed no declaration starts at the 80 ms guess.

The declaration starts a rendition, not a subscription. A receiver that stops
reading and starts again on the same rendition, which is what muting a player
does, carries its estimator across: the target it comes back with is the one it
measured, and only the arrival reference is dropped, the way a discontinuity
drops it. What the path does while nobody is listening is not a reason to
believe the publisher's guess again, and reseeding costs the viewer the
difference as a cold fill on every unmute. NetEq keeps its delay manager across
a pause for the same reason. A rendition whose catalog entry changes is a
different path with a different declaration, and starts over; one that leaves
the catalog and comes back unchanged, which is what hiding a camera or a
microphone does, has not changed and keeps what it measured.

A player that holds several tracks to one delay pays for a reseed twice over,
because it has to hold the widest of them: a track that starts over is a track
whose guess outranks every measurement beside it, so the audio ring is resized in
the middle of playback and runs dry. Measured on the bench, a camera hidden and
shown for 300 ms took the shared delay from 20 ms to the 80 ms guess and cost
three of five watchers an underrun. For the same reason such a player holds a
departed track's last reading for a couple of seconds rather than dropping it
where the track went: a rendition that blinks would otherwise take the delay down
to what the tracks beside it measured and put it straight back, and the ring pays
for the fall and the rise both.

**The first observation replaces it outright**, however far below it that
lands. A seed is a prior, not an observation, and the fall bound below exists
to protect a measurement from the next one; there is no measurement here for it
to protect. NetEq does exactly this:

```
target_level_ms_ = underrun_optimizer_.GetOptimalDelayMs().value_or(kStartDelayMs);
```

`delay_manager.cc`. The start delay is the value used while the optimizer has
none, and the first one it produces takes over whole. There is no fall bound in
NetEq at all.

Walking the seed down instead is what the first version did, and it costs a
viewer the difference for as long as the walk takes: a 310 ms declaration
coming down a sixth a second sits above a 20 ms path for tens of seconds, on
every tune-in, while nothing that was measured asked for any of it. A receiver
holding audio because of a declaration alone is holding it for no reason it can
point at; what playback must never go below is the measured p95 plus the chunk
the ring holds on top of it, which is a measurement, not a declaration.

So the seed is a start: not a floor under the target, and not a brake on how
fast it leaves. From the first resampled observation half a second in, the
target is a measurement, and the two rules below apply between measurements.

**Rise is immediate.** A late frame has already proven the buffer is too
shallow, and every moment spent ramping up costs an underrun the viewer hears.
There is no rise limiter because there does not need to be one: the histogram's
range caps the target at 2000 ms, and a single observation can only move the
quantile by the mass one add carries.

**Fall is once a second**, between two measured values, by a sixth of the
distance left or one bucket, whichever is more, and multi-step:

```
steps = floor((now - lowered) / 1000)
if (steps > 0) {
    lowered += steps * 1000
    repeat steps times, while target > optimal:
        share = floor((target - optimal) / 6 / 20) * 20
        target = max(optimal, target - max(20, share))
}
```

Falling is the opposite case to rising. Nothing is proven by a quiet second and
the cost of being wrong is another underrun, so the target comes down at a
bounded rate instead of following the quantile straight down. The multi-step
form is what makes a 1 fps track and a
50 fps track shrink at the same wall-clock rate; stepping once per arrival would
tie the fall to the frame rate.

**Why a share and not a fixed step.** What the limiter protects is the ring: it
must not hand the playhead a target the network has not refilled up to yet, and
what a ring can refill in a second scales with the buffer it is holding. Twenty
milliseconds out of an 80 ms buffer is a quarter of it; twenty milliseconds out
of a 1600 ms buffer is nothing at all. A fixed step therefore brakes hardest
exactly where the target is furthest from what the histogram asks for, and the
time it takes to undo an overshoot grows with the overshoot: 1600 ms at a bucket
a second is eighty seconds.

**Why a sixth.** Retiring old observations and changing playback depth are
separate steps. The histogram follows the recovered path; the limiter keeps
that reduction gradual while the audio ring catches up. A sixth of the
remaining distance per second drains a large excess faster than a fixed
20 ms step, while a small excess still falls one bucket at a time. The divisor
is exactly 6 so both languages round to the same bucket. The limiter can
outlast the histogram's old tail; the recovery tests cover their combined
effect rather than treating the histogram's mean age as a deadline.

The quantile is a bucket index, so it comes down in handfuls of buckets at a
time as mass leaves the tail, not smoothly. That is the case the fixed step
could not follow.

**No floor.** The estimator never applies one, including to its own start. The
rendition's advertised `jitter` reaches it as the cold-start prior above and
nowhere else, so in `@moq/watch` an auto delay is the target and a fixed delay
is the number the viewer asked for. Carrying the declaration a second time, as a floor
under auto or a term added to a fixed delay, double-counted it: a viewer asking
for 100 ms on a source declaring 300 waited 400, and a LAN viewer measuring
20 ms was pinned at 300 for the length of the session. The one thing that holds
the target up for a while is the player running dry, which is the next section.

## Learning from running dry

The stall rule above has a cost. A receiver whose page freezes for 120 ms every
second and a half reads each freeze's backlog at once, and every frame of it is
flagged `stalled`, so none of them reaches the histogram: the path never delayed
them, and the rule is right to say so. But the ring the target sizes still has
to last through the freeze, and a target of one bucket holds 40 ms. Measured on
the bench, such a page ran dry on every freeze for as long as it ran, and Auto
never left 20 ms. Freezes of 30 and 60 ms were short enough for the ring to
absorb.

Nothing in the arrivals can say the ring is too shallow here. The player can: it
ran dry, and it knows for how long. So the estimator takes one more input,
`starved(gap, now)`, on the arrival clock, and acts on it only when the page
itself caused the run-dry:

```
if (no stalled arrival yet || |now - lastStalled| > 200) return
level   = min(2000, ceil((target + gap) / 20) * 20)
held    = now < holdEnd ? max(held, level) : level
holdEnd = now + HOLD
publish(now)
```

`lastStalled` is when the last arrival flagged `stalled` landed, recorded for
every observation that carries the flag, reordered or not.

`target` is the one published now: the player ran dry holding what it asked for,
so covering the gap takes the two together. A report while a hold runs can only
raise its level, and every report restarts it, so the hold is measured from the
last time the player ran dry rather than the first.

Publishing treats the held level as one more thing the target has to cover, for
as long as the hold lasts:

```
if (now >= holdEnd) drop held
optimal = max(optimal, held)      // the histogram's, when nothing is held
```

and the rest of the target rules run unchanged on that: it rises to the level at
once, and once the hold lets it go it comes down through the same fall limiter,
a bucket a second from where a 20 ms path left it. Before the first measurement
a report still raises the prior, since a run-dry is not a guess, and the first
measurement lands at the held level rather than below it. Nothing else changes:
the stall rule, the reading gap, reordering, re-anchoring (which keeps a running
hold), resampling and the histogram are all as described above.

`HOLD` is 30 s, one constant in each language. It has to outlast the gap between
the freezes that cause a run-dry, or the fall walks the target back into the
next one, and every second past that is latency paid by a receiver that froze
once. A player that keeps running dry keeps restarting it.

**Only the page's own run-dries count.** A run-dry says the player ran out of
audio, not why. Media that is late runs a ring dry too, and the arrivals already
measure it when it lands. Media that is lost runs it dry, and no buffer brings it
back. Raising the target for either buys latency and nothing else, and it
costs more than that: measured on a 20 ms path, learning from every run-dry took
a 200 ms loss to 400 ms of concealment and a 220 ms target held for the whole
hold, a 3 s loss or late delivery to the 2 s ceiling, and on three lost outages
the later ones reached a ring deep enough that the browser's writer zero-filled
them instead of the reader concealing them. What separates the page's own
run-dry is the same signal the stall rule uses: the arrivals read right after a
block are flagged `stalled`, and a report within 200 ms of the last of them is
the page's. The report that counts is the one made once media is back, which
lands one ring read (50 ms at most) after the decoder inserts the backlog those
arrivals opened; the window is four of those, for a page still catching up after
a freeze. A report made before the backlog was read finds no block yet and
changes nothing, which costs nothing, since the one after it counts. Anything
further from a block, a network event or a tune-in, changes nothing at all.

**A caller reports what the target does not already cover.** The level is
measured from the target the estimator finds, so one run-dry reported twice,
once as soon as it is seen and again once its whole length is known, would count
twice. The caller remembers the target it ran dry at and passes
`max(0, ranDryAt + length - target)`. It can then report as often as it likes:
however many reports there are, they add up to one.

**What counts as running dry.** In the browser the ring's counters are read on
the main thread (`js/watch/src/audio/starvation.ts`), which a freeze holds up with
everything else, so the first read after one is the first moment the player can
know. An underrun the reader counted starts a run-dry. Its length is the audio
concealment made up plus the render quanta that went out short where it could
not, which is all of them with concealment off. It is reported at every read
while the ring is still dry, so a read that comes after the backlog was flagged
aims the refill at the raised target, and once more at the read that finds media
back. Not after: what follows is the refill,
whose length the raised target itself sets, so counting it would feed the report
back into itself. The reads a postMessage ring gets queue up behind a freeze and
are handled in order afterwards, and the earliest describe its first
milliseconds, which is why every read reports rather than only the first. A
fresh timeline (a tune-in, a flush, a mute) and a declared endpoint are not
running dry, and the reader counts no underrun for them; a timeline replaced
under a run-dry ends it without another report.

Nothing native reports a run-dry. A native receiver never flags an arrival: the
task that froze is the one that stamps the packets, so its arrivals carry the
freeze to the histogram themselves, and the target rises through them. The
native estimator still implements `starved`, so the corpus holds both languages
to one algorithm.

## Re-anchoring

A timeline discontinuity moves the media axis underneath the measurement.
`reanchor()` clears the reference deque, the newest timestamp, the previous
arrival and the open interval. It keeps the histogram.

The reasoning is that the histogram holds delays, and a jump in the timeline
does not move a delay. The reference deque holds absolute pairs from a timeline
that no longer exists, and the open interval spans the jump, so both go.

A publisher that restarts moves the axis just as far with nothing on the wire to
say so: the same broadcast name comes back as a different broadcast, and its new
encoder starts its timeline where it likes. A receiver that followed the
republish in place, rather than being rebuilt around it, treats the replacement
broadcast as a tune-in and resets the ring and the clock there. A rendition swap
is not one: it reopens a subscription on the timeline already playing.

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
the spread the extra term was standing in for is already there.

The term itself is real, though, and it belongs to the ring rather than to the
estimator. NetEq's target delay counts **the packet being played** as well as
the ones waiting: its buffer level is the `packet_buffer` span plus what the
sync buffer still holds. Ours is the audio still waiting to be played, which is
one chunk less. So the level the ring holds is:

```
hold = target + chunk
```

where `chunk` is the size of the most recent insert, measured rather than
learned. That is the difference from the first attempt: the frame duration is
not derived from timestamp arithmetic that a tune-in artifact can poison, it is
the length of the audio that just arrived, republished on every insert and
forgotten on the next one.

It is one rule in four places, and all four have to move together or the ring
sits at the bottom of its own band:

- The ring un-stalls at `WRITE - READ >= hold`, and a refill after an underrun
  reaches the same level. Un-stalling at the target alone leaves nothing
  unplayed, so the first arrival a millisecond late finds an empty ring,
  re-stalls, refills to empty again, and stutters there for the life of the
  call.
- The buffer level filter's band is `low = hold`, `high = hold + 20 ms`, so a
  ring sitting exactly where it is meant to sit is not read as one that needs
  expanding.
- The skip-ahead band is `hold + STRETCH_BOUND`, and a skip lands back on
  `hold`. The band above the level the ring holds is then exactly what the time
  stretch closes on its own.
- The audio age budget's headroom is `BUCKET + frame + STRETCH_BOUND`, which is
  the same three terms: the bucket the estimator rounded up by, the chunk on top
  of the target, and the stretch band.
- Playout starts at `WRITE - hold` on a timeline nothing has been played from,
  which is the next section.

The hold is bounded by what the ring can physically hold. A chunk wider than the
ring would otherwise name a level no refill could reach; `setLatency` refuses a
target past capacity outright, so the chunk is the term that gives way.

The consumer's own granularity below one chunk stays out of all of it. The
browser's AudioWorklet renders in fixed 128-sample quanta (2.67 ms at 48 kHz)
and a native sink asks for whatever period `cpal` reports; both are inside the
chunk the ring already holds. Keeping them out of the estimator is what lets one
corpus hold both languages: a step that carried the browser's render block would
produce a different target series from the same trace on native.

The reported numbers follow the same split. `Sync.out.delay` stays the
estimator's answer, which is what the player's "jitter buffer" row shows. The configured
media hold is `delay + offset + chunk`, which is what the "total buffer" row
shows; the middle term is the next section and is zero in the ordinary case.
This is a buffering target, not capture-to-speaker or capture-to-display latency.
Capture, encoding, transport and output-device delays also contribute to the
end-to-end delay.

The browser's message-based audio buffer timestamps each playhead sample at the
end of its render quantum. The main thread maps that audio context time through
`AudioContext.getOutputTimestamp()` before using it to pace video. Message
delivery time varies with main-thread load; using it as the playback timestamp
would turn that scheduling jitter into uneven video frame releases.

The renderer can retain two adjacent frames spanning at most 20 ms of media and
paint them on separate display refreshes. Keeping that pair prevents an unpainted
frame from being overwritten between refreshes. Larger backlogs are discarded
so presentation catches up with the playhead.

## Holding the sound for a later picture

Everything above measures one track against itself. Each arrival is compared to
that track's own fastest recent arrival, so a track that is *uniformly* later
than another measures a spread of zero, and nothing the estimator produces can
see the difference between them.

That difference is audible. The watcher paints a frame when the playhead reaches
its timestamp, so a picture that has not arrived by then is painted as soon as
it decodes, which is late. Measured on a browser matrix: a Firefox publisher put
the picture 86 to 109 ms behind the sound at Chromium, Brave and Firefox
watchers, where every Chromium publisher was inside a frame at every watcher.
About 22 ms of that is the engine stamping its two timelines differently (a
capture probe puts Firefox's video 10 ms behind its audio and Chromium's 12 ms
ahead); the rest is the video path simply delivering later.

So there is a second quantity, measured across tracks rather than within one:

```
floor(track)  = min over a window of (arrival - timestamp)
offset        = max(0, floor(video) - floor(audio))
```

A minimum, for the same reason each arrival is measured against the fastest
recent one: the floor is the path, and everything above it is jitter the
estimator already covers. Two rotating windows of 2 s. A picture that stops
arriving drops out of the comparison within two windows instead of holding the
sound deep for the rest of the session; the sound is carried across a pause
instead, because a mute stops the download and not the path, and the floor it
measured a moment ago is still the floor the resubscription lands on. The
estimator carries its own measurement across the same pause for the same reason.
A rewind clears both the way `reanchor()` clears the estimator's reference.
Quantised up to a whole bucket, with anything below one bucket reading zero:
below the estimator's own resolution this is noise, and a term that flickered by
a millisecond would re-park the ring for nothing.

The tolerance is why 45 ms is subtracted before any of that. ITU-R BT.1359 puts
the detectability window at about 45 ms of sound-ahead and 125 ms of
sound-behind, so the hold only has to bring the lead back inside that window,
not to zero. Every millisecond past it is latency bought for something nobody
can see, and a conferencing player prefers the low audio latency when the two
disagree.

It is then capped at 100 ms, which is what a video call tolerates: past that the
hold is worse than the desync it is buying off, since a picture that far behind
is out of sync whatever the sound does. The measured browser publishers needed
55 to 70 ms of it. Measured on an impaired path, an uncapped term reached 2 s
during tune-in, where the video track is still replaying the span between the
last keyframe and the live edge and every arrival honestly looks that late.

It moves one bucket per second, in both directions. The ring reaches a deeper
hold by stretching what it already holds, or by parking when the step is past
the stretch bound, and a shallower one by time-compressing it, so a term that
lands in one step is audible either way, and the term is at its
least trustworthy exactly when it moves most: at tune-in the video floor is set
by the camera's warm-up frames, the slowest that track will ever be, and a hold
derived from them would stand at the ceiling until both windows had rotated past
them. That is the few seconds of held sound a publisher used to hear at the
start of their own broadcast. A bucket per second is slow enough that such a
transient rotates out of the windows before the hold has grown into it.

It is deliberately one-directional. Audio is the clock and video is painted when
the playhead reaches its timestamp, so a picture that arrives *early* is already
held for free and needs no term; only a picture that arrives late does, and the
only way to wait for it is to hold the sound. WebRTC reaches the same place from
the same argument, computing the relative delay between the two streams and
slowing the earlier one
(`modules/video_coding/stream_synchronization.cc`).

The term is published as `Sync.out.offset` and spent in two places, which have
to move together:

- the audio ring holds `delay + offset + chunk`, which is the whole point: the
  sound waits for the picture.
- the age budget reaches back over `delay + offset + buffer`. A budget sized
  without it convicts the very group the deeper hold is waiting for, so the
  picture never arrives and the hold is paid for nothing.

`Sync.out.delay` is untouched by it. The estimator's answer is what the corpus
describes and what both languages are held to, and this is not an estimator
quantity: it is a property of a pair of tracks, and `moq-audio` has only one.

The browser video reader also limits its local age budget to the distance from
its buffered edge to the shared playhead. Once a buffered successor is due, an
incomplete older group must not hold it back for another jitter-buffer interval.
This local limit does not change the subscription's wire budget. Budget changes
wake the container reader even when no more frames arrive, and a video-only gap
does not reset a running audio clock.

## Where playout starts

Until the reader has taken a sample, nothing on the timeline has been heard, so
where the playhead starts is still ours to choose. It starts at the newest audio
less the level the ring holds, not at the oldest sample buffered.

The case this is for is a fresh subscription. A viewer tuning in or unmuting is
served the live edge and the relay then follows it with every group it still has
inside the age budget, whose headroom is a stretch bound wide on purpose, so a
backlog well past the hold is admitted and decodes before the first render
quantum. That burst is landed on the hold by the trim below, never by the age
budget: a group that arrived is never convicted. One the reader has reached
belongs to the reader, which hands over what is still queued there and closes the
group out once it is spent. One it has not reached is walked onto, since what the
budget gave up on is the sequences below that never arrived, and that walk asks
the reader to re-anchor only when the head does not continue the timeline. What
is convicted is what is late in the sense the budget means: a group still
arriving with nothing to hand over. So the skip counter reports media nobody
could take, and at a zero budget a reader that keeps up reports nothing at all. Measured on a self-publish through the local relay, Chromium watcher,
one unmute after a three second mute: the ring started playing 65 ms deep
against a 40 ms hold, and the reader spent 8 accelerates and 50 ms of compressed
speech closing that over the following seconds; five rapid mute and unmute pairs
cost 15 and 144 ms. Starting the playhead 80 ms further in instead, the same two
phases cost 0 accelerates and no compression at all. That is the fast-forward a
listener hears after every unmute, and none of it was audio anyone was waiting
for.

```
while nothing has been played on this timeline:
    excess = buffered - hold
    if (excess >= chunk) {
        READ += excess       // counted as `trimmed`
    }
```

**A whole chunk of slack**, because a fill lands a chunk at a time: a level that
crossed the hold by part of one is the ring sitting where it is meant to sit.
Past that it lands back on the hold exactly, rather than a chunk above it, which
is the threshold the reader accelerates at.

**The first fill only.** Once playout has taken audio, a surplus is on its way to
being heard and the reader's time stretch is what closes it. A publisher's flush
burst in particular inflates the ring and drains again before the next one, which
is the case the level filter's own floor is there to wait out; trimming it would
throw away audio a listener was about to hear. So the trim is armed by a
re-anchor and disarmed by the first sample read.

NetEq reaches its target the same way at the start of a stream, by the position
playout begins at rather than by accelerating into it: `decision_logic.cc` does
not ask for a time stretch before the first packet is played, and
`delay_manager.cc` carries the target rather than a correction.

`trimmed` is its own counter on both transports and in the stats panel, separate
from the reader's `skipped` and the writer's `discarded`: it is the one drop no
listener can hear. The playhead ledger counts it, so every quantum still holds
`READ == output - concealed + stretched + queued + skipped + trimmed`.

The corpus does not cover this. It holds arrival timing and the target series
that follows from it; the ring's level at the start of playback is downstream of
both.

## How fast the ring follows the target

The two directions cost different things, so the ring takes them at different
speeds.

A rise is a cushion the ring has to refill into. `setLatency` alone only raises
the bar a future refill has to clear, so the reader is what takes a playing ring
deeper: it expands, a pitch period per 100 ms of output, or about 150 ms of
extra depth a second, however far away the new target is. That is how the native
engine reaches every deeper hold, and sync survives the walk, since audio is the
clock and the picture is painted when the playhead reaches its timestamp. The
target itself lands at once: holding the bar back only lengthens the window an
underrun is waiting in. The one exception is a delay the viewer set themselves.
Past the reader's stretch bound that is a jump they asked for, so the browser
player parks the playhead once and refills, debounced, rather than bending
seconds of speech to spare them a cut they expect.

A fall is the opposite. The ring cannot un-receive what it already holds, so a
shallower target is reached by time-compressing audio that is on its way to
being heard, one pitch period per 100 ms of output. The player sheds one bucket
per second instead of the whole fall at once. The case this is for is the cold
start of a self-publish: a browser publisher declares no flush span, so the
estimator holds the 80 ms guess until its first measurement, which on a LAN
replaces it with 20 ms. Spent in one step, the reader compressed six periods
inside half a second, which is the fast-forward heard in the first seconds of
one's own broadcast. NetEq lets the buffer drift towards a lower target rather
than stretching straight after a start for the same reason
(`delay_manager.cc`, and the accelerate decision in `decision_logic.cc`).

A fall further than the reader's own stretch bound is not walked. Past that
bound the reader skips ahead instead of stretching, which is one discontinuity
rather than a run of them, and walking a viewer's 2 s delay down to 100 ms would
turn that single jump into a minute of bent audio.

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
- The target starts at the declared flush span rounded up to a whole bucket, or
  at 80 ms when nothing is declared. Not at 0 and not at the first quantile.
- That start is replaced by the first quantile outright, in one step and with no
  bound. Running it through the fall bound instead leaves every unseeded trace
  sitting at 80 ms for three seconds and a seeded one for far longer.
- The reading-gap test needs both terms. Idle time alone throws away every
  observation a track slower than two frames a second makes.
- The reading gap is measured against the previous **admitted** arrival, so a
  reordered frame does not reset it, and `reanchor()` clears it.
- The fall's share is `floor(distance / 6.0 / 20.0) * 20.0`: a division, floored
  to a whole bucket before the maximum with one bucket. Multiplying by an `f64`
  sixth instead can land the floor a bucket lower.
- `Buffer::trim` has no floor under the level it drops to, where `Buffer::flush`
  refuses a threshold below `OVERFULL` times the target. The flush is protecting
  a cushion the reader is already playing out of; the trim is choosing where the
  playhead starts, and there is no cushion yet.
- A run-dry's level is measured from the target as published, and rounded up with
  `ceil`. Rust converts the `Duration` gap to milliseconds as nanoseconds over
  `1e6`, which is exact; `as_secs_f64() * 1000.0` rounds twice and can land a
  hair above a bucket edge the `ceil` then counts as a whole bucket.
- The hold is over at `now >= holdEnd`, not after it, and it is dropped for good
  there: a later report starts from the target, not from the expired level.
- Before the first measurement a held level raises the prior, and the first
  measurement is `max(optimal, held)`, not `optimal`.
- The last stalled arrival is recorded before the reordered check, so a
  reordered frame read out of a block counts, and the window is inclusive: a
  report exactly 200 ms from it counts. A report outside the window returns
  before anything moves, the hold included.

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

A case carrying `start_ms` is replayed from that declared flush span instead of
the 80 ms guess; a case without it is replayed from the guess.

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

An arrival may carry `reordered: true` to force the reordered path,
`stalled: true` to declare that the receiver itself was blocked before it, or
`reanchor_before: true` to call `reanchor()` first. An entry may instead carry
`starved_ms` in place of `timestamp_us`: the player reporting that it ran dry for
that long, with `arrival_ms` the moment the report reached the estimator, which
is replayed as `starved()` rather than `observe()`. A case may carry `start_ms`,
the publisher's declared flush span the estimator starts from. `target_ms[i]` is
the target after entry `i`, `constants.hold_ms` is `HOLD`, and
`constants.stall_window_ms` is the 200 ms window around the last stalled arrival.
The declaration
and the run-dry reports aside, there is no input: the estimator sees arrival
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
| `tune-in-stall` | A receiver whose read loop blocks for 1500 ms does not read its own block as path delay. |
| `pause-10s` | A gap decays the histogram toward a reset. |
| `pause-10min` | The 60-interval catch-up cap. |
| `discontinuity` | `reanchor()` keeps the distribution and drops the reference. |
| `outlier` | A 2500 ms arrival is dropped rather than clamped. |
| `sparse` | 1 frame per second falls at the same wall-clock rate as 50. |
| `receiver-stall` | A 400 ms block the receiver reports, which the spacing rule is too coarse to see. |
| `receiver-stall-unflagged` | The same arrivals unreported, which is what a receiver with no monitor measures. |
| `seeded` | A declared 310 ms flush span starts the target at 320 ms and the first observation replaces it with 20 ms. |
| `run-dry` | A 120 ms page block and an 82 ms run-dry on a 20 ms path take the target to 120 ms at once, hold it for `HOLD`, then it falls a bucket a second. |
| `run-dry-repeated` | Twenty blocks and reports 1.5 s apart keep restarting the hold: the fall starts `HOLD` after the last. |
| `run-dry-below-histogram` | Arrivals asking for more than the held level decide the target on their own. |
| `run-dry-before-measurement` | A block and a report before the first measurement raise the prior, and the first measurement does not land below it. |
| `run-dry-unstalled` | A report with no page block anywhere changes nothing. |
| `run-dry-outside-window` | A report 200 ms after a block counts; one a quarter of a millisecond later changes nothing. |

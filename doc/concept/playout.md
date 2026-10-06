---
title: Playout
description: How the browser's audio ring follows its target, covers a gap, and ends an outage
---

# Playout

[Audio jitter](/concept/audio-jitter) decides how deep the buffer should be. This page is what the
browser player does about it between the network and the speaker: it moves the ring towards that
depth without a click, covers a gap with synthesized audio, and ends an outage in silence.

It describes `@moq/watch`. Nothing here is on the wire, so another player may do something else with
the same target and still be conformant.

The design is WebRTC's NetEq (`modules/audio_coding/neteq` in Chromium), reimplemented from the
described algorithm in `f64` rather than ported: its source is BSD-3 with a patent grant, and ours is
`MIT OR Apache-2.0`.

## The level the ring holds

The ring holds the playout target, and that target already counts the frame being played:
`target = max(measured, advertised) + frame`. So the ring un-stalls at the target, refills to it after
a run dry, and the engine's idea of "the right depth" is the same number. A level aimed anywhere lower
would never ask for an expansion, and one aimed higher would ask for one on every block of a healthy
stream.

The target is `sync.out.delay`. The ring never computes one of its own.

## One decision per block

The worklet's 128 frame render quantum is too small to decide at, so the engine decides every 20 ms
block (`BLOCK`) and queues the result. Each decision is one of:

| Operation | When | What it does |
| --- | --- | --- |
| normal | the level is inside the band, or the stretch is cooling down | plays the media as it stands |
| accelerate | the smoothed level is 20 ms or more above the target | drops one pitch period |
| fast accelerate | the level is four times the accelerate threshold | folds the period with a looser correlation test, and no cooldown |
| expand | the smoothed level is below the target | repeats one pitch period, consuming less media than it emits |
| conceal | the ring is empty or parked, and there is audio to repeat | synthesizes a block from the last real audio |
| merge | media returns after a concealment | splices it onto the concealment |
| silence | nothing to play and nothing to repeat | the caller ramps down to silence |

The level is the ring's depth plus what the engine still holds, run through a one pole filter that is
slower the larger the target is (NetEq's 251 to 254 out of 256), so one late arrival is not a reason to
speed the stream up. A time stretch bypasses the filter: what it just moved is subtracted outright, so
the correction is not counted twice while the filter catches up. A stretch is followed by 100 ms of
output before the next is allowed (`COOLDOWN`).

A fill, a re-stall, or a skip-ahead means the level did not drift to where it is, so the filter adopts
the new depth instead of walking to it.

## Stretching

An accelerate or expand finds the pitch period, then drops or repeats one by crossfading over it,
which is the only length that keeps the waveform continuous. A coarse search over a 4 kHz decimation
picks the lag between 2.5 and 15 ms, and one full rate correlation decides whether the splice is
allowed. Speech has to correlate at 0.9 before it is spliced. A block barely above the room tone is
always spliceable, because nobody can hear it, which is how the engine knows the room: a background
estimate that only moves on a window quieter than everything accepted so far.

One operation moves at most one 15 ms period, and the cooldown lets one run every 100 ms, so the
stretch closes about 150 ms a second. That is the bound the skip band is built on.

## The skip band

A ring above its target is closed by accelerating, up to `STRETCH_BOUND` (75 ms) above it. Past that,
a listener would wait on the catch-up for longer than a jump costs, so the reader skips ahead and lands
back on the target. The band is a fixed number rather than a function of the target: it is a property
of the stretch, not of the stream.

A skip is judged on the trough, not the peak. A publisher that flushes several frames at once puts
all of them in the ring together, so the depth peaks by a whole flush and drains before the next one.
The ring keeps the smallest depth it saw over a window of one target's worth of playback, and only a
trough above the band is a surplus. The peak is what the target was sized to hold.

A hole in the media that the reader has already run dry on is stepped over instead of queued as
silence: the engine concealed the missing audio, and playing the same hole again would make a
listener wait for it twice. The jump is counted as a skip and the engine re-seeds its level.

A deeper target parks the ring until it refills, so a rise costs only its own size in silence and
nothing at all if the buffer already covers it. A shallower one is reached by accelerating.

## Concealment

When the ring has nothing to give, the engine repeats the last 30 ms of real audio. It takes the
signal apart into a pitch period and a noise spectrum and makes each block out of the two: the period
repeated for the voiced part, white noise through a sixth order filter for the unvoiced part, and a mix
between them set by how periodic the signal was. A held vowel is nearly all period, and a fricative
nearly all noise.

Every block is quieter than the last. Once the muting slope has taken the gain to zero, the output is
digital silence, so a stream that never comes back is not a sound. It gives up after 2 seconds of
consecutive blocks. Comfort noise is not played, because nothing on the wire says the publisher is
sending any.

When media returns, the engine finds where it lines up with the concealment, keeps the concealment up
to that point, and crossfades across the join. Media that returns much louder than the concealment
faded to is brought in quietly and let back up over the crossfade.

`conceal="false"` turns this off. A gap is then a ramp into silence and a ramp back out, which is the
boundary the stretch was written to. Read when the audio graph is built.

## What the player reports

The worklet publishes cumulative counters, which `Decoder.out.debug` carries for the stats panel and
the quality harness: accelerates, expands, merges, the frames concealed, the quanta that ended short,
and what the writer or the reader threw away. Every quantum holds one identity, which the tests hold
the engine to:

```
READ == output - concealed + stretched + queued + skipped
```

What the ring handed over is what was played, less the frames that were made up rather than read,
plus what a stretch moved, plus what is still in flight, plus what a skip threw away. The media
playhead the player reports is `READ - queued`.

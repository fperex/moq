# Audio quality

Plays a broadcast in a headless browser over a seeded, impaired UDP path and counts what the
listener would actually have heard: how often the ring ran dry, how much of the run was silent, how
far the playhead jumped, and where the playout delay settled.

```bash
just test audio-quality                                   # the whole matrix, 60s a row
just test audio-quality --list                            # what the matrix would run
just test audio-quality --duration 30 --profiles bursty   # one profile, faster
just test audio-quality --codecs opus --rings plain        # the production path only
just test audio-quality --out ~/runs/after                 # keep the run directory
just test audio-quality --enforce                          # fail on the budgets
just test audio-quality --runtime safari                   # real Safari, local only
just test audio-quality --runtime replay                   # the recorded traces, in a second
just test audio-quality --offload false                    # the audio on the page's main thread
```

The matrix is codec x jitter profile x document isolation: 24 rows, about 30 minutes at the default 60
seconds a row. `--profiles`, `--rings`, and `--codecs` take comma-separated lists; `--seed` replays
a given impairment; `--duration` shortens a row.

`grade.ts` prints the table and exits zero unless `--enforce` is passed, which the nightly job does.
Every value in `budgets.json` is a ceiling measured on the playout engine, and a row with no budget
at all fails under `--enforce` rather than passing quietly.

A replay ceiling is exactly what was measured and is enforced: nothing in that lane can be unlucky.
A Chromium ceiling is the worst of two 60 second runs of the whole matrix times 1.5, and whether it
is enforced depends on whether those two runs agreed. A row whose runs came within that same 1.5 on
every graded metric is enforced. A row where they did not keeps the `recorded` marker, which prints
a breach and calls it out without failing the run: a ceiling wide enough to hold a spread the player
did not cause would say nothing, and a tight one would fail on the weather. The nightly runner is
the machine whose numbers are worth enforcing; take the marker off a row once it has recorded its
own.

Three rows are enforced today:

| Codec | Enforced |
| --- | --- |
| opus | `fixed-250` isolated |
| aac | `fixed-250` both isolation contexts |

Twenty-one keep the marker, and the reason is the target rather than a fault in the measurement: an
`auto` row's target follows the path for the whole window, so where inside sixty seconds the path's
worst stretch lands moves its percentiles between runs. The declared flush span it starts from is
not what the spread is, because the first resampled observation half a second in replaces it
outright. The `fixed-250` rows, whose target never moves, are exactly the ones that still agree.
The two runs behind this file differ by 2.2 against 36 skip-aheads a minute on `aac-step-isolated`
and by 460 against 1700 ms of target p95 on `aac-bursty-isolated`. A third run under `--enforce`
bore the split out: it passed every enforced ceiling and breached only on rows that kept the marker.

A metric one run measured as zero and the other did not counts as a disagreement rather than as
agreement, because the ratio is unbounded and a third run has nothing to be held to. That is strict
on purpose: it means an enforced row is one that played the same way twice.

A ceiling is clamped where the metric itself is bounded. A share cannot exceed 1 and a convergence
time cannot exceed the row's own run, so the worst times 1.5 is capped at those: a ceiling a metric
cannot reach is a check that can never fail, which reads as a cleared bar and is not one.

The counters the engine has to keep at zero (underrun episodes, skip-aheads) are hard
zeros wherever both runs measured zero and carry a measured ceiling where they did not: those are
the work that is left, not a bar that was cleared. A ceiling comes down as that work lands and never
goes up without a reason in review.

The nightly `audio-quality` job runs the Chromium lane and keeps the run directory of a failure for a
week: each process's log, the shaper's counters, the raw ndjson, the per-row summaries, and a
Playwright trace of the page that failed. It is nightly rather than a merge gate because it is half
an hour of real-time playback and every number in it is a timing one, which moves with whatever else
the runner is doing. The `Audio quality` workflow runs the same job for a branch on demand, and runs
the replay lane under `--enforce` on every pull request that touches the player, the estimator, their
native twin, or this harness: that lane takes seconds and cannot be unlucky.

`--runtime` picks which of three lanes runs, and each measures a different thing:

| Runtime | What it is | Shaper | Where |
| --- | --- | --- | --- |
| `chromium` | Headless Chromium over WebTransport, the matrix above | yes | nightly, on demand, and locally |
| `safari` | Real Safari over a WebSocket, the two control profiles | no | locally, on macOS |
| `replay` | The recorded traces through the same player, on a simulated clock | no | pull requests, nightly, and anywhere else, in a second |

The default audio worker uses the message ring in both document isolation contexts. These rows
prove isolation handling, not SharedArrayBuffer playback. The nightly also runs
`--profiles fixed-250 --rings isolated --offload false --enforce` for both codecs. Those rows keep
audio on the page and require the concrete ring's debug snapshot to report `shared`. The default
rows require `message`. Unknown or unexpected implementations void the row.

## How the browser reaches the relay

```text
  page  ──HTTP──▶  web server        the built page, served twice: /isolated and /plain
        ──UDP──▶  moq-shaper  ──▶  moq-relay        the impaired path
        ──TCP──▶  moq-shaper  ──▶  moq-relay        /certificate.sha256, unimpaired
  ffmpeg │ moq  ──────────────────▶  moq-relay      the publisher, on the clean path
  page  ──POST─▶  sink                              one ndjson file per row
```

Every port is reserved for the run rather than fixed (see [the harness contract](../README.md)), so
two checkouts can run this at once. The relay serves QUIC and HTTP on the same port number, and
[`moq-shaper`](../../rs/moq-shaper/README.md) forwards both: UDP through the profile's treatment,
TCP straight through. TCP has to pass through because a browser fetches `/certificate.sha256` before
it opens WebTransport, and shaping a reliable transport would only measure how it retransmits.

The certificate is pinned by hash rather than by hostname, so pointing the page at the shaper's port
instead of the relay's needs nothing else: no second certificate, no name resolution, no TLS
exception. That is the whole reason a userspace shaper is enough here.

Every URL handed to the page is literal `127.0.0.1`, never `localhost`. Chromium resolves `localhost`
to `::1` first and the shaper binds IPv4, so a page pointed at the name either wins the WebSocket
race and grades an unimpaired TCP session, or, with the fallback denied as it is below, never
connects at all. Neither failure announces itself.

The publisher stays on the clean path deliberately. Impairing the ingest too would grade the
receiver on a stream that was already damaged before it was published, and the publisher's own flush
span is a separate stage of the ledger.

### Why the page denies the WebSocket fallback

`@moq/net` gives WebTransport a 500 ms head start and then races a WebSocket against it. Here only
the UDP path is impaired and the TCP passthrough is clean by design, so on any profile that slows
the QUIC handshake past that head start the WebSocket wins: measured on `bursty`, every row fell
back, and the shaper saw seven datagrams for the whole run. That is the race working exactly as
written, and it is also the one outcome this harness must never measure.

So `index.html` removes `WebSocketStream` and `WebSocket` in a classic script before the module
loads. Both names, because qmux prefers `WebSocketStream` where the browser has it: removing one and
not the other looks like it works and changes nothing. With the fallback gone the same `bursty` row
runs on WebTransport, the shaper reports 990 datagrams up and 6267 down, and the resolved target
rises from 100 ms to 440 ms, which is the impairment the row exists to measure.

The player's audio worker dials a session of its own and races only what the page races, so the
same removal keeps the audio's session on QUIC too. The driver checks both: the page's session is
`transport` in the status block, the worker's is inside `thread`.

## The Safari lane

Real Safari, driven through `safaridriver` over plain W3C WebDriver ([`clients/js/webdriver.ts`](clients/js/webdriver.ts),
about 150 lines with no dependencies). Not Playwright's WebKit: that is a build of WebKit with its
own network stack, its own media pipeline and its own AudioWorklet scheduling, so grading it would
say something about WebKit and nothing about what a viewer on macOS hears.

Three things follow from the engine, and each one changes what the lane may claim.

**The session is a WebSocket.** `@moq/net` refuses WebTransport on every WebKit engine, because
WebKit's flow-control window never refills ([webkit-webtransport-gate](../../quest/m0/webkit-webtransport-gate.md)).
So the page keeps its WebSocket for this lane (`?fallback=1`, the one thing the Chromium lane denies
outright) and the row records `transport: websocket`, as does the audio worker's own session. A row
that somehow negotiates anything else on either is void, because these budgets were measured on the
reliable transport.

**The shaper is therefore not in the path.** A WebSocket is TCP, and the shaper passes TCP through
untouched by design. There is no impairment to apply and none to claim, so the lane runs against the
relay directly and its rows record `shaper: none`. It offers only `near-zero` and `fixed-250`, the
two profiles whose path treatment is already nothing; asking for `bursty` here is refused rather than
answered with an unimpaired run under an impaired name.

**Safari has to be frontmost.** With the window unfocused, `document.hasFocus()` is false and both an
Element Click and a WebDriver Actions sequence answer `{"value":null}` while delivering no
`pointerdown` at all. The page's own click counter stays at zero, the AudioContext sits in WebKit's
`interrupted` state, and the row would otherwise record a full minute of plausible counters over
total silence. The driver runs `open -a Safari` (which needs no Automation permission, so nothing
prompts) and clicks until the context reports `running`; if it never does, the row is void on
`activation` or `focus` rather than graded. That is also why the lane is serial, local, and not in
CI: it moves the frontmost application on the desktop, and anything else taking focus mid-run voids
every row after it.

There is no sink either. `safaridriver` is the only channel back to the page, so the driver drains
the probe over `execute/sync` on the same 250 ms grid and writes the same ndjson the beacon would
have posted. `analyze.ts` cannot tell which lane produced a file, which is the point.

`render_load` is null here: `AudioContext.renderCapacity` is Chromium's. `worklet_cadence` stands in
for it, below.

There is no `runtime: "safari"` row in `budgets.json` yet, so `--enforce` reports these rows as
unbudgeted rather than grading them. That is deliberate: a budget wants several runs of each cell,
and this lane's numbers move with whatever else is happening on the desktop it is running on, so one
machine's afternoon is not a bar the lane has to clear. Read the printed table, or `--out` two runs
and `compare.ts` them.

## The replay lane

`--runtime replay` grades the recorded arrival traces in
[`js/watch/src/audio/fixtures`](../../js/watch/src/audio/fixtures): no relay, no shaper, no browser,
no clock. The trace's own arrival times drive a simulated one, and everything above it is the real
thing, from [`js/watch/src/audio/replay.ts`](../../js/watch/src/audio/replay.ts): the same
`Container.Jitter`, the same two rings, the same `Stretcher`. That module is also what
`js/watch/src/audio/replay.test.ts` drives, so the unit suite and this lane cannot drift into
measuring different players.

The whole run takes about a second, and it is deterministic: the same recording, the same
estimator, the same engine, the same numbers every time, on any machine. So its budgets are what was
measured rather than what was measured plus headroom, and the counters that should be zero are
pinned at zero rather than at a comfortable margin.

Each recording is one row's `profile`, because that is what it is: what the path did on the day it
was captured, rather than something a shaper applied. Its codec and rate come from the recording
too. A trace carries no bitstream, but the frame spacing in it is the codec's frame duration, so
`lan-bbb` and `relay-bbb-7frame` are 23.22 ms apart, which is 1024 samples at 44.1 kHz, and
`4k-webm` is 20 ms, which is Opus. `--codecs`, `--duration` and `--seed` are refused here rather
than ignored: the recording decides all three.

| Recording | What it holds |
| --- | --- |
| `lan-bbb` | Big Buck Bunny over a LAN relay: a well paced publisher and local scheduling noise. |
| `relay-bbb-7frame` | The public relay serving `bbb.hang`, in ~160 ms flushes of seven AAC frames. |
| `4k-webm` | A 4K WebM whose audio shares a connection with a video track big enough to queue, holes included. |
| `mic-local` | A browser microphone over a local relay: the shallowest spread a real path produces. |
| `mic-local-mute` | The same microphone, cut by a publisher muting: a declared endpoint and three seconds of silence, derived from `mic-local`. |
| `mic-remote` | The same microphone through the public relay: more delay, the same spread. |
| `mic-firefox` | A Firefox watcher whose own content process froze in bursts while the path stayed clean. |

`mic-firefox` is the one recording whose arrivals are not all the path's. Its receiver stopped
executing for a few hundred milliseconds at a time, so the frames that queued behind each block were
read in one burst and stamped after it. The fixture marks those frames with `stalled`, which is what
the player's own event-loop monitor tells the estimator at runtime, and the estimator discounts them
rather than sizing a buffer for a path that did nothing. The marks come from the recording's debug
sampler, a 250 ms timer on the same main thread, so they cover the blocks that delayed one of its
firings by more than 100 ms and not the shorter ones it could sit between: the row is a lower bound
on what the runtime monitor sees. Without them the same arrivals take the target to 1600 ms.

`mic-local-mute` is the one recording that is derived rather than captured: `mic-local` cut at six
seconds, with an endpoint one frame past the last and the rest re-based three seconds later. An
arrival marked `endpoint` carries no media, so it is neither inserted nor measured; the ring is told
the timeline finished there and plays out what it holds. Nothing in the trace is late, so a reader
that hears the pause as a gap grades it as thrown-away audio.

What it cannot say is anything about the transport, the container consumer, the device, or the wall
clock, because there is no session and no audio hardware. Those metrics report null. What it can say
exactly is what the ring and the engine did. The browser probe reads the same counters through
`audio.out.debug`; replay does not depend on asynchronous reports or device scheduling.

## The metric schema

[`clients/js/src/schema.ts`](clients/js/src/schema.ts) is the contract, not a description of one.
The page emits `Sample`s, the analyzer reduces them to a `Summary`, the grader reads that `Summary`
against `budgets.json`, and `METRICS` says for every graded number what it counts, which clock it
sits on, and how a series became one value. A native lane that emits the same `Summary` is
comparable to this one by construction rather than by agreement.

### Units and clocks

Every duration is milliseconds as a float. Every count is an integer. Every share is a fraction
of 1. A sample count is converted at the rate it was counted at and reported as ms next to the
count.

Four clocks are named: `viewer`, `publisher`, `relay`, `shaper`. Only the viewer's is readable from
a browser page, so the others are reported as unmeasured rather than as zero, with one exception:
the media timeline is the publisher's clock seen through the stream, so its drift against wall time
is measured and reported as `media_drift`. Cross-machine calibration is explicitly not shipped. A
device clock that stops tracking wall time voids the run, which is how a throttled headless browser
gets caught instead of graded: it would otherwise produce a full set of plausible counters and read
as flawless.

### Stages

The stages are exclusive spans, in order: `capture`, `encode`, `publish_flush`, `network`,
`jitter_buffer`, `decode`, `render`, `device`, and the named remainder `unaccounted`. Exclusive is
what makes the sum mean anything, so they are defined by their boundaries rather than by what they
feel like, and the tolerance on the identity is the larger of 2 ms or 2%.

This lane cannot check the full capture-to-speaker identity: `capture`, `encode`, and `network` need
a timestamp from the publisher or the relay, and a browser page shares no clock with either. What it
checks is the receiver's sub-identity, from the live edge to the speaker. `publish_flush` is
reported, because the publisher declares it in the catalog, but it is deliberately not in that sum:
adding a publisher-side span to a receiver-side total is exactly the unaligned-clock arithmetic the
schema exists to prevent. `unaccounted` therefore carries `decode` and `render`, which are real and
unmeasured here rather than absent.

### Counters

A budget key is `<metric>_<aggregation>`, so `underrun_episodes` graded per minute is
`underrun_episodes_per_min`. Naming the aggregation in the key is what keeps "underruns: 3" and
"underruns: 3/min" from being graded against each other. `METRICS` is the full list; the ones whose
definition is a judgement call are:

- **`underruns`** is the ring's own cumulative count of partly-filled quanta. It is authoritative,
  because it sees the gaps that begin and end between two 250 ms samples.

- **`underrun_episodes`** is a maximal run of consecutive samples in which that counter was still
  rising: one audible gap, however many quanta it spanned. Both are reported because forty scattered
  episodes and one long one grade the same by quanta and sound nothing alike.

- **`stalled_quanta`** is the share of the run the ring spent re-stalled, refilling rather than
  playing. Graded separately from underruns: it is silence the player chose.

- **`observed_jumps`** counts forward discontinuities when the reader commits media after playback
  starts. `observed_skipped_samples` measures the media passed over in milliseconds. Both lanes
  publish these comparable observations; startup trimming and timeline resets are excluded.
  They remain informational under the existing budgets.

- **`skip_aheads`** and **`skipped_samples`** use those observations in browser rows. Replay retains
  its original operational definitions: explicit latency or empty-ring skip requests, excluding
  capacity bounds. Its `discarded_samples` counts writer discards from capacity bounds or late
  input. Keeping these operational categories preserves the existing independent replay limits;
  an allowance for writer discards does not permit additional explicit skip requests. No budget
  values or keys changed. These replay fields must not be read as aggregate playback loss.

- **`silence_share`** is the share of sampled windows whose RMS at the graph output was below about
  -60 dBFS. It is the only metric read from the audio itself rather than from a counter: a counter
  says the ring was fed, and only the PCM says the listener heard anything. The film has quiet
  scenes of its own, so the same row reads 0.11 or 0.26 depending on which minute it plays; see
  [the quiet proof](#the-quiet-proof) for how a share over its ceiling can still pass.

- **`converge_s`** is measured backwards from the end of the run, to the last moment the resolved
  target was more than one bucket from its final value. A target that settles and then moves again
  has not converged.

- **`skipped_groups`** is the container consumer's own count of groups abandoned with content still
  unread, read through `audio.out.skipped`. A group the next one already covers is not counted,
  because nothing was lost there. It cannot say why one was abandoned: the local age budget skipping
  a stale group and the transport giving up on a slow one land in the same counter.

- **`worklet_cadence`** is what a hundred render quanta actually cost in wall time, against the
  128/rate they are worth. It exists because `renderCapacity` is Chromium's alone, so a Safari row
  has no `render_load`: `AudioContext.currentTime` advances exactly one quantum per render callback,
  so the quanta between two samples are the context's own advance and the wall time they took is
  the page's. A render thread that kept up spends the nominal; one that hitched spends more. It
  needs the device's rate rather than the stream's, which is why `contextRate` is in the
  environment, and it reports null without one rather than being computed against a guess.

- **`wall_clock_share`** is the share of the graded window in which no track's playhead was driving
  playback, from `sync.out.clock`. A sample from a build without that signal is left out of the
  denominator rather than counted as a zero, so an older build reports `null`.

`short_quanta`, `discarded_samples`, `accelerates`, `expands`, and `stretched_samples` come from
`audio.out.debug`. A build without the counters reports null.

### The quiet proof

The raw `silence_share` and its ceilings are graded exactly as before. A share over its ceiling
passes only when every quiet window it counted lines up with a quiet window of the audio the page
decoded, at the same media time. One quiet window over audible audio, one that cannot be placed, or
a proof counting other windows than the share did, keeps the failure. A row within its ceiling keeps
the verdict it had. The grade prints both: the raw share, and how many quiet windows were placed over
quiet audio.

The reference is rebuilt after the row, in `analyze.ts`, never in the page. It replays the
publisher's own audio encode of the file it loops (`audio_of` in `run.sh`, with `-stream_loop -1`
and without `-re`), which reproduces the published packets byte for byte on the same host, decodes
it with the page's decoder (FFmpeg's AAC, libopus), and mixes it to mono as the AnalyserNode mixes
its input. Against the film itself the codec's level change alone moves a window within a percent of
the floor across it.

A window is placed with what the probe already records ([`src/silence.ts`](clients/js/src/silence.ts)):

- `AudioContext.currentTime`, read with the RMS, ends the window.
- The ring's playhead less its `output` counter, from one report, is the media frame paired with
  each output frame. Only a time stretch moves it while the ring plays, and the reports either side
  bracket it across the window, widened by one maximal stretch for each further stretch between two
  consecutive reports, and for the final window, which has no later report.
- A concealment, underrun, short quantum, skip, jump, discard, trim, stall, new graph, or new
  timeline between those reports refuses the window rather than placing it.

That leaves one constant per row, fitted to the audible windows. Chromium's AnalyserNode can also
fall a whole window behind the context clock partway through a row with nothing else changing, so
each exact audible window votes for the lag, in whole windows, at which it matches the reference,
and the row splits into segments where that lag holds, at most one window apart. Every segment has
to prove its own lag with its own audible windows: 40 of them, a log RMS correlation of 0.999, and a
level within 5%. A quiet window is checked at its segment's proven lag only; one in an unproven
segment, or between two segments where nothing says which lag it had, keeps the failure.

### What the sampling grid can and cannot see

The page samples every 250 ms. Worklet and worker reports arrive asynchronously, so a change
in report age can move the sampled playhead by tens of milliseconds without skipping any audio.
A continuous stream with a 60 ms report delay produces a false skip under timestamp inference.
The analyzer therefore grades the ring's cumulative skip counters and reports media drift separately.

A graph replacement, timeline re-anchor, or counter reset during the measured window voids the
row. Its discontinuity cannot disappear into a counter delta of zero. A build that lacks these
counters reports null instead of an estimated skip count.

### Void rules

A row that cannot be trusted is void, and a void row is reported rather than graded. Marking it
passed would be worse than failing it, so under `--enforce` a void row fails the run.

The thread is not a matrix axis. Every browser row expects the worker, and each summary records the
thread that held at the end as `thread`: the worker with its session's transport, or the main thread
with the page's reason. `--offload false` (Chromium only) runs every row with the audio kept on the
page's main thread instead, so the two can be compared on the same matrix, and those rows expect the
main thread with no reason: a reason is a fallback, meaning the page tried the worker after all.

| Void | Why |
| --- | --- |
| `shaper` | An active profile's `delayed` counter is zero, so the impairment never applied and an impaired run became an unimpaired pass. `near-zero` and `fixed-250` are exempt: zero is the right answer for the control. |
| `transport` | The page's session, or its audio worker's own, negotiated something other than WebTransport. A WebSocket fallback is TCP and never touches the UDP shaper. The page denies the fallback outright (below), for the worker too, so this is a backstop rather than the usual outcome. The Safari lane expects a WebSocket instead. |
| `thread` | The audio did not come from the page's audio worker, the player's default: the page played it on its main thread (the detail says why), or the worker never started. Under `--offload false`, the audio did not stay on the main thread by choice: it played on the worker, or fell back with a reason. Checked once the audio plays and again at the end, since the page takes the audio back for good. A build that predates the worker cannot say, and is not voided for it. |
| `ring` | The document's `crossOriginIsolated` does not match the requested context. |
| `backend` | The concrete ring's debug snapshot is absent or names a different implementation from the requested execution path. |
| `playout` | The graph, timeline anchor, sample rate, or monotonic counters changed during the measured window. |
| `clock` | `AudioContext.currentTime` drifted more than 1% from wall time over the first ten seconds, or was never readable. |
| `window` | No samples survived the warmup. |
| `driver` | The driver threw. A Playwright trace is saved into the run directory. |
| `focus` | Safari lane only: the window was not frontmost, so no click reached the page. |
| `activation` | Safari lane only: the AudioContext never reached `running`, so nothing was rendered. |

## Profiles

Loss, reorder, and rate limiting stay off here. The buffer's job is absorbing arrival spread, and
mixing congestion response into an audio quality number makes a failure hard to attribute. For the
same reason every profile, in `rs/moq-shaper/profiles/`, draws its jitter from the shaper's gaussian
model, which never lets a datagram overtake the one in front, and puts the page's session and its
audio worker's on one shared path, as they are on a real host.

| Profile | What it is |
| --- | --- |
| `near-zero` | The control. The shaper is in the path but treats nothing. |
| `mild` | A healthy wired LAN: 5 ms delay, 5 ms sigma. |
| `bursty` | Seven datagrams per 160 ms window, released together: the flush-span shape from #3477. |
| `step` | 5 ms for thirty seconds, then 60 ms, which forces the target to move mid-run. |
| `high-rtt` | An intercontinental path: 75 ms one way, 30 ms sigma. |
| `fixed-250` | The second control. The path is left alone and the page runs a fixed 250 ms preset instead of adapting. |

`fixed-250` earns its place: every other row exercises adaptation, so without it the whole matrix
can pass while a fixed preset regresses, and a fixed preset is what a viewer lands on today.

The source shape is a third axis that is not a profile. The AAC arm publishes MPEG-TS with ffmpeg's
default PES packing, whose multi-frame bursts are the arrival shape the reporter measured against
the public relay; `demo/pub` passes `-pes_payload_size 0` for the smooth variant. Both publishers pin
`-readrate_catchup 1`, so a publisher that was blocked (a `moq` slow to start, a stall in its import)
resumes at real time instead of running five percent fast until it has made the time up; a fixed
delay would otherwise throw that surplus away as skips that measure the source, not the player.

## Layout

```text
run.sh                      builds, starts everything, runs each row, analyzes, grades
relay.toml                  anonymous relay, self-signed localhost cert
budgets.json                a ceiling per metric per matrix row
clients/js/
  index.html  src/page.ts   the demo's player, driven from the query string
  src/probe.ts              samples the element's public signals every 250ms
  src/beacon.ts             batches to the sink, sendBeacon on pagehide
  src/schema.ts             the metric contract
  src/silence.ts            places each quiet window in the audio the page decoded
  src/*.test.ts             the void rules, the probe, the analyzer, the grader and the quiet proof, under `just test`
  driver.ts                 one row in headless Chromium, and the void checks
  replay.ts                 the recorded traces, with no relay, shaper, or browser
  safari.ts                 one row in real Safari, and the void checks it needs instead
  webdriver.ts              a dependency-free W3C WebDriver client over safaridriver
  sink.ts                   one ndjson file per row
  analyze.ts                ndjson to summary.json and summary.md, with the quiet proof
  grade.ts                  summaries against budgets.json
  compare.ts                a before/after table across two run directories
```

A failing run keeps its directory, with each process's log, the shaper's counters, the raw ndjson,
and a Playwright trace of the failing page. The path and the rerun command are printed.

## Comparing two runs

```bash
just test audio-quality --duration 30 --out ~/runs/before   # on the base
just test audio-quality --duration 30 --out ~/runs/after    # on the branch
bun clients/js/compare.ts --before ~/runs/before --after ~/runs/after
```

## Attribution

The harness this grew from is the reporter's, on their fork `fperex/moq`, branch `debug/rt-audio`:
the beacon sink, the trace analyzer, the black-box probe, and the before/after table were working
there before any of this existed, against 130 raw ndjson traces published as release
`rt-audio-traces-2026-09-06`. `sink.ts`, `compare.ts`, `src/probe.ts`, and `analyze.ts` are adapted
from `debug-findings/analysis/{sink.ts,compare.mjs,blackbox.js,analyze.mjs}` and say so in their
module comments.

What changed in upstreaming: the CDP driver became Playwright, reusing the smoke harness; the
analyzer's event stream came from probes patched into the player, and now comes from the public
signals, which is what lets the same page measure a published build; and the arrival impairment came
from a shell script driving the OS, and now comes from `moq-shaper` with a seed and its own counters.

## Not covered here

iOS: no device, and desktop Safari is the closest proxy this lane has. Video: the stage breakdown is defined generically so video can adopt
it, but nothing here asserts on it. No perceptual scoring: the grade is glitches and latency, not an
opinion about how it sounds.

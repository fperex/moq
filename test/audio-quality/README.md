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
```

The matrix is codec x jitter profile x ring path: 24 rows, about 30 minutes at the default 60
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
| aac | `fixed-250` both rings |

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

The counters the engine has to keep at zero (underrun episodes, skip-aheads, budget aborts) are hard
zeros wherever both runs measured zero and carry a measured ceiling where they did not: those are
the work that is left, not a bar that was cleared. A ceiling comes down as that work lands and never
goes up without a reason in review.

The nightly `audio-quality` job runs the Chromium lane and keeps the run directory of a failure for a
week: each process's log, the shaper's counters, the raw ndjson, the per-row summaries, and a
Playwright trace of the page that failed. It is nightly rather than a merge gate because it is half
an hour of real-time playback and every number in it is a timing one, which moves with whatever else
the runner is doing.

`--runtime` picks which of three lanes runs, and each measures a different thing:

| Runtime | What it is | Shaper | Where |
| --- | --- | --- | --- |
| `chromium` | Headless Chromium over WebTransport, the matrix above | yes | nightly and locally |
| `safari` | Real Safari over a WebSocket, the two control profiles | no | locally, on macOS |
| `replay` | The recorded traces through the same player, on a simulated clock | no | anywhere, in a second |

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

## The Safari lane

Real Safari, driven through `safaridriver` over plain W3C WebDriver ([`clients/js/webdriver.ts`](clients/js/webdriver.ts),
about 150 lines with no dependencies). Not Playwright's WebKit: that is a build of WebKit with its
own network stack, its own media pipeline and its own AudioWorklet scheduling, so grading it would
say something about WebKit and nothing about what a viewer on macOS hears.

Three things follow from the engine, and each one changes what the lane may claim.

**The session is a WebSocket.** `@moq/net` refuses WebTransport on every WebKit engine, because
WebKit's flow-control window never refills ([webkit-webtransport-gate](../../quest/m0/webkit-webtransport-gate.md)).
So the page keeps its WebSocket for this lane (`?fallback=1`, the one thing the Chromium lane denies
outright) and the row records `transport: websocket`. A row that somehow negotiates anything else is
void, because these budgets were measured on the reliable transport.

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

What it cannot say is anything about the transport, the container consumer, the device, or the wall
clock, because there is no session and no audio hardware. Those metrics report null. What it can say
exactly, and the browser lanes cannot, is what the ring and the engine did: `short_quanta`,
`discarded_samples`, `accelerates`, `expands` and `stretched_samples` are read straight off the
counters rather than inferred from a 250 ms sampling grid.

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

- **`skip_aheads`** is a step in the lag between wall time and the playhead, not a single large
  advance. See "What the sampling grid can and cannot see" below.

- **`silence_share`** is the share of sampled windows whose RMS at the graph output was below about
  -60 dBFS. It is the only metric read from the audio itself rather than from a counter: a counter
  says the ring was fed, and only the PCM says the listener heard anything.

- **`converge_s`** is measured backwards from the end of the run, to the last moment the resolved
  target was more than one bucket from its final value. A target that settles and then moves again
  has not converged.

- **`skipped_groups`** is the container consumer's own count of groups abandoned with content still
  unread, read through `audio.out.skipped`. A group the next one already covers is not counted,
  because nothing was lost there. It cannot say why one was abandoned: the local age budget skipping
  a stale group and the transport giving up on a slow one land in the same counter, which is why
  `budget_aborts` stays null rather than being read off this.

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

`short_quanta`, `silent_quanta`, `discarded_samples`, `accelerates`, `expands`,
`stretched_samples`, and `budget_aborts` are in the schema and report `null` in the browser lanes:
the signals they need are not on the element's public surface yet. They are null rather than zero,
and the summary says which change would fill each one in. The replay lane reads five of them
straight off the ring, because there is no page between the counter and the summary.

### What the sampling grid can and cannot see

The page samples every 250 ms, and the playhead it reads is quantized: it moves when the ring
reports a new position, not continuously. Measured on a clean local path, consecutive samples show
the playhead advancing anywhere from 240 to 296 ms with no net drift.

Two derivations have to survive that, and both were wrong before they were measured:

- A rule that calls a single sample's excess advance a skip reports about forty skips a minute on a
  run with none. A skip-ahead is therefore a step in the de-trended lag, judged on the median of the
  four samples either side of it, and has to exceed 40 ms: more than the quantization band, and more
  than one estimator bucket plus a render quantum.
- The lag also drifts when the media timeline does not advance at wall rate, which is a property of
  the source or the publisher rather than of the player. It is fitted by least squares and removed
  before skips are counted, and reported on its own as `media_drift`.

### Void rules

A row that cannot be trusted is void, and a void row is reported rather than graded. Marking it
passed would be worse than failing it, so under `--enforce` a void row fails the run.

| Void | Why |
| --- | --- |
| `shaper` | An active profile's `delayed` counter is zero, so the impairment never applied and an impaired run became an unimpaired pass. `near-zero` and `fixed-250` are exempt: zero is the right answer for the control. |
| `transport` | The session negotiated something other than WebTransport. A WebSocket fallback is TCP and never touches the UDP shaper. The page denies the fallback outright (below), so this is a backstop rather than the usual outcome. |
| `ring` | The document's `crossOriginIsolated` does not match the ring the row asked for, so the other ring ran. |
| `clock` | `AudioContext.currentTime` drifted more than 1% from wall time over the first ten seconds, or was never readable. |
| `window` | No samples survived the warmup. |
| `driver` | The driver threw. A Playwright trace is saved into the run directory. |
| `focus` | Safari lane only: the window was not frontmost, so no click reached the page. |
| `activation` | Safari lane only: the AudioContext never reached `running`, so nothing was rendered. |

## Profiles

Loss, reorder, and rate limiting stay off here. The buffer's job is absorbing arrival spread, and
mixing congestion response into an audio quality number makes a failure hard to attribute.

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
the public relay; `demo/pub` passes `-pes_payload_size 0` for the smooth variant.

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
  driver.ts                 one row in headless Chromium, and the void checks
  replay.ts                 the recorded traces, with no relay, shaper, or browser
  safari.ts                 one row in real Safari, and the void checks it needs instead
  webdriver.ts              a dependency-free W3C WebDriver client over safaridriver
  sink.ts                   one ndjson file per row
  analyze.ts                ndjson to summary.json and summary.md
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

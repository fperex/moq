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
```

The matrix is codec x jitter profile x ring path: 24 rows, about 30 minutes at the default 60
seconds a row. `--profiles`, `--rings`, and `--codecs` take comma-separated lists; `--seed` replays
a given impairment; `--duration` shortens a row.

**Budgets are recorded, not enforced.** `budgets.json` holds what this machine measured, not what the
player is required to achieve, and `grade.ts` prints the table and exits zero unless `--enforce` is
passed. Enforcement, the Safari lane, the replay lane, and the nightly job are the second half of
this quest.

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

## The metric schema

[`clients/js/src/schema.ts`](clients/js/src/schema.ts) is the contract, not a description of one.
The page emits `Sample`s, the analyzer reduces them to a `Summary`, the grader reads that `Summary`
against `budgets.json`, and `METRICS` says for every graded number what it counts, which clock it
sits on, and how a series became one value. A native lane that emits the same `Summary` is
comparable to this one by construction rather than by agreement.

### Units and clocks

Every duration is milliseconds as a float. Every count is an integer. Every share is a fraction of
1. A sample count is converted at the rate it was counted at and reported as ms next to the count.

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

`short_quanta`, `silent_quanta`, `discarded_samples`, `accelerates`, `expands`,
`stretched_samples`, `skipped_groups`, and `budget_aborts` are in the schema and report `null`: the
signals they need do not exist on the player yet. They are null rather than zero, and the summary
says which change would fill each one in.

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
passed would be worse than failing it.

| Void | Why |
| --- | --- |
| `shaper` | An active profile's `delayed` counter is zero, so the impairment never applied and an impaired run became an unimpaired pass. `near-zero` and `fixed-250` are exempt: zero is the right answer for the control. |
| `transport` | The session negotiated something other than WebTransport. A WebSocket fallback is TCP and never touches the UDP shaper. The page denies the fallback outright (below), so this is a backstop rather than the usual outcome. |
| `ring` | The document's `crossOriginIsolated` does not match the ring the row asked for, so the other ring ran. |
| `clock` | `AudioContext.currentTime` drifted more than 1% from wall time over the first ten seconds, or was never readable. |
| `window` | No samples survived the warmup. |
| `driver` | The driver threw. A Playwright trace is saved into the run directory. |

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

Safari, the replay lane over the recorded traces, enforced budgets, and the nightly job. Video: the
stage breakdown is defined generically so video can adopt it, but nothing here asserts on it. No
perceptual scoring: the grade is glitches and latency, not an opinion about how it sounds.

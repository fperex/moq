# Handoff: moq realtime audio stutter (NetEq-shaped playout), 2026-09-16

Handoff for whoever continues this branch. A private, fuller copy with machine-local paths stays on
the author's machine. Plan of record: the private session plan (stages, decisions, reuse inventory).
Memory: the private session memory (user decisions, acceptance targets, browser coverage, delivery
shape).

## Where the work is

- Branch `debug-findings-solution`, tip `5484970e1`, 81 commits on `upstream/dev` `877a561d8`
  (rebased off `8f41d4d82`). Pushed to the fork `fperex/moq`; draft PR
  https://github.com/fperex/moq/pull/3 (base `dev`, draft, fork only). NEVER open a PR on
  moq-dev/moq; the maintainer gets an issue comment on #2812 only after the user listens and says go.
- Report for the maintainer: `debug-findings/REPORT.md` and `debug-findings/issue-comment.md` on the
  branch (tracked with `git add -f`; the folder is locally excluded).
- Archived WIP: branch `debug-findings-solution-wip-20260912`, pushed too.

## What the branch contains (one commit per maintainer quest slice)

Estimator spec `doc/concept/playout.md` plus the 17-case corpus `rs/moq-audio/tests/playout-01.json`
(JS and Rust agree exactly); #3517 prior art; watch wiring; typed `Expired` budget verdict and
`Container.Consumer.skipped`; audio headroom (droppable); demo tiles default to auto; `rs/moq-shaper`
(FIFO jitter, per-direction seeds); native NetEq DSP, engine and the `moq play --delay` floor; the
audio playhead clock (`Sync.track()`, `Clock`); the tune-in fix (reading-gap rule, proportional
fall); ring `view/peek/commit`; time stretch; concealment (`<moq-watch conceal>`, default on, silence
past the ceiling); publisher mute declares an endpoint; hold one chunk above the target (the mic
fix); catalog jitter seeds the target and the first measurement replaces it (NetEq `kStartDelayMs`
semantics); decoder hole restart and `Anchor` (the DataError fix); the harness `test/audio-quality`
(Chromium, Safari and replay lanes, the nightly job, the budgets); five re-landed narrow fixes;
cross-browser results and the Safari catalog retraction.

## What landed this session

- `8cabb3507` the harness relay admits anonymous sessions under upstream's `moq-auth` lease
  (`public = ""` no longer grants anything; it needs `"**"`).
- `8700f1fcc` a flushed ring reports no playhead until it is re-anchored. This is the unmute A/V
  transient that Firefox and WebKit both showed.
- `b86b03c94` the audio unlock is armed on the first gesture, so one click plays on real Safari.
- `a8cbc93bb`, `97c7afb76`, `b85e57431`, `02f3f143a`, `f5087814b`: the CodeRabbit pass over the whole
  branch, per top-level directory because the branch is past the 150-file cap. 22 findings, 18 fixed,
  4 rejected.
- `d5886766f` the estimator is told when the receiver itself was blocked, and `a8fe99aeb` the
  recorded Firefox window replayed and graded. That is finding 12 in the report: Firefox's underruns
  after convergence are its own content process stalling, not the path.
- `ce2e13112` the budgets re-recorded; `5484970e1` the nightly job also runs the replay lane;
  `3dcea2ab4` remark's formatting; `ec6d9761a`, `85583de68`, `3c9388e56` the delivery docs.

## Measured state

- Safari one-click unlock: 6 of 6 gesture-first runs and 4 of 4 muted-tile runs reach `running` with
  rendered output growing, across real Safari 26, Chromium and Firefox, on a headset at 44100 Hz that
  matches neither broadcast rate. Building the context inside the gesture handler was measured and
  rejected: 0 of 2 at 16 kHz.
- The unmute transient: `sync.replay.test.ts` takes the reported sequence over the fallback transport
  from 2992 ms of A/V skew to 37 ms. Firefox and WebKit have not been re-measured on a served build.
- Firefox side by side with Chromium on the same broadcast, same relay, same moment, two rounds of
  120 s: round 1 Firefox target p50/max 40/780 ms, level p50/p95/min 70.9/751.7/0 ms, 1 underrun
  after 20 s, 1240 ms concealed, A/V skew p50/p95 20.1/39.4 ms, worst reading gap 499 ms; round 1
  Chromium 40/40, 68/81.3/41.3, 0, 0, 21.7/41.6, 46 ms; round 2 Firefox 40/40, 67.8/81.2/47.3, 0, 0,
  18.4/38, 32 ms; round 2 Chromium 40/40, 71/84.8/44.1, 0, 0, 20/40, 14 ms.
- The Chromium matrix at the tip: 24 rows, 36 enforced checks, 0 enforced breaches, 17 breaches on
  `recorded` rows, 1 void on a recorded row (`opus-near-zero-isolated`, `AudioContext.currentTime`
  drifting 4.92 percent from wall clock over 10 s).
- The replay lane at the tip: 12 rows, 148 enforced checks, 0 void.
- Public relay `cdn.moq.pro` `bbb.hang` on the production path: 36 underruns per 120 s before,
  1 after; target 200 ms, held 223 ms, the 23 ms being the AAC chunk.

## What is left, in order

1. **Bench and listening round.** Relay on 4443 with `demo/relay/localhost.toml`. Two publishers:
   `bbb-smooth.hang` through the `ffmpeg-ts` recipe with `-pes_payload_size 0`, and a bursty
   `bbb.hang` through the same recipe without it. Pages on 4400 (plain, the production postMessage
   path), 4401 (cross-origin isolated, the shared ring) and 4402 (the copied moq.dev site). Then a
   quiet re-measure, with nothing else loading the machine, of the nine page rows and the microphone
   pair in Chromium, Firefox and real Safari, plus the mute-sequence after numbers that the report
   still has to name as unmeasured.
2. **The listening verdict from the user.** Nothing has been heard on this tip.
3. **Fill the final tip into `debug-findings/issue-comment.md` and post it on #2812**, on the user's
   go and not before.
4. **Open judgement items**, none of which block the above: `aac-high-rtt-isolated` converging in
   42.7 s against an 11.6 s ceiling, which is outside ordinary run-to-run spread and is unexplained;
   the cluster of hard-zero recorded ceilings breached by a single episode, which is a recording
   artefact of a zero measured on a quiet run rather than a regression; the clock-drift void on
   `opus-near-zero-isolated`; `test/audio-quality/clients/js` having no unit test target, which is
   why six fail-quietly defects there were found by a reviewer rather than by a test; the `wasm32`
   debug artifacts; and the `demo/web` tile arming residual, which measured fine.

## Findings for the maintainer already written up

Publisher-declared catalog jitter inflated local buffers (300 ms floors from the TS importer);
`demo/web` pinned 100 ms; buffer-control mousedown leaves auto; `js/net` races a WebSocket against
WebTransport and hides an impaired UDP path (and `localhost` resolves IPv6-first while the shaper is
IPv4); `rs/moq-relay/tests/drills.rs` does not compile and CI runs zero drill tests; a dead publisher
stays announced for the 30 s idle timeout; the public `bbb` publisher should use `-pes_payload_size
0`; the shaper reordered under jitter, and seeded both directions alike (both fixed); the estimator
believed a blocked receiver (fixed); upstream's lease model changed what an empty `auth.public`
means.

## Rules that held all session

Model routing (the planner plans, the implementer implements, the network agent fetches); no em
dashes; never edit `CLAUDE.md` or a quest; cite WebRTC by file and never copy; no `neteq` crate;
every commit ends with the two trailer lines; verify an agent's claims rather than repeat them; keep
asking the user to listen; Firefox and Safari matter as much as Chrome; one heavy command at a time;
never open a PR upstream, and post on #2812 only on the user's go. Acceptance targets for auto:
jitter 20 to 100 ms, held total under 150 ms on the LAN and 200 ms through the public relay, A/V
within a frame, zero underruns after convergence.

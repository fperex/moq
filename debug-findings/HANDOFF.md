# Handoff: moq realtime audio stutter (NetEq-shaped playout), 2026-09-13

Handoff for whoever continues this branch. A private, fuller copy with machine-local paths stays on the author's machine. Plan of record: the private session plan (stages, decisions, reuse inventory). Memory: the private session memory (user decisions, acceptance targets, browser coverage, delivery shape).

## Where the work is

- Branch `debug-findings-solution`, tip `591ceb5f7`, 68 commits on `upstream/dev` `8f41d4d82`. Pushed to the fork `fperex/moq`; draft PR https://github.com/fperex/moq/pull/3 (base `dev`, draft, fork only). NEVER open a PR on moq-dev/moq; the maintainer gets an issue comment on #2812 only after the user listens and says go.
- Archived WIP: branch `debug-findings-solution-wip-20260912` (8de4af59d), pushed too.
- Report for the maintainer: `debug-findings/REPORT.md` and `debug-findings/issue-comment.md` on the branch (tracked with `git add -f`; the folder is locally excluded).
- Local dev branch == fork dev == `ebd954b35` (contains upstream/dev 49a3fd857 plus the WIP and sync merges). upstream/dev has since moved to `8f41d4d82` and the work branch is rebased onto that.

## What the branch contains (one commit per maintainer quest slice)

Estimator spec `doc/concept/playout.md` + 15-case corpus `rs/moq-audio/tests/playout-01.json` (JS and Rust agree exactly); #3517 prior art; watch wiring; typed `Expired` budget verdict + `Container.Consumer.skipped`; audio headroom (droppable); demo tiles default to auto; `rs/moq-shaper` (FIFO jitter); native NetEq DSP + engine + `moq play --delay` floor; audio playhead clock (`Sync.track()`, `Clock`); tune-in fix (reading-gap rule, proportional fall); ring `view/peek/commit`; time stretch; concealment (`<moq-watch conceal>`, default on, silence past the ceiling); publisher mute declares an endpoint; hold one chunk above the target (mic fix); catalog jitter seeds the target, first measurement replaces it (NetEq `kStartDelayMs` semantics); decoder hole restart + Anchor (DataError fix); harness `test/audio-quality` (Chromium, Safari, replay lanes, nightly job, budgets); five re-landed narrow fixes; cross-browser results and the Safari catalog retraction.

## Measured state (auto mode)

- Public relay cdn.moq.pro bbb.hang, production path: 36 underruns/120 s before, 1 after; target 200 ms, held 223 ms (23 ms over the 200 ms target because of the 23 ms AAC chunk).
- Local bbb-smooth: 40 to 60 ms held, 0 underruns. Local bursty bbb.hang: 160 to 180 ms (publisher lump size), 0 underruns after convergence.
- Real microphone, browser publisher, LAN: 20 to 40 ms target, 40 to 60 ms held, 0 underruns, A/V within a frame (Chromium, WebKit, real Safari); Firefox 3 underruns/70 s (60 ms concealed), not diagnosed.
- Toggle sequence (mute/unmute/presets): Chromium worst skew 50 ms (fixed); Firefox/WebKit still show a ~3 s skew spike for under a second right after unmute (open, see below).
- Harness budgets re-recorded on the final tree (`b7d14df0e`); enforce exit 0; check the enforced/recorded split in `test/audio-quality/budgets.json` and README.

## Interrupted at the user's request (resume here)

1. Final gates on `591ceb5f7` were cut off at `just check upstream/dev`. Still to run under nix (`/nix/var/nix/profiles/default/bin/nix --extra-experimental-features 'nix-command flakes' develop --accept-flake-config --command <cmd>`, one at a time, `CARGO_BUILD_JOBS=4`): `just check upstream/dev`, `just check-all`, `just test all`, `just test smoke-full`, `just drafts check`, `just test audio-quality --runtime replay --enforce`, CodeRabbit whole-branch (`~/.local/bin/coderabbit review --base upstream/dev --agent`), privacy grep. Then update the gate table and commit count (68) in the two report files (they still say 65/66 in places) and push.
2. Unfinished fix in worktree `.claude/worktrees/agent-a53131ac08d8e0f7d`, branch `worktree-agent-a53131ac08d8e0f7d`, WIP commit `98ce31944` on `60b194dd9`: (a) flushed ring must not report its old playhead (the Firefox/WebKit unmute spike); (b) arm the Safari audio unlock before the catalog arrives. The agent's last words: "Defect B's arming fix does not deliver one click on real Safari; I have the measurement." Both need finishing, tests, gates, CodeRabbit, then cherry-pick onto the branch.
3. Firefox underruns after convergence on the mic (3/70 s): not diagnosed.
4. Local bursty rows showed underruns in the last page smoke while two agents loaded the machine; re-measure quietly, counting after convergence.
5. Listening verdict from the user is still outstanding; then the #2812 comment (text in `debug-findings/issue-comment.md`, replace the commit count and tip) on the user's go.

## Findings for the maintainer already written up

Publisher-declared catalog jitter inflated local buffers (300 ms floors from the TS importer); `demo/web` pinned 100 ms; buffer-control mousedown leaves auto; js/net WebSocket race hides an impaired UDP path (and `localhost` resolves IPv6-first, the shaper is IPv4); `rs/moq-relay/tests/drills.rs` does not compile and CI runs zero drill tests (impaired-lane patch saved in the scratchpad); a dead publisher stays announced for the 30 s idle timeout; the public bbb publisher should use `-pes_payload_size 0`; the shaper reordered under jitter (fixed).

## Machine state

- Everything was stopped at the stop point: no relay, no publishers, no servers, no browsers, no shapers, no agents. To bring the bench back: `just relay` (or the demo recipe) on 4443, then the two publishers per `demo/pub/justfile` (`bbb-smooth` = `-pes_payload_size 0`; `bbb` bursty = ffmpeg's default PES packing), then the page builds.
- Listening pages are DOWN at the stop point (4400/4401/4402 were stopped by an agent's cleanup). Rebuild from the branch tip before the next listening round using the recipe in `.../scratchpad/final2/` (serve.ts, spawn.py, README): 4400 production path (publish.html + watch.html), 4401 shared ring, 4402 copied moq.dev site (`http://127.0.0.1:4402/watch/?project=demo&name=bbb.hang&relay=https%3A%2F%2Fcdn.moq.pro`).
- Scratchpad dir holds every run, probe script, CodeRabbit log and README; agent worktrees under `.claude/worktrees/` hold the per-stage branches (their `target/` dirs may be deleted freely; the QA worktree `debug-findings/verification` is on `debug-findings-qa`).
- Chrome extension for claude-in-chrome was not connected; real-browser checks used Playwright and safaridriver.

## Rules that held all session

Model routing (Fable plans, Opus implements, Sonnet does network); no em dashes; never edit CLAUDE.md or quests; cite WebRTC by file, never copy; no `neteq` crate; every commit ends with the two trailer lines; verify agents' claims yourself; keep asking the user to listen; Firefox and Safari matter as much as Chrome; acceptance targets for auto: jitter 20 to 100 ms, held total under 150 ms LAN / 200 ms public, A/V within a frame, zero underruns after convergence.

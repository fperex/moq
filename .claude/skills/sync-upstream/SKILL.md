---
name: sync-upstream
description: Sync the current MoQ working branch with upstream changes and validate the integration. Use for requests to sync or update the fork from upstream.
---

Run from the intended worktree. Inspect its branch, status, remotes, and PR base first. Preserve any work in progress with focused commits before syncing; do not stash, reset, or change another worktree.

The shared command is available to any harness with a shell:

```bash
bash .agents/commands/sync-upstream
```

It defaults to `upstream main`. Supply another configured remote and branch only when the task requires it. The command fetches, records a backup ref, and prepares a merge without committing or pushing. Repeating it after the merge is committed does nothing until upstream advances. A pending merge must be completed or aborted before another sync.

Resolve conflicts by understanding both sides, including the fork's behavioral fixes and upstream API migrations. Review the entire staged diff, run affected regression tests and the repository's `just check` and `just test` in Nix, and report any incomplete checks. Do not mix builds with live media measurements. Keep before/after measurements on the same upstream base.

Commit the reviewed merge with a conventional subject and your own `Co-Authored-By` trailer. Report the old and new upstream commits, conflict resolutions, validation, and public API or wire impact. Only push or update a PR when the current user request authorizes it, using the requested fork and target branch.

This skill is shared through the repository's `.agents/skills` symlink to `.claude/skills`. Claude Code can invoke `/sync-upstream`; other harnesses can load this skill or run the shell command directly.

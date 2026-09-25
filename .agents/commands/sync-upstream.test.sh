#!/usr/bin/env bash
set -euo pipefail

command_path="$(cd "$(dirname "$0")" && pwd)/sync-upstream"
fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' EXIT
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME='Sync test' GIT_AUTHOR_EMAIL='sync@example.invalid'
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME" GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"
git init -q -b main "$fixture/upstream"
cd "$fixture/upstream"
echo initial >shared
git add shared
git commit -qm initial
git clone -q . "$fixture/work"
cd "$fixture/work"
git remote rename origin upstream
git switch -qc fork
echo fork >local
git add local
git commit -qm fork
before=$(git rev-parse HEAD)
cd "$fixture/upstream"
echo incoming >incoming
git add incoming
git commit -qm incoming
incoming=$(git rev-parse HEAD)
cd "$fixture/work"

echo dirty >untracked
if bash "$command_path"; then
    echo 'Accepted dirty worktree' >&2
    exit 1
fi
[[ $(git rev-parse HEAD) == "$before" && -f untracked ]]
rm untracked
bash "$command_path"
[[ $(git rev-parse HEAD) == "$before" ]]
[[ $(git rev-parse MERGE_HEAD) == "$incoming" ]]
[[ $(cat local) == fork && $(cat incoming) == incoming ]]
[[ $(git for-each-ref --format='%(objectname)' refs/backups/sync) == "$before" ]]
if bash "$command_path"; then
    echo 'Accepted pending merge' >&2
    exit 1
fi
git commit -qm 'merge upstream'
merged=$(git rev-parse HEAD)
bash "$command_path"
[[ $(git rev-parse HEAD) == "$merged" ]]
git merge-base --is-ancestor "$incoming" HEAD

echo fork >shared
git add shared
git commit -qm 'fork conflict'
before=$(git rev-parse HEAD)
cd "$fixture/upstream"
echo upstream >shared
git add shared
git commit -qm 'upstream conflict'
cd "$fixture/work"
if bash "$command_path"; then
    echo 'Accepted conflicting merge' >&2
    exit 1
fi
[[ -n $(git ls-files -u) ]]
git merge --abort
[[ $(git rev-parse HEAD) == "$before" && $(cat shared) == fork ]]
[[ -z $(git status --porcelain) ]]
git switch -q --detach
if bash "$command_path"; then
    echo 'Accepted detached HEAD' >&2
    exit 1
fi
echo 'Sync command tests passed.'

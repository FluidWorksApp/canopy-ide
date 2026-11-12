#!/usr/bin/env bash
# =============================================================================
# Cut a release — the PR-protected way.
# =============================================================================
# `main` is protected, so a release goes through a PR, and the release TAG must
# land on `main` AFTER the merge — a tag made on the release branch is orphaned
# the moment the PR is squash-merged (the SHA it points at never enters main's
# history, so the built .dmg wouldn't match what shipped). And the version must
# live on `main`, not on some feature branch — bumping while checked out on a
# feature branch is exactly how v0.2.2 ended up tagged off to the side, invisible
# on main.
#
# So this is two phases:
#
#   1) Bump, off a fresh branch cut from main, and push it for review:
#        ./scripts/bump-version.sh 0.2.3
#      -> merge the PR it prints (squash or merge — either is fine now).
#
#   2) Tag main once the PR has merged, which is what cuts the release:
#        ./scripts/bump-version.sh --tag 0.2.3
#      -> pushing the tag triggers CI (release.yml on `v*`), which builds macOS
#         and Linux and creates a DRAFT release. Review it (download the .dmg,
#         check the asset list), then Publish. Publishing is the moment installed
#         copies start auto-updating.
#
# The version is duplicated across package.json, src-tauri/Cargo.toml,
# src-tauri/tauri.conf.json and crates/canopy-term-app/Cargo.toml (plus the
# lockfiles); phase 1 keeps them in sync and asserts they agree before
# committing, and phase 2 asserts them again before tagging. canopy-term-app is
# bundled in the app, and its `--version` must be the release it shipped in.
# =============================================================================
set -euo pipefail

cd "$(dirname "$0")/.."

# ---- args ----------------------------------------------------------------
MODE="bump"
if [ "${1:-}" = "--tag" ]; then
  MODE="tag"
  shift
fi
V="${1:-}"
if ! [[ "$V" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "usage:" >&2
  echo "  $0 X.Y.Z          phase 1: branch off main, bump, push for a PR" >&2
  echo "  $0 --tag X.Y.Z    phase 2: tag main after the PR merged (cuts the release)" >&2
  exit 1
fi

# The terminal app is its own workspace with its own lock, whose entry for the
# crate itself carries the version too (`cargo build --locked` rejects a lock
# that disagrees with the manifest).
TERM_APP_MANIFEST="crates/canopy-term-app/Cargo.toml"
TERM_APP_LOCK="crates/canopy-term-app/Cargo.lock"

term_app_lock_version() {
  perl -0ne 'if (/\[\[package\]\]\nname = "canopy-term-app"\nversion = "([^"]+)"/) { print $1 }' "$TERM_APP_LOCK"
}

# Every file must read $V. Used as a gate in both phases. Names what disagrees.
file_versions_agree() {
  local ok=0 label got
  while IFS='|' read -r label got; do
    if [ "$got" != "$V" ]; then
      echo "  $label is '$got', expected $V" >&2
      ok=1
    fi
  done <<VERSIONS
package.json|$(node -p 'require("./package.json").version')
src-tauri/tauri.conf.json|$(node -p 'require("./src-tauri/tauri.conf.json").version')
src-tauri/Cargo.toml|$(perl -ne 'if (/^version = "([^"]+)"/) { print $1; exit }' src-tauri/Cargo.toml)
$TERM_APP_MANIFEST|$(perl -ne 'if (/^version = "([^"]+)"/) { print $1; exit }' "$TERM_APP_MANIFEST")
$TERM_APP_LOCK|$(term_app_lock_version)
VERSIONS
  return $ok
}

tag_exists() {
  git rev-parse -q --verify "refs/tags/v$V" >/dev/null 2>&1 && return 0
  git ls-remote --tags origin "refs/tags/v$V" 2>/dev/null | grep -q . && return 0
  return 1
}

# ---- worktree resolution -------------------------------------------------
# `main` can only be checked out in ONE worktree at a time. If this script is
# run from a different worktree (e.g. an agent-workspace on a feature branch),
# `git checkout main` below would fail with:
#   fatal: 'main' is already used by worktree at <path>
# So find the worktree that currently holds `main` and run the release there.
# If `main` isn't checked out anywhere, we stay put and check it out ourselves.
main_worktree() {
  git worktree list --porcelain | awk '
    /^worktree /{wt=substr($0, 10)}
    /^branch refs\/heads\/main$/{print wt; exit}
  '
}
MAIN_WT="$(main_worktree)"
CUR_WT="$(git rev-parse --show-toplevel)"
if [ -n "$MAIN_WT" ] && [ "$MAIN_WT" != "$CUR_WT" ]; then
  echo "note: 'main' is checked out at $MAIN_WT" >&2
  echo "      (you launched this from $CUR_WT) — running the release there." >&2
  cd "$MAIN_WT"
fi

git fetch --quiet origin

# =============================================================================
# Phase 2: tag main after the release PR has merged.
# =============================================================================
if [ "$MODE" = "tag" ]; then
  if tag_exists; then
    echo "tag v$V already exists (locally or on origin) — nothing to do" >&2
    exit 1
  fi
  git checkout --quiet main
  git pull --quiet --ff-only origin main
  if ! file_versions_agree; then
    echo "main is not at $V yet — the release PR hasn't merged." >&2
    echo "main package.json is $(node -p 'require("./package.json").version')." >&2
    echo "Merge the release/v$V PR first, then re-run: $0 --tag $V" >&2
    exit 1
  fi
  git tag "v$V"
  git push origin "v$V"
  echo
  echo "Tagged v$V on main and pushed it. CI is now building a DRAFT release."
  echo "Review it in the Releases tab (download the .dmg, check assets), then Publish."
  echo "Publishing is the moment installed copies start auto-updating."
  exit 0
fi

# =============================================================================
# Phase 1: branch off main, bump the version, push for review.
# =============================================================================
if [ -n "$(git status --porcelain)" ]; then
  echo "working tree not clean — commit or stash first, so the release" >&2
  echo "branch contains nothing but the version bump." >&2
  exit 1
fi
if tag_exists; then
  echo "tag v$V already exists (locally or on origin)" >&2
  exit 1
fi

BRANCH="release/v$V"
if git rev-parse -q --verify "refs/heads/$BRANCH" >/dev/null 2>&1 \
  || git ls-remote --heads origin "$BRANCH" 2>/dev/null | grep -q .; then
  echo "branch $BRANCH already exists — delete it or pick another version" >&2
  exit 1
fi

# Always release from an up-to-date main — never from a feature branch.
git checkout --quiet main
git pull --quiet --ff-only origin main
git checkout --quiet -b "$BRANCH"

# package.json + package-lock.json
npm version "$V" --no-git-tag-version >/dev/null

# Cargo.toml: only the [package] version — the first `version = "…"` line.
perl -pi -e 'BEGIN{$done=0} $done ||= s/^version = "[^"]+"/version = "'"$V"'"/' \
  src-tauri/Cargo.toml

# The terminal app: its manifest, and its own entry in its own lock. Edited
# directly (no cargo, no network); the entry is found by name so a dependency
# that happens to share the old version is never touched.
perl -pi -e 'BEGIN{$done=0} $done ||= s/^version = "[^"]+"/version = "'"$V"'"/' \
  "$TERM_APP_MANIFEST"
perl -0pi -e 's/(\[\[package\]\]\nname = "canopy-term-app"\nversion = ")[^"]+(")/${1}'"$V"'${2}/' \
  "$TERM_APP_LOCK"

# tauri.conf.json, preserving the 2-space formatting.
node -e '
  const fs = require("fs");
  const p = "src-tauri/tauri.conf.json";
  const c = JSON.parse(fs.readFileSync(p, "utf8"));
  c.version = process.argv[1];
  fs.writeFileSync(p, JSON.stringify(c, null, 2) + "\n");
' "$V"

# Cargo.lock records the workspace version too. cargo silently rewrites it on
# the next build anyway, but syncing it here keeps the release commit complete.
(cd src-tauri && (cargo update -w --offline >/dev/null 2>&1 || cargo update -w >/dev/null))

# Belt and braces: assert every version file now agrees before committing.
if ! file_versions_agree; then
  echo "version mismatch after bump — aborting before commit" >&2
  git checkout --quiet main
  git branch -D "$BRANCH" >/dev/null 2>&1 || true
  exit 1
fi

git add -A
git commit --quiet -m "Release v$V"
git push --quiet -u origin "$BRANCH"

# Open the PR right here — a pushed branch with no PR is a dead end that always
# needed a manual follow-up. Best-effort: if `gh` is missing or unauthenticated
# we still succeeded (the branch is pushed), so print the manual step instead of
# failing the release.
PR_URL=""
if command -v gh >/dev/null 2>&1; then
  PR_URL=$(gh pr create --base main --head "$BRANCH" \
    --title "Release v$V" \
    --body "Version bump to v$V — the branch contains nothing but the bump. Merge this, then cut the release with: ./scripts/bump-version.sh --tag $V" \
    2>/dev/null) || PR_URL=""
fi

echo
if [ -n "$PR_URL" ]; then
  echo "Pushed $BRANCH and opened its PR: $PR_URL"
  echo "Next:"
  echo "  1. Merge that PR."
  echo "  2. Then cut the release:  ./scripts/bump-version.sh --tag $V"
else
  echo "Pushed $BRANCH (version bumped to $V). Next:"
  echo "  1. Open a PR $BRANCH -> main and merge it"
  echo "     (gh not found or not authenticated — do it in the web UI)."
  echo "  2. Then cut the release:  ./scripts/bump-version.sh --tag $V"
fi
echo
echo "Step 2 tags main AFTER the merge, so the tag lands on the real commit"
echo "and CI builds the draft release from it."

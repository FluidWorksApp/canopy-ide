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
# The version is duplicated across package.json, src-tauri/Cargo.toml and
# src-tauri/tauri.conf.json (plus the lockfiles); phase 1 keeps them in sync and
# asserts they agree before committing.
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

# All three files must read $V. Used as a gate in both phases.
file_versions_agree() {
  for f in \
    "$(node -p 'require("./package.json").version')" \
    "$(node -p 'require("./src-tauri/tauri.conf.json").version')" \
    "$(perl -ne 'if (/^version = "([^"]+)"/) { print $1; exit }' src-tauri/Cargo.toml)"; do
    [ "$f" = "$V" ] || return 1
  done
  return 0
}

tag_exists() {
  git rev-parse -q --verify "refs/tags/v$V" >/dev/null 2>&1 && return 0
  git ls-remote --tags origin "refs/tags/v$V" 2>/dev/null | grep -q . && return 0
  return 1
}

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

# Belt and braces: assert all three files now agree before committing.
if ! file_versions_agree; then
  echo "version mismatch after bump — aborting before commit" >&2
  git checkout --quiet main
  git branch -D "$BRANCH" >/dev/null 2>&1 || true
  exit 1
fi

git add -A
git commit --quiet -m "Release v$V"
git push --quiet -u origin "$BRANCH"

echo
echo "Pushed $BRANCH (version bumped to $V). Next:"
echo "  1. Open a PR $BRANCH -> main and merge it."
echo "  2. Then cut the release:  ./scripts/bump-version.sh --tag $V"
echo
echo "Step 2 tags main AFTER the merge, so the tag lands on the real commit"
echo "and CI builds the draft release from it."

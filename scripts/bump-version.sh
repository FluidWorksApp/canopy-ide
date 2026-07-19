#!/usr/bin/env bash
# =============================================================================
# Bump the app version everywhere it lives, commit, and tag.
# =============================================================================
# The version is duplicated across three files that MUST agree — package.json,
# src-tauri/Cargo.toml, and src-tauri/tauri.conf.json — and the release tag
# must match them (the release name and .dmg filenames come from the config
# version, not the tag). Keeping four things in sync by hand is exactly the
# kind of chore that drifts; this script makes it one command:
#
#   ./scripts/bump-version.sh 0.2.0
#   git push && git push --tags        # <- this is what actually cuts the release
#
# CI builds on the tag push and creates a DRAFT release. Review the draft
# (download the .dmg, check the asset list), then publish it. Publishing is the
# moment installed copies start auto-updating to it.
# =============================================================================
set -euo pipefail

V="${1:-}"
if ! [[ "$V" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "usage: $0 X.Y.Z   (plain semver, no leading v)" >&2
  exit 1
fi

cd "$(dirname "$0")/.."

if [ -n "$(git status --porcelain)" ]; then
  echo "working tree not clean — commit or stash first, so the release" >&2
  echo "commit contains nothing but the version bump" >&2
  exit 1
fi
if git rev-parse -q --verify "refs/tags/v$V" >/dev/null; then
  echo "tag v$V already exists" >&2
  exit 1
fi

# package.json + package-lock.json. --allow-same-version: for a first release
# the files are usually already stamped with the target version, and the only
# missing piece is the tag — without the flag npm hard-errors on "no change".
npm version "$V" --no-git-tag-version --allow-same-version >/dev/null

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
for f in \
  "$(node -p 'require("./package.json").version')" \
  "$(node -p 'require("./src-tauri/tauri.conf.json").version')" \
  "$(perl -ne 'if (/^version = "([^"]+)"/) { print $1; exit }' src-tauri/Cargo.toml)"; do
  if [ "$f" != "$V" ]; then
    echo "version mismatch after bump ($f != $V) — aborting before commit" >&2
    exit 1
  fi
done

git add -A
if git diff --cached --quiet; then
  echo "files already at $V — nothing to commit; tagging the current HEAD"
else
  git commit -m "Release v$V"
fi
git tag "v$V"

echo
echo "Committed and tagged v$V. To cut the release:"
echo "  git push && git push --tags"

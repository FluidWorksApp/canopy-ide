#!/usr/bin/env bash
# Vendors the two network inputs of libghostty-vt-sys for CI: the Ghostty source
# tree and the Zig package cache. All pins are in pins.env next to this file.
#
#   vendor.sh prepare   check Cargo.lock against the pins, compute the cache dir
#                       and key (needs `zig` on PATH), write step outputs
#   vendor.sh ensure    make $VENDOR_DIR complete and verified: after a cache hit
#                       (CACHE_HIT=true) verify it, otherwise fetch (3 attempts,
#                       backoff) and verify; writes the `fetched` output
#   vendor.sh export    export GHOSTTY_SOURCE_DIR / GHOSTTY_ZIG_SYSTEM_DIR to
#                       later steps through $GITHUB_ENV
#
# RECOMPUTE=1 with `ensure` prints the checksums in pins.env format instead of
# failing on a mismatch (used to bump the pins).
#
# Runs under Git Bash on windows-2022, so: POSIX tools only, no GNU-only flags.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=pins.env
. "$HERE/pins.env"

OUT="${GITHUB_OUTPUT:-/dev/null}"
GENV="${GITHUB_ENV:-/dev/null}"
TMPBASE="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
VENDOR_DIR="${VENDOR_DIR:-$TMPBASE/ghostty-vendor}"
SRC_DIR="$VENDOR_DIR/ghostty-src"
ZIG_DIR="$VENDOR_DIR/zig-p"
RECOMPUTE="${RECOMPUTE:-0}"
MISMATCH=0

if command -v sha256sum >/dev/null 2>&1; then SHA256="sha256sum"; else SHA256="shasum -a 256"; fi

sha_stdin() { $SHA256 | cut -d' ' -f1; }

# Sorted per-file manifest of a directory, hashed. Content only (no modes, no
# mtimes, symlinks skipped), so it is the same on every OS.
manifest_sha() {
  ( cd "$1" && find . -type f | LC_ALL=C sort | tr '\n' '\0' | xargs -0 $SHA256 ) | sha_stdin
}

# retry <attempts> <command...>: backoff 10 s, then 30 s between attempts.
retry() {
  attempts=$1; shift
  n=1
  while :; do
    if "$@"; then return 0; fi
    if [ "$n" -ge "$attempts" ]; then
      echo "::error title=Ghostty vendor fetch failed::'$*' failed $attempts times in a row (network?)." >&2
      return 1
    fi
    delay=$(( n * 20 - 10 ))
    echo "::warning::attempt $n/$attempts of '$1' failed, retrying in ${delay}s"
    sleep "$delay"
    n=$(( n + 1 ))
  done
}

# check_eq <pins.env name> <expected> <got> <what>
check_eq() {
  if [ "$2" = "$3" ]; then
    echo "ok: $4 sha256 $3"
    return 0
  fi
  MISMATCH=1
  echo "::error title=Ghostty vendor checksum mismatch::$4: expected $2, got $3. If libghostty-vt-sys was bumped on purpose, set $1=$3 in .github/actions/ghostty-vendor/pins.env (and re-check the other pins with RECOMPUTE=1). If not, the upstream content changed or a cache entry is corrupt: do NOT ignore it; bump CACHE_VERSION in pins.env only after you have looked at why." >&2
  echo "$1=$3"
}

finish_checks() {
  if [ "$MISMATCH" = 1 ] && [ "$RECOMPUTE" != 1 ]; then
    exit 1
  fi
}

cmd_prepare() {
  # Cargo.lock drift guard: every lock that has the -sys crate must match the pin.
  bad=0
  found=0
  for lock in $(find . \( -name node_modules -o -name target -o -name .git \) -prune -o -name Cargo.lock -print); do
    v=$(awk '/^name = "libghostty-vt-sys"$/ { getline; gsub(/version = |"/, ""); print; exit }' "$lock")
    [ -n "$v" ] || continue
    found=$(( found + 1 ))
    if [ "$v" != "$SYS_CRATE_VERSION" ]; then
      echo "::error title=Ghostty pin out of date::$lock locks libghostty-vt-sys $v but .github/actions/ghostty-vendor/pins.env pins $SYS_CRATE_VERSION (ghostty ${GHOSTTY_COMMIT}). With GHOSTTY_SOURCE_DIR set the crate would build the pinned source, not its own. Bump the pins (see the header of pins.env)." >&2
      bad=1
    fi
  done
  [ "$bad" = 0 ] || exit 1
  echo "libghostty-vt-sys $SYS_CRATE_VERSION locked in $found Cargo.lock file(s), matches pins.env"

  zigv=$(zig version)
  dir="$VENDOR_DIR"
  if command -v cygpath >/dev/null 2>&1; then dir=$(cygpath -m "$dir"); fi
  key="ghostty-vendor-${RUNNER_OS:-local}-${RUNNER_ARCH:-local}-${GHOSTTY_COMMIT}-zig${zigv}-v${CACHE_VERSION}"
  echo "zig $zigv, cache key $key, dir $dir"
  { echo "key=$key"; echo "dir=$dir"; } >> "$OUT"
}

verify_src() {
  [ -f "$SRC_DIR/build.zig" ] || { echo "::error::$SRC_DIR has no build.zig" >&2; MISMATCH=1; return; }
  check_eq GHOSTTY_SRC_MANIFEST_SHA256 "$GHOSTTY_SRC_MANIFEST_SHA256" "$(manifest_sha "$SRC_DIR")" "ghostty source tree manifest"
}

verify_zig() {
  [ -d "$ZIG_DIR" ] || { echo "::error::$ZIG_DIR missing" >&2; MISMATCH=1; return; }
  echo "zig package dirs: $(ls "$ZIG_DIR" | wc -l | tr -d ' '), files: $(find "$ZIG_DIR" -type f | wc -l | tr -d ' ')"
  check_eq GHOSTTY_ZIG_MANIFEST_SHA256 "$GHOSTTY_ZIG_MANIFEST_SHA256" "$(manifest_sha "$ZIG_DIR")" "zig package cache manifest"
}

fetch_src_attempt() {
  rm -rf "$SRC_DIR"
  mkdir -p "$SRC_DIR"
  export GIT_TERMINAL_PROMPT=0
  git -C "$SRC_DIR" init -q
  # Byte-exact checkout on every OS (Windows runners default to CRLF).
  git -C "$SRC_DIR" config core.autocrlf false
  git -C "$SRC_DIR" config core.eol lf
  git -C "$SRC_DIR" remote add origin "$GHOSTTY_REPO"
  git -C "$SRC_DIR" fetch -q --depth 1 origin "$GHOSTTY_COMMIT"
  git -C "$SRC_DIR" checkout -q FETCH_HEAD
}

fetch_zig_attempt() {
  g="$TMPBASE/ghostty-zig-global"
  rm -rf "$g" "$TMPBASE/ghostty-zig-local" "$ZIG_DIR"
  mkdir -p "$g"
  ( cd "$SRC_DIR" && zig build --fetch=all --global-cache-dir "$g" --cache-dir "$TMPBASE/ghostty-zig-local" )
  [ -d "$g/p" ] || { echo "zig did not produce $g/p" >&2; return 1; }
  mv "$g/p" "$ZIG_DIR"
  rm -rf "$g" "$TMPBASE/ghostty-zig-local"
}

cmd_ensure() {
  if [ "${CACHE_HIT:-}" = "true" ]; then
    echo "Cache hit: verifying the restored copy"
    verify_src
    verify_zig
    finish_checks
    echo "fetched=false" >> "$OUT"
    return 0
  fi

  echo "Cache miss: fetching from the network (3 attempts each)"
  rm -rf "$VENDOR_DIR"
  mkdir -p "$VENDOR_DIR"

  retry 3 fetch_src_attempt
  head=$(git -C "$SRC_DIR" rev-parse HEAD)
  if [ "$head" != "$GHOSTTY_COMMIT" ]; then
    echo "::error title=Ghostty vendor commit mismatch::fetched HEAD $head, pinned $GHOSTTY_COMMIT" >&2
    exit 1
  fi
  archive=$(git -C "$SRC_DIR" archive --format=tar HEAD | sha_stdin)
  check_eq GHOSTTY_SRC_ARCHIVE_SHA256 "$GHOSTTY_SRC_ARCHIVE_SHA256" "$archive" "ghostty git-archive tar"
  rm -rf "$SRC_DIR/.git"
  rm -f "$SRC_DIR/CLAUDE.md"
  verify_src
  # A wrong source tree would make the Zig fetch meaningless; stop here.
  finish_checks

  retry 3 fetch_zig_attempt
  verify_zig
  finish_checks

  echo "sizes: ghostty-src $(du -sk "$SRC_DIR" | cut -f1) KiB, zig-p $(du -sk "$ZIG_DIR" | cut -f1) KiB"
  echo "fetched=true" >> "$OUT"
}

cmd_export() {
  src="$SRC_DIR"; zig="$ZIG_DIR"
  # cargo and zig are native Windows programs: give them drive-letter paths.
  if command -v cygpath >/dev/null 2>&1; then src=$(cygpath -m "$src"); zig=$(cygpath -m "$zig"); fi
  { echo "GHOSTTY_SOURCE_DIR=$src"; echo "GHOSTTY_ZIG_SYSTEM_DIR=$zig"; } >> "$GENV"
  echo "GHOSTTY_SOURCE_DIR=$src"
  echo "GHOSTTY_ZIG_SYSTEM_DIR=$zig"
}

case "${1:-}" in
  prepare) cmd_prepare ;;
  ensure) cmd_ensure ;;
  export) cmd_export ;;
  *) echo "usage: vendor.sh prepare|ensure|export" >&2; exit 2 ;;
esac

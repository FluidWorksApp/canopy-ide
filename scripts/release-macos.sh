#!/bin/bash
# =============================================================================
# Canopy — signed + notarised macOS build, from this machine.
# =============================================================================
# Produces a DMG that opens on other people's Macs without Gatekeeper blocking
# it, plus the signed .app.tar.gz + .sig the in-app updater consumes.
#
# Prerequisites (all already set up on Sam's machine — see supertype/scripts):
#   1. Apple Developer Program membership
#   2. "Developer ID Application" certificate in the keychain
#   3. Notary credentials stored once:
#        xcrun notarytool store-credentials "AC_PASSWORD" \
#          --apple-id <your-apple-id> --team-id 5Y96U6L594 --password <app-specific>
#   4. The updater signing key at ~/.tauri/canopy.key
#
# Notarisation uses the keychain profile rather than raw env credentials, so no
# Apple password is needed in the environment or in this repo.
#
# Usage: ./scripts/release-macos.sh [aarch64|x86_64|both]
# =============================================================================
set -euo pipefail

TEAM_ID="5Y96U6L594"
SIGNING_IDENTITY="Developer ID Application: Ravichandran Raman (${TEAM_ID})"
NOTARIZE_PROFILE="AC_PASSWORD"

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

ARCH="${1:-aarch64}"
case "$ARCH" in
  aarch64) TARGETS=("aarch64-apple-darwin") ;;
  x86_64)  TARGETS=("x86_64-apple-darwin") ;;
  # arm64 first so its ONNX staging can't leak into the Intel bundle.
  both)    TARGETS=("aarch64-apple-darwin" "x86_64-apple-darwin") ;;
  *) echo "usage: $0 [aarch64|x86_64|both]" >&2; exit 2 ;;
esac

# --- preflight: fail here, with a clear reason, rather than 10 minutes in -----
if ! security find-identity -v -p codesigning | grep -q "$SIGNING_IDENTITY"; then
  echo "error: signing identity not in keychain: $SIGNING_IDENTITY" >&2
  exit 1
fi
if [ ! -f "$HOME/.tauri/canopy.key" ]; then
  echo "error: updater signing key missing at ~/.tauri/canopy.key" >&2
  echo "       without it the build emits no .sig and installed copies" >&2
  echo "       will refuse the update." >&2
  exit 1
fi
# Apple returns 403 here when a Developer Program agreement is unsigned or has
# expired — an account-level problem that no amount of rebuilding fixes, so
# catch it before spending a full release build on it.
if ! xcrun notarytool history --keychain-profile "$NOTARIZE_PROFILE" >/dev/null 2>&1; then
  echo "error: notary credentials unusable for profile '$NOTARIZE_PROFILE'." >&2
  echo "       Common cause: an unsigned/expired agreement — check" >&2
  echo "       https://appstoreconnect.apple.com -> Business/Agreements." >&2
  echo "       Full error:" >&2
  xcrun notarytool history --keychain-profile "$NOTARIZE_PROFILE" 2>&1 | sed 's/^/         /' >&2
  exit 1
fi

# Tauri signs the bundle itself (hardened runtime + entitlements.plist) when
# these are set, so we don't hand-roll codesign over most nested binaries — the
# ONNX Runtime dylib is the one exception (re-signed just below).
export APPLE_SIGNING_IDENTITY="$SIGNING_IDENTITY"
export APPLE_TEAM_ID="$TEAM_ID"
# The key generated with `signer generate --ci` has an empty password, and tauri
# still tries to prompt for one — which dies with "Device not configured" on any
# non-TTY. Setting it empty is what keeps signing non-interactive.
export TAURI_SIGNING_PRIVATE_KEY="$(cat "$HOME/.tauri/canopy.key")"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"

# ONNX Runtime for dictation (arm64 only). Microsoft ships the macOS dylib
# ad-hoc-signed since v1.24 (1.23 was Developer ID + timestamped), and tauri
# does not re-sign bundle resources — an ad-hoc nested binary fails
# notarisation. Stage the official build (if absent) and re-sign it with our
# Developer ID + hardened runtime + secure timestamp, mirroring release.yml.
# The Intel build compiles dictation out (--no-default-features) and needs none
# of this.
ORT_VER=1.24.2
ORT_DYLIB="src-tauri/onnxruntime/libonnxruntime.dylib"

for target in "${TARGETS[@]}"; do
  echo "==> building $target"
  if [ "$target" = "x86_64-apple-darwin" ]; then
    # Dictation compiled out. Clear any arm64 dylib staged by a prior "both"
    # leg so it can't land in the Intel bundle, and leave a marker so the
    # bundle.resources `onnxruntime/*` glob still matches.
    rm -f src-tauri/onnxruntime/*.dylib
    mkdir -p src-tauri/onnxruntime
    echo "Dictation is unavailable on Intel macOS (no compatible ONNX Runtime)." \
      > src-tauri/onnxruntime/DICTATION_UNSUPPORTED.txt
    BUILD_ARGS=(--target "$target" --no-default-features)
  else
    if [ ! -f "$ORT_DYLIB" ]; then
      echo "==> fetching ONNX Runtime $ORT_VER"
      tmp="$(mktemp -d)"
      curl -fSL -o "$tmp/ort.tgz" \
        "https://github.com/microsoft/onnxruntime/releases/download/v${ORT_VER}/onnxruntime-osx-arm64-${ORT_VER}.tgz"
      tar -xzf "$tmp/ort.tgz" -C "$tmp"
      mkdir -p src-tauri/onnxruntime
      cp "$tmp/onnxruntime-osx-arm64-${ORT_VER}/lib/libonnxruntime.${ORT_VER}.dylib" "$ORT_DYLIB"
      rm -rf "$tmp"
    fi
    echo "==> re-signing ONNX Runtime for notarisation"
    codesign --force --timestamp --options runtime --sign "$SIGNING_IDENTITY" "$ORT_DYLIB"
    codesign --verify --strict "$ORT_DYLIB"
    BUILD_ARGS=(--target "$target")
  fi
  npm run tauri build -- "${BUILD_ARGS[@]}"

  BUNDLE="src-tauri/target/$target/release/bundle"
  APP="$BUNDLE/macos/Canopy.app"
  DMG=$(find "$BUNDLE/dmg" -name "*.dmg" | head -1)

  # `tauri build` exits 0 even when updater signing fails, so check rather than
  # trust the exit code.
  if [ ! -f "$BUNDLE/macos/Canopy.app.tar.gz.sig" ]; then
    echo "error: no updater signature produced for $target" >&2
    exit 1
  fi

  echo "==> verifying signature"
  codesign --verify --deep --strict --verbose=2 "$APP"
  # The sidecar ships inside the bundle and is copied out to ~/.canopy/bin at
  # runtime; if it isn't signed, that copy is what Gatekeeper kills.
  codesign --verify --strict "$APP/Contents/MacOS/canopy-hook"

  echo "==> notarising $(basename "$DMG")"
  xcrun notarytool submit "$DMG" --keychain-profile "$NOTARIZE_PROFILE" --wait

  echo "==> stapling"
  xcrun stapler staple "$DMG"
  xcrun stapler staple "$APP"

  echo "==> gatekeeper assessment (what a user's Mac will decide)"
  spctl -a -vvv -t install "$DMG" || true

  echo "built: $DMG"
done

echo "done."

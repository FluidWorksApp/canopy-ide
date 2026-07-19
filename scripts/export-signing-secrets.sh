#!/usr/bin/env bash
# =============================================================================
# Export the signing secrets the release workflow needs — and learn what each is
# =============================================================================
# The GitHub Actions release (.github/workflows/release.yml) signs the macOS app
# and signs the updater manifest. It reads these secrets (Settings → Secrets and
# variables → Actions). This script produces the exact values for them.
#
#   APPLE_CERTIFICATE                  base64 of a .p12 holding the Developer ID
#                                      Application cert AND its private key.
#   APPLE_CERTIFICATE_PASSWORD         the password you set on that .p12 below.
#   APPLE_SIGNING_IDENTITY             "Developer ID Application: NAME (TEAMID)".
#   APPLE_TEAM_ID                      your 10-char Apple team id.
#   APPLE_ID                           Apple account email (used for notarizing).
#   APPLE_PASSWORD                     an APP-SPECIFIC password from
#                                      https://appleid.apple.com — NOT your
#                                      account password. Notarization 401s on the
#                                      account password.
#   TAURI_SIGNING_PRIVATE_KEY          the FULL contents of ~/.tauri/canopy.key,
#                                      including its first "untrusted comment:"
#                                      line. Dropping that line is what causes
#                                      "Missing comment in secret key" in CI.
#   TAURI_SIGNING_PRIVATE_KEY_PASSWORD empty string — this key has no password.
#
# Note: `security export` below exports EVERY identity in the login keychain,
# so the .p12 usually holds more than just the Developer ID cert. That's fine:
# the release workflow imports the .p12 itself and codesign picks the identity
# by the APPLE_SIGNING_IDENTITY name. (Tauri's own importer — used when the
# workflow passes APPLE_CERTIFICATE straight to tauri-action — rejects a
# multi-identity .p12 with "does not match provided identity", which is why
# the workflow doesn't do that.)
#
# This script re-runs the same import against a throwaway keychain so you know
# the .p12 is good BEFORE you upload it: a missing private key or a wrong
# password fails with
#   SecKeychainItemImport: One or more parameters passed to a function ...
#
# Usage:
#   ./scripts/export-signing-secrets.sh          # export + validate, write values to a file
#   ./scripts/export-signing-secrets.sh --set    # ...and push them with `gh secret set`
#
# Nothing here is committed and nothing leaves your machine unless you pass --set.
# =============================================================================
set -euo pipefail

SET_SECRETS=false
[ "${1:-}" = "--set" ] && SET_SECRETS=true

UPDATER_KEY="$HOME/.tauri/canopy.key"
LOGIN_KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"
OUT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/canopy-secrets.XXXXXX")"
P12="$OUT_DIR/certificate.p12"
ENV_OUT="$OUT_DIR/secrets.env"
chmod 700 "$OUT_DIR"

# Clean up the intermediate .p12 and temp keychain on exit; keep secrets.env so
# you can copy from it, but it is chmod 600 and you should delete it after.
cleanup() { rm -f "$P12" "$OUT_DIR"/validate.keychain-db* 2>/dev/null || true; }
trap cleanup EXIT

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

# ── 1. Find the Developer ID Application identity in your keychain ──────────
say "1/4  Locating your Developer ID Application certificate"
IDENTITY_LINE="$(security find-identity -v -p codesigning | grep -F 'Developer ID Application' | head -1 || true)"
if [ -z "$IDENTITY_LINE" ]; then
  echo "  No 'Developer ID Application' identity in your keychain." >&2
  echo "  Create/download it from developer.apple.com, install it in Keychain" >&2
  echo "  Access, then re-run. (Xcode → Settings → Accounts → Manage Certificates" >&2
  echo "  can create one.)" >&2
  exit 1
fi
# The name inside the quotes is exactly what APPLE_SIGNING_IDENTITY must be.
APPLE_SIGNING_IDENTITY="$(sed -E 's/.*"([^"]+)".*/\1/' <<<"$IDENTITY_LINE")"
# Team id is the 10-char code in parentheses at the end of the identity name.
APPLE_TEAM_ID="$(sed -E 's/.*\(([A-Z0-9]{10})\)$/\1/' <<<"$APPLE_SIGNING_IDENTITY")"
echo "  identity : $APPLE_SIGNING_IDENTITY"
echo "  team id  : $APPLE_TEAM_ID"

# ── 2. Export that identity (cert + private key) to a password-protected .p12 ─
say "2/4  Exporting the certificate + private key to a .p12"
echo "  You'll pick a password for the .p12 — this becomes APPLE_CERTIFICATE_PASSWORD."
echo "  macOS may pop a dialog asking to allow the export; enter your login password."
read -rsp "  Choose a .p12 password: " P12_PW; echo
[ -n "$P12_PW" ] || { echo "  empty password not allowed" >&2; exit 1; }

# `security export` pulls identities (cert + key) out of the login keychain.
# If this errors or exports the wrong thing, use the GUI instead:
#   Keychain Access → expand the cert so its private key shows underneath →
#   select BOTH → right-click → Export 2 items → .p12.
if ! security export -k "$LOGIN_KEYCHAIN" -t identities -f pkcs12 -P "$P12_PW" -o "$P12" 2>/dev/null; then
  echo "  security export failed (common on locked keychains)." >&2
  echo "  Fall back to the Keychain Access GUI export described above, save it to" >&2
  echo "  $P12, then re-run with the same password." >&2
  [ -f "$P12" ] || exit 1
fi
echo "  wrote $P12 ($(wc -c <"$P12" | tr -d ' ') bytes)"

# ── 3. Validate the .p12 the way CI does — import into a throwaway keychain ──
say "3/4  Validating (the same import CI performs)"
TMP_KC="$OUT_DIR/validate.keychain-db"
security create-keychain -p tmp "$TMP_KC" >/dev/null
if security import "$P12" -k "$TMP_KC" -P "$P12_PW" -T /usr/bin/codesign >/dev/null 2>&1; then
  echo "  ✓ .p12 imports cleanly — CI's SecKeychainItemImport step will pass."
else
  echo "  ✗ .p12 failed to import. It's likely missing the private key or the" >&2
  echo "    password is wrong. Re-export via the Keychain Access GUI (select the" >&2
  echo "    cert AND the key nested under it)." >&2
  security delete-keychain "$TMP_KC" 2>/dev/null || true
  exit 1
fi
# CI signs by name, so the Developer ID identity must be resolvable inside the
# .p12 — verify that here the same way the workflow does.
if security find-identity -v -p codesigning "$TMP_KC" | grep -qF "$APPLE_SIGNING_IDENTITY"; then
  echo "  ✓ \"$APPLE_SIGNING_IDENTITY\" is resolvable inside the .p12."
else
  echo "  ✗ the .p12 imports, but \"$APPLE_SIGNING_IDENTITY\" isn't among its" >&2
  echo "    identities — CI would fail to sign. Re-export via Keychain Access," >&2
  echo "    selecting the Developer ID cert AND its nested private key." >&2
  security delete-keychain "$TMP_KC" 2>/dev/null || true
  exit 1
fi
security delete-keychain "$TMP_KC" 2>/dev/null || true

APPLE_CERTIFICATE="$(base64 <"$P12" | tr -d '\n')"   # single line; CI decodes it

# ── 4. Updater key + the values only you can supply ────────────────────────
say "4/4  Updater key and Apple account details"
[ -f "$UPDATER_KEY" ] || { echo "  missing $UPDATER_KEY (the Tauri updater private key)" >&2; exit 1; }
TAURI_SIGNING_PRIVATE_KEY="$(cat "$UPDATER_KEY")"   # includes the comment line — required
# The .key file is itself base64; the "untrusted comment:" line only appears
# once decoded, so decode before checking (grepping the raw blob false-warns).
if ! base64 --decode <"$UPDATER_KEY" 2>/dev/null | head -1 | grep -qi 'comment'; then
  echo "  warning: $UPDATER_KEY doesn't decode to a key with a comment line; CI may reject it." >&2
fi
read -rp "  Apple ID email (APPLE_ID): " APPLE_ID
echo "  APPLE_PASSWORD must be an APP-SPECIFIC password (appleid.apple.com →"
echo "  Sign-In and Security → App-Specific Passwords), not your account password."
read -rsp "  App-specific password (APPLE_PASSWORD): " APPLE_PASSWORD; echo

# ── Write the values out ───────────────────────────────────────────────────
umask 077
cat >"$ENV_OUT" <<EOF
# Secrets for FluidWorksApp/canopy-ide — paste into Settings → Secrets → Actions.
# DELETE THIS FILE once you've set them. It contains your private signing key.
APPLE_SIGNING_IDENTITY=$APPLE_SIGNING_IDENTITY
APPLE_TEAM_ID=$APPLE_TEAM_ID
APPLE_ID=$APPLE_ID
APPLE_PASSWORD=$APPLE_PASSWORD
APPLE_CERTIFICATE_PASSWORD=$P12_PW
TAURI_SIGNING_PRIVATE_KEY_PASSWORD=
# Long values (base64 .p12, updater key) are in the separate files below.
EOF
printf '%s' "$APPLE_CERTIFICATE" >"$OUT_DIR/APPLE_CERTIFICATE.b64"
printf '%s' "$TAURI_SIGNING_PRIVATE_KEY" >"$OUT_DIR/TAURI_SIGNING_PRIVATE_KEY.txt"

say "Done."
echo "Values written to: $OUT_DIR"
echo "  secrets.env                    the short values (+ passwords)"
echo "  APPLE_CERTIFICATE.b64          paste into the APPLE_CERTIFICATE secret"
echo "  TAURI_SIGNING_PRIVATE_KEY.txt  paste into TAURI_SIGNING_PRIVATE_KEY"
echo "Delete this directory when you're finished: rm -rf $OUT_DIR"

# ── Optionally push straight to GitHub with the gh CLI ─────────────────────
if $SET_SECRETS; then
  say "Pushing to GitHub with gh secret set"
  command -v gh >/dev/null || { echo "  gh not installed (brew install gh)"; exit 1; }
  REPO="FluidWorksApp/canopy-ide"
  gh secret set APPLE_SIGNING_IDENTITY           --repo "$REPO" --body "$APPLE_SIGNING_IDENTITY"
  gh secret set APPLE_TEAM_ID                    --repo "$REPO" --body "$APPLE_TEAM_ID"
  gh secret set APPLE_ID                         --repo "$REPO" --body "$APPLE_ID"
  gh secret set APPLE_PASSWORD                   --repo "$REPO" --body "$APPLE_PASSWORD"
  gh secret set APPLE_CERTIFICATE_PASSWORD       --repo "$REPO" --body "$P12_PW"
  # TAURI_SIGNING_PRIVATE_KEY_PASSWORD is intentionally NOT set: gh's `--body ""`
  # is treated as "no value" and drops into an interactive "Paste your secret:"
  # prompt (which jammed the script). An unset secret already resolves to an
  # empty string in the workflow's env: block, which is the empty password we want.
  printf '%s' "$APPLE_CERTIFICATE"          | gh secret set APPLE_CERTIFICATE        --repo "$REPO"
  printf '%s' "$TAURI_SIGNING_PRIVATE_KEY"  | gh secret set TAURI_SIGNING_PRIVATE_KEY --repo "$REPO"
  echo "  All 7 secrets set on $REPO. Re-run the release workflow."
fi

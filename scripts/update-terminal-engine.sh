#!/usr/bin/env bash
# Refresh the prebuilt terminal engine the app ships (shared/terminalEngine/pkg)
# from a CI run of the "Terminal engine (wasm)" job, and record which sources
# it was built from.
#
#   scripts/update-terminal-engine.sh <run id>
#
# Run it on the commit that CI run built: after changing canopy-term-core,
# canopy-term-input or canopy-term-wasm, push, wait for the job (its last step
# fails until this is done), then run this and commit the result.
set -euo pipefail
run="${1:?usage: scripts/update-terminal-engine.sh <run id>}"
root="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
gh run download "$run" --name canopy-term-wasm --dir "$tmp"
dest="$root/shared/terminalEngine/pkg"
for f in canopy_term_wasm.js canopy_term_wasm.d.ts canopy_term_wasm_bg.wasm canopy_term_wasm_bg.wasm.d.ts; do
  cp "$tmp/pkg-web/$f" "$dest/$f"
done
node "$root/crates/canopy-term-wasm/js/source-hash.mjs" --write
echo "Updated $dest. Run the terminal tests (npx vitest run shared/terminalEngine) and commit."

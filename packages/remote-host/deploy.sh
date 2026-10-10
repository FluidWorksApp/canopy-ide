#!/usr/bin/env bash
set -euo pipefail
# Uses the operator's existing SSH configuration and host-key verification.
target=${1:?Usage: deploy.sh user@linux-vm}
[[ $target =~ ^[a-zA-Z0-9_][a-zA-Z0-9_.@:-]*$ ]] || { echo 'Invalid SSH target.' >&2; exit 1; }
source_dir=$(cd "$(dirname "$0")" && pwd)
bundle=$(mktemp -d)
trap 'rm -rf "$bundle"' EXIT
# The remote bundle has no repository tree from which to reconstruct the helper.
# Stage its explicit source allowlist locally into this fresh bundle.
node "$source_dir/prepare-hook-build.mjs" "$bundle/hook-build"
# Package runtime sources explicitly by type, excluding tests and local secrets.
for file in "$source_dir"/*.mjs "$source_dir"/*.sh; do
  [[ $file == *.test.mjs ]] && continue
  cp "$file" "$bundle/"
done
for file in Dockerfile .dockerignore package.json package-lock.json agents.lock.json canopy-host.service canopy-network.service canopy-runtime.tmpfiles.conf canopy-service.service canopy-service.tmpfiles.conf; do
  cp "$source_dir/$file" "$bundle/"
done
# Optional locally built daemon: CANOPY_SERVICE_BINARY_DIR holds
# canopy-serviced-linux-{amd64,arm64}; their checksums form the manifest.
if [[ -n ${CANOPY_SERVICE_BINARY_DIR:-} ]]; then
  mkdir "$bundle/bin"
  cp "$CANOPY_SERVICE_BINARY_DIR"/canopy-serviced-linux-* "$bundle/bin/"
  node "$source_dir/service-release.mjs" "$bundle/bin" > "$bundle/workspace-release.json"
fi
# A fixed remote script prevents target/path data from becoming shell code.
tar -C "$bundle" -czf - . | ssh "$target" 'set -eu; deploy_dir=$(mktemp -d /tmp/canopy-deploy.XXXXXX); trap '\''rm -rf "$deploy_dir"'\'' EXIT; tar -xzf - -C "$deploy_dir"; sudo bash "$deploy_dir/install.sh"'

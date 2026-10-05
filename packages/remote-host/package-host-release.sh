#!/usr/bin/env bash
set -euo pipefail
# Only checked-in runtime code and service definitions belong in this bundle.
# User homes, project volumes, host configuration and credentials are excluded.
source_dir=$(cd "$(dirname "$0")" && pwd)
output=${1:?Usage: package-host-release.sh output.tar.gz release.json}
release=${2:?Release manifest required}
output=$(python3 -c 'import os,sys;print(os.path.abspath(sys.argv[1]))' "$output")
bundle=$(mktemp -d)
trap 'rm -rf "$bundle"' EXIT
for file in "$source_dir"/*.mjs; do
  [[ $file == *.test.mjs ]] && continue
  cp "$file" "$bundle/"
done
for file in install.sh network-isolation.sh package.json package-lock.json agents.lock.json canopy-host.service canopy-network.service; do
  cp "$source_dir/$file" "$bundle/"
done
mkdir "$bundle/chrome-stream"
for file in server.mjs playwright.mjs protocol.mjs viewer.html viewer.js preview_picker.js; do
  cp "$source_dir/chrome-stream/$file" "$bundle/chrome-stream/$file"
done
cp "$release" "$bundle/workspace-release.json"
tar -C "$bundle" -czf "$output" .

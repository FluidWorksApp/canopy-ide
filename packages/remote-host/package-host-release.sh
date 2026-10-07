#!/usr/bin/env bash
set -euo pipefail
# Only checked-in runtime code and service definitions belong in this bundle.
# User homes, project volumes, host configuration and credentials are excluded.
source_dir=$(cd "$(dirname "$0")" && pwd)
output=${1:?Usage: package-host-release.sh output.tar.gz release.json}
release=${2:?Release manifest required}
output=$(python3 -c 'import os,sys;print(os.path.abspath(sys.argv[1]))' "$output")
# A release manifest records the two successful Linux smoke gates and binds the
# dependency identity to the actual reviewed package files, not a supplied label.
node --input-type=module - "$source_dir" "$release" <<'CANOPY_PACKAGE_VERIFY'
import {readFileSync} from 'node:fs';import {createHash} from 'node:crypto';import {join} from 'node:path';import {pathToFileURL} from 'node:url';
const [source,release]=process.argv.slice(2),manifest=JSON.parse(readFileSync(release,'utf8')),bytes=readFileSync(join(source,'package-lock.json'));
const {verifyRuntimePackageMetadata}=await import(pathToFileURL(join(source,'runtime-package-integrity.mjs')));
verifyRuntimePackageMetadata(JSON.parse(readFileSync(join(source,'package.json'),'utf8')),JSON.parse(bytes));
if(manifest.runtimeLockSha256!==createHash('sha256').update(bytes).digest('hex'))throw Error('Release dependency lock does not match reviewed runtime');
if(manifest.checks?.linuxAmd64!==true||manifest.checks?.linuxArm64!==true)throw Error('Both Linux runtime smoke gates are required');
CANOPY_PACKAGE_VERIFY
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

# Retained physical factory proof and dependency trees never enter a code archive.
node --input-type=module - "$output" <<'CANOPY_ARCHIVE_VERIFY'
import {execFileSync} from 'node:child_process';
const entries=execFileSync('tar',['-tzf',process.argv[2]],{encoding:'utf8'}).split('\n');
if(entries.some(entry=>entry.split('/').some(part=>part==='factory.json'||part==='node_modules')))throw Error('Runtime archive contains retained factory state');
CANOPY_ARCHIVE_VERIFY

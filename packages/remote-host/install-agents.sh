#!/usr/bin/env bash
# Root-owned tools; never install into a workspace's credential/home volume.
# One component per call so each CLI is its own image layer, keyed only by its
# own entry in agents.lock.json (the Dockerfile splits the lock per component).
# Usage: install-agents.sh <component> [lock-fragment.json]
#   components: bun, npm, aider, agy, cursor, grok, verify
set -euo pipefail
[[ $EUID == 0 ]] || { echo 'Install workspace tools as root.' >&2; exit 1; }
component=${1:?component required}
lock=${2:-}
export DEBIAN_FRONTEND=noninteractive
install -d /opt/canopy/tools /opt/canopy/vendor /usr/local/bin
case $(uname -m) in aarch64|arm64) arch=arm64; bun_arch=aarch64;; x86_64) arch=amd64; bun_arch=x64;; *) exit 1;; esac
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
case $component in
  bun)
    curl -fSL --retry 3 "https://github.com/oven-sh/bun/releases/download/bun-v$(jq -r .bun "$lock")/bun-linux-$bun_arch.zip" -o "$scratch/bun.zip"
    unzip -q "$scratch/bun.zip" -d "$scratch"
    install -m 0755 "$scratch/bun-linux-$bun_arch/bun" /usr/local/bin/bun
    ;;
  npm)
    # Fragment: {"name":"version"}. The download cache never enters the layer.
    mapfile -t packages < <(jq -r 'to_entries[] | .key + "@" + .value' "$lock")
    npm install -g --cache "$scratch/npm-cache" --no-audit --no-fund "${packages[@]}"
    ;;
  aider)
    python3 -m venv /opt/canopy/tools/aider
    /opt/canopy/tools/aider/bin/pip install --no-cache-dir "aider-chat==$(jq -r .aider "$lock")"
    ln -sf /opt/canopy/tools/aider/bin/aider /usr/local/bin/aider
    ;;
  agy)
    curl -fSL --retry 3 "$(jq -r --arg arch "$arch" '.agy[$arch].url' "$lock")" -o "$scratch/agy.tar.gz"
    printf '%s  %s\n' "$(jq -r --arg arch "$arch" '.agy[$arch].sha512' "$lock")" "$scratch/agy.tar.gz" | sha512sum --check -
    tar -xzf "$scratch/agy.tar.gz" -C "$scratch" antigravity
    install -m 0755 "$scratch/antigravity" /usr/local/bin/agy
    ;;
  cursor|grok)
    # Official installers put companion files beside their executable. Give each
    # one an isolated, root-owned installation home, outside agent credential homes.
    curl -fSL --retry 3 "$(jq -r '.installer.url' "$lock")" -o "$scratch/$component.sh"
    printf '%s  %s\n' "$(jq -r '.installer.sha256' "$lock")" "$scratch/$component.sh" | sha256sum --check -
    install -d "/opt/canopy/vendor/$component"
    if [[ $component == cursor ]]; then
      HOME=/opt/canopy/vendor/cursor bash "$scratch/cursor.sh"
      ln -sf /opt/canopy/vendor/cursor/.local/bin/cursor-agent /usr/local/bin/cursor-agent
    else
      HOME=/opt/canopy/vendor/grok GROK_BIN_DIR=/opt/canopy/vendor/grok/bin bash "$scratch/grok.sh" "$(jq -r .version "$lock")"
      ln -sf /opt/canopy/vendor/grok/bin/grok /usr/local/bin/grok
    fi
    # Installer download caches are not part of the tool.
    rm -rf "/opt/canopy/vendor/$component/.cache" "/opt/canopy/vendor/$component/.npm"
    ;;
  verify)
    for cli in claude codex amp aider agy opencode omp cursor-agent grok git gh; do
      command -v "$cli"
      timeout 30 "$cli" --version
    done
    ;;
  *) echo "Unknown component: $component" >&2; exit 1;;
esac

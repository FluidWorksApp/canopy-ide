#!/usr/bin/env bash
# Root-owned tools; never install into a workspace's credential/home volume.
# One component per call so each CLI is its own image layer, keyed only by its
# own entry in agents.lock.json (the Dockerfile splits the lock per component).
# Usage: install-agents.sh <component> [lock-fragment.json]
#   components: bun, npm, lazy-npm, aider, agy, cursor, grok, verify
#   lazy-npm <fragment> <bin>: install only a pinned launcher; the package
#   installs into the agent's home on first use (for very large CLIs).
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
  lazy-npm)
    bin=${3:?bin name required}
    spec=$(jq -r 'to_entries[0] | .key + "@" + .value' "$lock")
    version=$(jq -r 'to_entries[0].value' "$lock")
    [[ $bin =~ ^[a-z][a-z0-9-]*$ && $spec =~ ^@?[a-z0-9][a-z0-9._/-]*@[0-9][0-9A-Za-z.+-]*$ ]] || { echo 'Invalid lazy npm package' >&2; exit 1; }
    cat > "/usr/local/bin/$bin" <<LAUNCHER
#!/bin/sh
# $spec is large, so the image carries only this launcher. The first real run
# installs that exact version into the agent's npm prefix (persistent home),
# which is ahead of /usr/local/bin on PATH, so later runs never reach here.
set -e
prefix="\${NPM_CONFIG_PREFIX:-\$HOME/.local}"
real="\$prefix/bin/$bin"
if [ ! -x "\$real" ]; then
  case "\${1:-}" in --version|-v|-V) echo "$version"; exit 0;; esac
  echo "Installing $spec on first use..." >&2
  npm install -g --prefix "\$prefix" --no-audit --no-fund "$spec" >&2
fi
exec "\$real" "\$@"
LAUNCHER
    chmod 755 "/usr/local/bin/$bin"
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
    command -v omp
    for cli in claude codex amp aider agy opencode cursor-agent grok git gh; do
      command -v "$cli"
      timeout 30 "$cli" --version
    done
    ;;
  *) echo "Unknown component: $component" >&2; exit 1;;
esac

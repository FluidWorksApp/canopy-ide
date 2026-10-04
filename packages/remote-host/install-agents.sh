#!/usr/bin/env bash
# Root-owned tools; never install into a workspace's credential/home volume.
set -euo pipefail
[[ $EUID == 0 ]] || { echo 'Install workspace tools as root.' >&2; exit 1; }
source_dir=$(cd "$(dirname "$0")" && pwd)
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends git gh curl ripgrep jq unzip python3-venv python3-pip libsecret-1-0 dbus-x11 zstd xfce4-session xfce4-panel xfdesktop4 xfwm4 thunar xfce4-terminal xfce4-settings adwaita-icon-theme
install -d /opt/canopy/tools /opt/canopy/vendor /usr/local/bin
lock="$source_dir/agents.lock.json"
case $(uname -m) in aarch64|arm64) arch=arm64; bun_arch=aarch64;; x86_64) arch=amd64; bun_arch=x64;; *) exit 1;; esac
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
bun_version=$(jq -r .bun "$lock")
curl -fSL --retry 3 "https://github.com/oven-sh/bun/releases/download/bun-v$bun_version/bun-linux-$bun_arch.zip" -o "$scratch/bun.zip"
unzip -q "$scratch/bun.zip" -d "$scratch"
install -m 0755 "$scratch/bun-linux-$bun_arch/bun" /usr/local/bin/bun
mapfile -t packages < <(jq -r '.npm | to_entries[] | .key + "@" + .value' "$lock")
npm install -g "${packages[@]}"
python3 -m venv /opt/canopy/tools/aider
/opt/canopy/tools/aider/bin/pip install --no-cache-dir "aider-chat==$(jq -r .aider "$lock")"
ln -sf /opt/canopy/tools/aider/bin/aider /usr/local/bin/aider
curl -fSL --retry 3 "$(jq -r --arg arch "$arch" '.agy[$arch].url' "$lock")" -o "$scratch/agy.tar.gz"
printf '%s  %s\n' "$(jq -r --arg arch "$arch" '.agy[$arch].sha512' "$lock")" "$scratch/agy.tar.gz" | sha512sum --check -
tar -xzf "$scratch/agy.tar.gz" -C "$scratch" antigravity
install -m 0755 "$scratch/antigravity" /usr/local/bin/agy
# Official installers put companion files beside their executable. Give each
# one an isolated, root-owned installation home, outside agent credential homes.
for cli in cursor grok; do
  curl -fSL --retry 3 "$(jq -r --arg cli "$cli" '.installers[$cli].url' "$lock")" -o "$scratch/$cli.sh"
  printf '%s  %s\n' "$(jq -r --arg cli "$cli" '.installers[$cli].sha256' "$lock")" "$scratch/$cli.sh" | sha256sum --check -
  install -d "/opt/canopy/vendor/$cli"
  if [[ $cli == cursor ]]; then
    HOME=/opt/canopy/vendor/cursor bash "$scratch/cursor.sh"
    ln -sf /opt/canopy/vendor/cursor/.local/bin/cursor-agent /usr/local/bin/cursor-agent
  else
    HOME=/opt/canopy/vendor/grok GROK_BIN_DIR=/opt/canopy/vendor/grok/bin bash "$scratch/grok.sh" "$(jq -r .grok "$lock")"
    ln -sf /opt/canopy/vendor/grok/bin/grok /usr/local/bin/grok
  fi
done
for cli in claude codex amp aider agy opencode omp cursor-agent grok git gh; do
  command -v "$cli"
  timeout 30 "$cli" --version
done

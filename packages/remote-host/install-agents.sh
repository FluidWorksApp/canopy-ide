#!/usr/bin/env bash
# Root-owned tools; never install into a workspace's credential/home volume.
# One tool per call so each is its own image layer, keyed only by its own
# agents.lock.json entry (the Dockerfile splits the lock per tool). Every tool
# installs by its kind; nothing here is specific to one tool. Pin and bump tools
# with agents-lock.mjs, which also validates the lock.
# Usage: install-agents.sh <tool-fragment.json> | verify <agents.lock.json>
set -euo pipefail
[[ $EUID == 0 ]] || { echo 'Install workspace tools as root.' >&2; exit 1; }
export DEBIAN_FRONTEND=noninteractive
install -d /opt/canopy/tools /opt/canopy/vendor /usr/local/bin
case $(uname -m) in aarch64|arm64) arch=arm64;; x86_64) arch=amd64;; *) echo "Unsupported architecture $(uname -m)" >&2; exit 1;; esac
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT

if [[ ${1:-} == verify ]]; then
  lock=${2:?lock required}
  mapfile -t bins < <(jq -r '.[] | (.bin | if type == "object" then keys[] else .[] end)' "$lock")
  for cli in "${bins[@]}" git gh; do
    command -v "$cli"
    timeout 30 "$cli" --version
  done
  exit 0
fi

fragment=${1:?tool fragment required}
name=$(jq -r 'keys[0]' "$fragment")
field() { jq -r --arg name "$name" ".[\$name]$1" "$fragment"; }
version=$(field .version)
[[ $name =~ ^[a-z][a-z0-9-]*$ ]] || { echo "Invalid tool name $name" >&2; exit 1; }

case $(field .kind) in
  archive)
    # An immutable, versioned artifact, checked before anything is unpacked.
    url=$(field ".platforms.$arch.url"); url=${url//\{version\}/$version}
    curl -fSL --retry 3 "$url" -o "$scratch/download"
    printf '%s  %s\n' "$(field ".platforms.$arch.sha512")" "$scratch/download" | sha512sum --check -
    home=/opt/canopy/vendor/$name/$version
    rm -rf "/opt/canopy/vendor/$name"; install -d "$scratch/unpacked" "$home"
    case $(field .format) in
      binary) install -m 0755 "$scratch/download" "$scratch/unpacked/$(field '.bin | keys[0]')";;
      tar.gz) tar -xzf "$scratch/download" -C "$scratch/unpacked";;
      zip) unzip -q "$scratch/download" -d "$scratch/unpacked";;
      *) echo "$name: unknown archive format" >&2; exit 1;;
    esac
    source=$scratch/unpacked
    if [[ $(field .strip) == 1 ]]; then
      mapfile -t top < <(find "$source" -mindepth 1 -maxdepth 1)
      [[ ${#top[@]} == 1 && -d ${top[0]} ]] || { echo "$name: expected one top-level directory to strip" >&2; exit 1; }
      source=${top[0]}
    fi
    cp -a "$source/." "$home/"
    chown -R root:root "$home"
    while IFS=$'\t' read -r bin path; do
      [[ -f $home/$path ]] || { echo "$name: $path is not in the package" >&2; exit 1; }
      chmod 0755 "$home/$path"
      ln -sf "$home/$path" "/usr/local/bin/$bin"
    done < <(field '.bin | to_entries[] | .key + "\t" + .value')
    ;;
  npm)
    spec="$(field .package)@$version"
    if [[ $(field .lazy) == true ]]; then
      bin=$(field '.bin[0]')
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
    else
      # The download cache never enters the layer.
      npm install -g --cache "$scratch/npm-cache" --no-audit --no-fund "$spec"
    fi
    ;;
  pip)
    python3 -m venv "/opt/canopy/tools/$name"
    "/opt/canopy/tools/$name/bin/pip" install --no-cache-dir "$(field .package)==$version"
    while read -r bin; do ln -sf "/opt/canopy/tools/$name/bin/$bin" "/usr/local/bin/$bin"; done < <(field '.bin[]')
    ;;
  *) echo "$name: unknown kind" >&2; exit 1;;
esac

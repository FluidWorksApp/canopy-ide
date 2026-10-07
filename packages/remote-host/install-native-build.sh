#!/usr/bin/env bash
# Native Linux desktop build prerequisites, installed once in the workspace image.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends build-essential pkg-config curl wget file libssl-dev libgtk-3-dev libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev patchelf libasound2-dev
if [[ ! -x /opt/canopy/cargo/bin/rustup ]]; then
  installer=$(mktemp)
  curl --proto '=https' --tlsv1.2 -fsSL --retry 3 https://sh.rustup.rs -o "$installer"
  RUSTUP_HOME=/opt/canopy/rustup CARGO_HOME=/opt/canopy/cargo sh "$installer" -y --profile minimal --default-toolchain stable --no-modify-path
  rm -f "$installer"
fi
chmod -R a+rX /opt/canopy/rustup /opt/canopy/cargo
for tool in cargo rustc rustdoc rustup; do
 cat > "/usr/local/bin/$tool" <<WRAPPER
#!/bin/sh
export RUSTUP_HOME="\${RUSTUP_HOME:-/opt/canopy/rustup}"
exec /opt/canopy/cargo/bin/$tool "\$@"
WRAPPER
 chmod 755 "/usr/local/bin/$tool"
done
rustc --version
cargo --version
pkg-config --modversion gtk+-3.0 webkit2gtk-4.1 alsa
# Package lists and rustup's download cache are not part of the toolchain.
rm -rf /var/lib/apt/lists/* /opt/canopy/rustup/downloads /opt/canopy/rustup/tmp

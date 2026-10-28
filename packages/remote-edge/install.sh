#!/usr/bin/env bash
# Install or upgrade the Canopy remote edge on a Linux VM (run from a checkout of this directory).
set -euo pipefail
[[ $(uname -s) == Linux ]] || { echo 'Run this installer on the Linux VM.' >&2; exit 1; }
[[ $EUID == 0 ]] || { echo 'Run with sudo.' >&2; exit 1; }
command -v node >/dev/null
command -v npm >/dev/null
command -v systemctl >/dev/null
[[ $(node -p 'Number(process.versions.node.split(".")[0])') -ge 22 ]] || { echo 'Node.js 22+ is required.' >&2; exit 1; }
source_dir=$(cd "$(dirname "$0")" && pwd)
env_file=/etc/canopy-remote-edge.env
id canopy-remote-edge >/dev/null 2>&1 || useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin canopy-remote-edge
install -d -m 0755 /opt/canopy-remote-edge
for file in main.mjs edge.mjs tokens.mjs tunnel.mjs package.json package-lock.json; do
  install -m 0644 "$source_dir/$file" /opt/canopy-remote-edge/
done
(cd /opt/canopy-remote-edge && npm ci --omit=dev --ignore-scripts)
if [[ ! -f $env_file ]]; then
  # The secret must be the same value the website uses, so it is never generated here.
  printf '%s\n' 'CANOPY_REMOTE_EDGE_SECRET=' 'CANOPY_REMOTE_DOMAIN=remote.canopyide.dev' 'CANOPY_REMOTE_AUTH_ORIGIN=https://canopyide.dev' > "$env_file"
  chown root:canopy-remote-edge "$env_file"
  chmod 0640 "$env_file"
  echo "Wrote $env_file. Set CANOPY_REMOTE_EDGE_SECRET, then rerun this installer." >&2
  exit 1
fi
secret=$(sed -n 's/^CANOPY_REMOTE_EDGE_SECRET=//p' "$env_file")
[[ ${#secret} -ge 32 ]] || { echo "CANOPY_REMOTE_EDGE_SECRET in $env_file must be at least 32 characters." >&2; exit 1; }
domain=$(sed -n 's/^CANOPY_REMOTE_DOMAIN=//p' "$env_file")
[[ $domain =~ ^[a-z0-9.-]+$ ]] || { echo "CANOPY_REMOTE_DOMAIN in $env_file is not a DNS name." >&2; exit 1; }
node_binary=$(command -v node)
[[ $node_binary =~ ^/[a-zA-Z0-9_./-]+$ ]] || { echo 'Node executable path is not service compatible.' >&2; exit 1; }
sed "s|/usr/bin/node|$node_binary|" "$source_dir/canopy-remote-edge.service" > /etc/systemd/system/canopy-remote-edge.service
chmod 0644 /etc/systemd/system/canopy-remote-edge.service
# Caddy only needs the domain, not the secret.
if command -v caddy >/dev/null && [[ -d /etc/caddy ]]; then
  install -m 0644 "$source_dir/Caddyfile" /etc/caddy/Caddyfile
  install -d -m 0755 /etc/systemd/system/caddy.service.d
  printf '[Service]\nEnvironment=CANOPY_REMOTE_DOMAIN=%s\n' "$domain" > /etc/systemd/system/caddy.service.d/canopy-remote-edge.conf
  chmod 0644 /etc/systemd/system/caddy.service.d/canopy-remote-edge.conf
fi
systemctl daemon-reload
systemctl enable canopy-remote-edge
systemctl restart canopy-remote-edge
if systemctl list-unit-files caddy.service >/dev/null 2>&1 && [[ -f /etc/systemd/system/caddy.service.d/canopy-remote-edge.conf ]]; then
  systemctl enable caddy
  systemctl restart caddy
fi
for _ in $(seq 1 20); do
  curl -fsS http://127.0.0.1:8080/healthz >/dev/null 2>&1 && { echo 'canopy-remote-edge is running.'; exit 0; }
  sleep 0.5
done
echo 'canopy-remote-edge did not become healthy; see journalctl -u canopy-remote-edge.' >&2
exit 1

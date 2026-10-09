#!/usr/bin/env bash
# Install canopy-serviced (the agent harness service) from a host release
# bundle. Run as root by install.sh and by the managed-host bootstrap, after the
# bundle was extracted and the canopy-host user/group exist.
#
# Optional environment:
#   CANOPY_SERVICE_STATE_ROOT   retained data directory bound over
#                               /var/lib/canopy-service (managed: /srv/canopy/service-state)
#   CANOPY_SERVICE_RELAY_URL    control-plane origin for the daemon's relay client
#   CANOPY_SERVICE_ACCESS_KEYS  JSON file {"<kid>":"<b64 Ed25519 public key>"}
#   CANOPY_SERVICE_START=0      install and enable only; do not (re)start
# A bundle without a binary for this architecture installs nothing: the gateway
# then starts agents without harness tools and reports why.
set -euo pipefail
[[ $(uname -s) == Linux ]] || { echo 'Run this installer on the Linux VM.' >&2; exit 1; }
[[ $EUID == 0 ]] || { echo 'Run as root.' >&2; exit 1; }
source_dir=$(cd "$(dirname "$0")" && pwd)
case $(uname -m) in
  x86_64|amd64) arch=amd64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) echo "Canopy service: unsupported architecture $(uname -m); skipped." >&2; exit 0 ;;
esac
binary=$source_dir/bin/canopy-serviced-linux-$arch
if [[ ! -f $binary ]]; then
  echo "Canopy service: no canopy-serviced binary for linux-$arch in this bundle; agents run without harness tools." >&2
  exit 0
fi
# The archive's own checksum covers the binary in transit; this binds the file
# to the release manifest the archive was packaged against.
expected=$(node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const s=m.serviceBinaries?.["linux-"+process.argv[2]]?.sha256;if(!/^[a-f0-9]{64}$/.test(s??""))process.exit(1);process.stdout.write(s);' "$source_dir/workspace-release.json" "$arch") \
  || { echo 'Canopy service: release manifest has no checksum for this binary.' >&2; exit 1; }
actual=$(sha256sum "$binary" | cut -d' ' -f1)
[[ $actual == "$expected" ]] || { echo 'Canopy service: binary does not match the release manifest.' >&2; exit 1; }

getent group canopy-host >/dev/null || groupadd --system canopy-host
id canopy-service >/dev/null 2>&1 || useradd --system --no-create-home --home-dir /var/lib/canopy-service --gid canopy-host --shell /usr/sbin/nologin canopy-service
[[ $(id -gn canopy-service) == canopy-host ]] || usermod -g canopy-host canopy-service

# Root-owned code and declarations only: the gateway user owns /opt/canopy-host.
install -d -m 0755 -o root -g root /usr/local/lib/canopy-service /etc/canopy-service
install -m 0755 -o root -g root "$binary" /usr/local/lib/canopy-service/canopy-serviced.new
mv -f /usr/local/lib/canopy-service/canopy-serviced.new /usr/local/lib/canopy-service/canopy-serviced
install -m 0644 -o root -g root "$source_dir/canopy-service.tmpfiles.conf" /etc/tmpfiles.d/canopy-service.conf
install -m 0644 -o root -g root "$source_dir/canopy-service.service" /etc/systemd/system/canopy-service.service

state_root=${CANOPY_SERVICE_STATE_ROOT:-/var/lib/canopy-service}
[[ $state_root =~ ^/[a-zA-Z0-9_./-]+$ && $state_root != *..* ]] || { echo 'Canopy service: invalid state root.' >&2; exit 1; }
install -d -m 0700 -o canopy-service -g canopy-host "$state_root"
install -d -m 0755 /etc/systemd/system/canopy-service.service.d
if [[ $state_root != /var/lib/canopy-service ]]; then
  printf '[Unit]\nRequiresMountsFor=%s\n[Service]\nBindPaths=%s:/var/lib/canopy-service\n' "$state_root" "$state_root" > /etc/systemd/system/canopy-service.service.d/state.conf
else
  rm -f /etc/systemd/system/canopy-service.service.d/state.conf
fi
if [[ -n ${CANOPY_SERVICE_ACCESS_KEYS:-} ]]; then
  node -e 'const k=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));if(!k||typeof k!=="object"||Array.isArray(k)||!Object.keys(k).length||Object.entries(k).some(([id,v])=>!/^[A-Za-z0-9._-]{1,128}$/.test(id)||typeof v!=="string"||Buffer.from(v,"base64").length!==32))process.exit(1)' "$CANOPY_SERVICE_ACCESS_KEYS" \
    || { echo 'Canopy service: invalid access verification keys.' >&2; exit 1; }
  install -m 0600 -o canopy-service -g canopy-host "$CANOPY_SERVICE_ACCESS_KEYS" "$state_root/access-keys.json"
fi
if [[ -n ${CANOPY_SERVICE_RELAY_URL:-} ]]; then
  [[ $CANOPY_SERVICE_RELAY_URL =~ ^https://[a-zA-Z0-9.-]+(:[0-9]+)?$ ]] || { echo 'Canopy service: relay URL must be an https origin.' >&2; exit 1; }
  printf 'CANOPY_SERVICE_RELAY_URL=%s\n' "$CANOPY_SERVICE_RELAY_URL" > /etc/canopy-service/env
  chmod 0644 /etc/canopy-service/env
fi
systemd-tmpfiles --create /etc/tmpfiles.d/canopy-service.conf
systemctl daemon-reload
systemctl enable canopy-service
if [[ ${CANOPY_SERVICE_START:-1} != 0 ]]; then
  systemctl restart canopy-service || echo 'Canopy service did not become ready; agents start without harness tools until it does.' >&2
fi

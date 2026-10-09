#!/usr/bin/env bash
# Release gate: boot a packaged runtime the way a managed host does, before the
# archive can be uploaded. Runs as root on a disposable Linux VM with systemd
# and Docker (the GitHub ubuntu-24.04 runner). Mirrors the root-side steps of
# canopy-website lib/canopy/bootstrap.mjs that touch this runtime: umask 077,
# root image step first, then canopy-host as its unprivileged user under the
# shipped units. Regression gate for runtime 34d0550, where canopy-host
# crash-looped with EACCES on /run/canopy/resource-admission.lock.
#
# Usage: sudo bash smoke-host-boot.sh workspace-host.tar.gz
set -euo pipefail
archive=$(realpath "${1:?Usage: smoke-host-boot.sh workspace-host.tar.gz}")
[[ $EUID == 0 ]] || { echo 'Run as root on a disposable VM.' >&2; exit 1; }
[[ $(uname -s) == Linux ]] && command -v systemctl >/dev/null && docker info >/dev/null
umask 077
fail() { echo "HOST BOOT GATE FAILED: $*" >&2; journalctl -u canopy-service -u canopy-host --no-pager -n 120 >&2 || true; exit 1; }
cleanup() { docker rm -f canopy-gate-registry >/dev/null 2>&1 || true; }
trap cleanup EXIT

# 1. A sparse 64 GB ext4 disk at /srv/canopy stands in for the retained data
# disk: the image step's free-space preflight measures /srv/canopy/containerd,
# and a runner's root disk is smaller than a workspace image needs.
truncate -s 64G /var/tmp/canopy-gate-disk.img
mkfs.ext4 -q -F /var/tmp/canopy-gate-disk.img
mkdir -p /srv/canopy
mountpoint -q /srv/canopy || mount -o loop /var/tmp/canopy-gate-disk.img /srv/canopy
# Runtime archive and service identity, exactly like the bootstrap.
mkdir -p /srv/canopy/containerd /srv/canopy/docker /srv/canopy/host-state /opt/canopy-host /etc/canopy-host
tar -xzf "$archive" -C /opt/canopy-host
(cd /opt/canopy-host && npm ci --omit=dev --ignore-scripts)
id canopy-host >/dev/null 2>&1 || useradd --system --home-dir /srv/canopy/host-state --shell /usr/sbin/nologin canopy-host
usermod -aG docker canopy-host
# The bootstrap's historical creation under umask 077 (a root 0700 directory).
# Kept deliberately: the runtime must own its shared files, not depend on it.
mkdir -p /run/canopy
install -m 0660 -o root -g canopy-host /dev/null /run/canopy/resource-admission.lock

# 2. Image step as root, before management services, from a registry digest.
docker run -d --name canopy-gate-registry -p 127.0.0.1:5000:5000 registry:2 >/dev/null
for attempt in $(seq 1 30); do curl -fsS http://127.0.0.1:5000/v2/ >/dev/null 2>&1 && break; sleep 1; done
printf 'FROM busybox:1.36\nLABEL org.opencontainers.image.title=canopy-gate\n' | docker build -q -t 127.0.0.1:5000/canopy-workspace:gate - >/dev/null
docker push -q 127.0.0.1:5000/canopy-workspace:gate >/dev/null
reference=$(docker image inspect --format '{{index .RepoDigests 0}}' 127.0.0.1:5000/canopy-workspace:gate)
docker image rm 127.0.0.1:5000/canopy-workspace:gate >/dev/null
resolved=$(CANOPY_IMAGE_FAILURE_FILE=/run/canopy/image-failure node /opt/canopy-host/image-release.mjs "$reference") || fail 'image step'
[[ $resolved == "$reference" ]] || fail "image step resolved $resolved, expected $reference"

# 3. Host services as the bootstrap installs them.
printf '%s' '{"workspaces":[],"principals":[]}' > /srv/canopy/host-state/host-config.json
chmod 755 /srv/canopy
chown -R canopy-host:canopy-host /srv/canopy/host-state /etc/canopy-host /opt/canopy-host
chmod 0755 /opt/canopy-host/network-isolation.sh
cp /opt/canopy-host/canopy-network.service /etc/systemd/system/canopy-network.service
# As install.sh does: the unit names /usr/bin/node; use this VM's Node 22.
node_binary=$(command -v node)
[[ $node_binary =~ ^/[a-zA-Z0-9_./-]+$ ]] || fail 'Node executable path is not service compatible'
sed "s|/usr/bin/node|$node_binary|" /opt/canopy-host/canopy-host.service > /etc/systemd/system/canopy-host.service
mkdir -p /etc/systemd/system/canopy-host.service.d
cat > /etc/systemd/system/canopy-host.service.d/managed.conf <<UNIT
[Service]
Environment=CANOPY_HOST_CONFIG=/srv/canopy/host-state/host-config.json
Environment=CANOPY_HOST_STATE=/srv/canopy/host-state
Environment=CANOPY_RESOURCE_ADMISSION_LOCK=/run/canopy/resource-admission.lock
Environment=CANOPY_INSTANCE_NAME=canopy-gate
Environment=CANOPY_WORKSPACE_IMAGE=$reference
ReadWritePaths=
ReadWritePaths=/srv/canopy/host-state
UNIT
chmod 0644 /etc/systemd/system/canopy-network.service /etc/systemd/system/canopy-host.service /etc/systemd/system/canopy-host.service.d/managed.conf
systemctl daemon-reload
systemctl enable --now canopy-network
# The harness service, from this archive's verified binary, on retained state.
CANOPY_SERVICE_STATE_ROOT=/srv/canopy/service-state bash /opt/canopy-host/install-service.sh || fail 'canopy-service install'
systemctl is-active --quiet canopy-service || fail 'canopy-service is not active'
systemctl restart canopy-host

# 4. canopy-host must answer and stay up (a crash loop restarts every 5 s).
code=''
for attempt in $(seq 1 60); do
  code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/v1/workspaces || true)
  [[ $code == 401 ]] && break
  sleep 0.5
done
[[ $code == 401 ]] || fail "management API answered '$code', expected 401"
restarts=$(systemctl show -p NRestarts --value canopy-host)
sleep 15
systemctl is-active --quiet canopy-host || fail 'canopy-host is not active'
[[ $(systemctl show -p NRestarts --value canopy-host) == "$restarts" ]] || fail 'canopy-host restarted'
! journalctl -u canopy-host --no-pager | grep -E 'EACCES|resource admission lock' >/dev/null || fail 'resource admission lock errors in the journal'
[[ $(stat -c '%U:%G %a' /run/canopy) == 'root:root 755' ]] || fail "/run/canopy is $(stat -c '%U:%G %a' /run/canopy)"
[[ $(stat -c '%U:%G %a' /run/canopy/resource-admission.lock) == 'root:canopy-host 660' ]] || fail "lock is $(stat -c '%U:%G %a' /run/canopy/resource-admission.lock)"
# The gateway's own lock use, as its user: admission must be granted.
runuser -u canopy-host -- node --input-type=module -e 'import {acquireResourceAdmission} from "/opt/canopy-host/resource-admission.mjs";const release=await acquireResourceAdmission("/run/canopy/resource-admission.lock",{timeoutMs:5000});await release();' || fail 'gateway user cannot take the resource lock'
# Admin socket: owned by the service, reachable by the gateway user only.
[[ $(stat -c '%U:%G %a' /run/canopy-service/admin.sock) == 'canopy-service:canopy-host 660' ]] || fail "admin.sock is $(stat -c '%U:%G %a' /run/canopy-service/admin.sock)"
runuser -u canopy-host -- curl -fsS --max-time 2 --unix-socket /run/canopy-service/admin.sock http://canopy-service/admin/health | grep -q '"ready":true' || fail 'gateway user cannot reach the service admin API'
! runuser -u nobody -- curl -fsS --max-time 2 --unix-socket /run/canopy-service/admin.sock http://canopy-service/admin/health >/dev/null 2>&1 || fail 'admin API is reachable by other users'
[[ $(stat -c '%U:%G %a' /run/canopy-service/ws) == 'canopy-service:canopy-host 755' ]] || fail 'service workspace socket root ownership'
[[ $(stat -c '%U:%G %a' /run/canopy-relay) == 'canopy-host:canopy-host 750' ]] || fail 'relay credential directory ownership'
[[ $(stat -c '%U %a' /srv/canopy/service-state) == 'canopy-service 700' ]] || fail 'retained service state ownership'
systemctl restart canopy-service || fail 'canopy-service restart'
[[ -d /run/canopy-service/ws ]] || fail 'service restart removed the workspace socket root'
echo 'Host boot gate passed: image step, canopy-host active, shared runtime files owned correctly.'

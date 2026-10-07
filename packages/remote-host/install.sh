#!/usr/bin/env bash
# Install an already reviewed source bundle on any Linux VM. No cloud-specific API.
set -euo pipefail
[[ $(uname -s) == Linux ]] || { echo 'Run this installer on the Linux VM.' >&2; exit 1; }
[[ $EUID == 0 ]] || { echo 'Run with sudo.' >&2; exit 1; }
command -v node >/dev/null
command -v docker >/dev/null
command -v systemctl >/dev/null
[[ $(node -p 'Number(process.versions.node.split(".")[0])') -ge 22 ]] || { echo 'Node.js 22+ is required.' >&2; exit 1; }
docker info >/dev/null
source_dir=$(cd "$(dirname "$0")" && pwd)
workspace_image=${CANOPY_WORKSPACE_IMAGE:?Set CANOPY_WORKSPACE_IMAGE to the published workspace image tag or digest}
id canopy-host >/dev/null 2>&1 || useradd --system --home-dir /var/lib/canopy-host --create-home --shell /usr/sbin/nologin canopy-host
usermod -aG docker canopy-host
install -d -m 0755 /opt/canopy-host
install -d -o canopy-host -g canopy-host -m 0700 /etc/canopy-host /var/lib/canopy-host
for file in runtime-dir.mjs user-storage.mjs storage-prep.mjs warmup.mjs host-storage.mjs snapshot-storage-install.mjs resource-admission.mjs release-prepull.mjs factory-metadata.mjs runtime-release-key.mjs idle-attestation.mjs session-view-leases.mjs sharing-setup.mjs retained-host-config.mjs shared-sessions.mjs credential-tickets.mjs agent-cli-sessions.mjs opencode-usage.mjs agent-cli-proxy.mjs provider-quota-headers.mjs git-cli-proxy.mjs shared-agent-launch.mjs shared-git-launch.mjs subscription-credentials.mjs credential-broker.mjs credential-vault.mjs credential-authority.mjs shared-accounts.mjs recover-image-upgrade.mjs image-upgrade.mjs image-release.mjs image-retention.mjs workspace-swap.mjs runtime-authority.mjs runtime-supervisor.mjs runtime-readiness.mjs git-identity.mjs gateway.mjs member-runtime.mjs member-authority.mjs member-leases.mjs member-renewal.mjs project-mounts.mjs readonly-native.mjs git-read.mjs project-volumes.mjs project-catalog.mjs project-migration.mjs migrate-project-volume.mjs owner-checkpoint.mjs migrate-workspace.mjs migration-journal.mjs migration-startup.mjs migration-recovery.mjs inspect-migration.mjs recover-migration.mjs capacity-group.mjs provision-capacity.mjs host-resources.mjs docker.mjs elastic-memory.mjs elastic-cpu.mjs policy.mjs http.mjs init.mjs accounts.mjs package.json package-lock.json; do
  install -m 0644 "$source_dir/$file" /opt/canopy-host/
done
(cd /opt/canopy-host && npm ci --omit=dev --ignore-scripts)
if [[ ! -f /etc/canopy-host/host.json ]]; then
  runuser -u canopy-host -- node /opt/canopy-host/init.mjs /etc/canopy-host
fi
# Never recreate running workspaces or overwrite grants/keys during an upgrade.
# Workspace dependencies are built and tested in CI, never on this VM.
resolved_image=$(node /opt/canopy-host/image-release.mjs "$workspace_image")
node_binary=$(command -v node)
[[ $node_binary =~ ^/[a-zA-Z0-9_./-]+$ ]] || { echo 'Node executable path is not service compatible.' >&2; exit 1; }
sed "s|/usr/bin/node|$node_binary|" "$source_dir/canopy-host.service" > /etc/systemd/system/canopy-host.service
chmod 0644 /etc/systemd/system/canopy-host.service
install -d -m 0755 /etc/systemd/system/canopy-host.service.d
printf '[Service]\nEnvironment=CANOPY_WORKSPACE_IMAGE=%s\n' "$workspace_image" > /etc/systemd/system/canopy-host.service.d/image.conf
chmod 0644 /etc/systemd/system/canopy-host.service.d/image.conf
install -m 0755 "$source_dir/network-isolation.sh" /opt/canopy-host/
install -m 0644 "$source_dir/canopy-runtime.tmpfiles.conf" /opt/canopy-host/
install -m 0644 "$source_dir/canopy-network.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now canopy-network
systemctl enable canopy-host
systemctl restart canopy-host
systemctl is-active --quiet canopy-host
echo 'Installed. Gateway listens on 127.0.0.1:8787; connect through SSH.'
echo 'Review /etc/canopy-host/host.json; tokens are in /etc/canopy-host/access-tokens.json.'

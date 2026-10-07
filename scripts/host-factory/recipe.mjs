import {workspaceImageReference} from '../../packages/remote-host/image-release.mjs';
const quote=value=>`'${String(value).replaceAll("'","'\\''")}'`;
// Lightsail prepends a /bin/sh initialization script to user data. A later
// shebang cannot select Bash, so explicitly hand the quoted body to Bash.
export function factoryBootstrapScript(body){
 if(body.split('\n').includes('CANOPY_FACTORY_BOOTSTRAP'))throw Error('Factory bootstrap delimiter collision');
 return `#!/bin/sh\nexec /bin/bash <<'CANOPY_FACTORY_BOOTSTRAP'\n${body}\nCANOPY_FACTORY_BOOTSTRAP\n`;
}
// A completed cloud-init without the smoke marker is a terminal failure,
// not a reason to keep a billable builder alive until the global deadline.
export const factoryStatusScript=`if [ -f /opt/canopy-host/factory.json ]; then
cat /opt/canopy-host/factory.json
elif [ -f /var/lib/cloud/data/result.json ]; then
printf '%s\\n' '{"factoryBootstrapFailed":true}'
else
printf '%s\\n' '{}'
fi`;
export function factoryRecipe(config,archiveUrl){
 if(config.architecture!=='amd64'||!/^22\.\d+\.\d+$/.test(config.nodeVersion??'')||!/^\d[\w.+:~-]*$/.test(config.dockerVersion??'')||!/^\d[\w.+:~-]*$/.test(config.caddyVersion??'')||['runtimeSha256','lockSha256','nodeSha256'].some(key=>!/^[a-f0-9]{64}$/.test(config[key]??''))||!/^[a-f0-9]{40}$/.test(config.revision??''))throw Error('Pinned factory versions and SHA256 checksums are required');
 const image=workspaceImageReference(config.image);if(!image.startsWith('ghcr.io/fluidworksapp/canopy-workspace@sha256:'))throw Error('Factory smoke requires the published immutable Canopy workspace image');
 const url=new URL(archiveUrl);if(url.protocol!=='https:'||url.username||url.password||!url.hostname.endsWith('.amazonaws.com'))throw Error('Private runtime archive must be a signed AWS HTTPS URL');
 const marker={version:1,architecture:config.architecture,revision:config.revision,runtimeSha256:config.runtimeSha256,lockSha256:config.lockSha256,nodeVersion:config.nodeVersion,dockerVersion:config.dockerVersion,caddyVersion:config.caddyVersion,proof:{docker:true,http:true,sanitized:false,bootFenced:false}};
 return factoryBootstrapScript(`set -euo pipefail
umask 077
[ "$(uname -m)" = x86_64 ]
# Only a fresh factory host with exactly its system disk is accepted.
[ "$(lsblk -dn -o TYPE | grep -c '^disk$')" -eq 1 ]
[ ! -e /srv/canopy/host-state ] && [ ! -e /etc/canopy-host/host.json ]
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
export DEBIAN_FRONTEND=noninteractive
systemctl mask docker.service docker.socket containerd.service caddy.service || true
apt-get update
apt-get install -y ${quote('docker.io='+config.dockerVersion)} ${quote('caddy='+config.caddyVersion)} curl ca-certificates xfsprogs
curl -fsSL ${quote('https://nodejs.org/dist/v'+config.nodeVersion+'/node-v'+config.nodeVersion+'-linux-x64.tar.xz')} -o "$scratch/node.tar.xz"
printf '%s  %s\\n' ${quote(config.nodeSha256)} "$scratch/node.tar.xz" | sha256sum -c -
tar -xJf "$scratch/node.tar.xz" -C /usr/local --strip-components=1
[ "$(node --version)" = ${quote('v'+config.nodeVersion)} ]
ln -sf /usr/local/bin/node /usr/bin/node
curl -fsSL ${quote(archiveUrl)} -o "$scratch/runtime.tar.gz"
printf '%s  %s\\n' ${quote(config.runtimeSha256)} "$scratch/runtime.tar.gz" | sha256sum -c -
# Archives are produced from reviewed runtime code, never a workspace volume.
mkdir -p /opt/canopy-host
tar -xzf "$scratch/runtime.tar.gz" -C /opt/canopy-host
cd /opt/canopy-host
printf '%s  package-lock.json\\n' ${quote(config.lockSha256)} | sha256sum -c -
npm ci --omit=dev --ignore-scripts
[ -f /opt/canopy-host/factory-metadata.mjs ]
systemctl unmask docker.service docker.socket containerd.service
systemctl start docker
docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --entrypoint node ${quote(image)} -e 'process.stdout.write("factory-docker-ok\\n")'
printf '%s' '{"workspaces":[],"principals":[]}' > "$scratch/host.json"
CANOPY_HOST_CONFIG="$scratch/host.json" CANOPY_HOST_STATE="$scratch/state" PORT=8787 node gateway.mjs > "$scratch/gateway.log" 2>&1 &
gateway_pid=$!
http_status=''
for attempt in $(seq 1 30); do http_status=$(curl -s -o "$scratch/http.json" -w '%{http_code}' http://127.0.0.1:8787/v1/workspaces || true); [ "$http_status" = 401 ] && break; sleep 1; done
[ "$http_status" = 401 ]
node --input-type=module -e 'import fs from "node:fs";if(JSON.parse(fs.readFileSync(process.argv[1])).error!=="Unauthorized")throw Error("Factory HTTP smoke failed")' "$scratch/http.json"
kill "$gateway_pid"
wait "$gateway_pid" || true
# Factory-only public smoke image has no user data. Remove it from root storage.
docker image rm ${quote(image)} >/dev/null
systemctl stop docker.service docker.socket containerd.service caddy.service || true
systemctl unmask caddy.service
systemctl disable docker.service docker.socket containerd.service caddy.service
printf '%s' ${quote(JSON.stringify(marker))} > /opt/canopy-host/factory.json
chmod 644 /opt/canopy-host/factory.json
# The publisher runs the separately reviewed seal after independently reading
# the marker. No snapshot is created from a host that has not passed both smokes.
printf '%s\\n' 'CANOPY_FACTORY_PREPARED'
`);
}
export const factorySeal=`set -euo pipefail
[ "$(lsblk -dn -o TYPE | grep -c '^disk$')" -eq 1 ]
[ ! -e /srv/canopy/host-state ] && [ ! -e /etc/canopy-host/host.json ]
for unit in docker.service docker.socket containerd.service caddy.service; do systemctl stop "$unit" || true; systemctl disable "$unit"; ! systemctl is-active --quiet "$unit"; done
rm -rf /root/.aws /root/.npm /root/.cache /root/.ssh /home/ubuntu/.ssh /var/lib/caddy /var/log/journal /var/lib/cloud/seed /var/lib/docker /var/lib/containerd /etc/canopy-host /var/lib/canopy-host
rm -f /etc/ssl/private/* /etc/ssh/ssh_host_* /var/log/cloud-init*.log /var/log/auth.log /var/log/syslog /root/.bash_history /home/ubuntu/.bash_history
cloud-init clean --logs --machine-id
rm -rf /var/lib/cloud/instances /var/lib/cloud/instance /var/lib/cloud/scripts /tmp/* /var/tmp/*
node --input-type=module -e 'import fs from "node:fs";const p="/opt/canopy-host/factory.json",m=JSON.parse(fs.readFileSync(p));if(m.proof.docker!==true||m.proof.http!==true)throw Error("Missing smoke evidence");m.proof.sanitized=true;m.proof.bootFenced=true;fs.writeFileSync(p,JSON.stringify(m));'
cat /opt/canopy-host/factory.json
`;

#!/usr/bin/env bash
# Disposable real-engine check. Never mounts source, Docker socket, host paths,
# existing workspace volumes or real credentials.
set -euo pipefail
image=${1:-canopy-workspace:validation}
prefix="canopy-smoke-$(date +%s)-$$"
cleanup(){
 docker rm -f "$prefix-a" "$prefix-b" >/dev/null 2>&1 || true
 for member in a b; do
  docker volume rm "$prefix-$member-home" "$prefix-$member-project" >/dev/null 2>&1 || true
 done
}
trap cleanup EXIT
for member in a b; do
 docker run -d --name "$prefix-$member" --network none --user 1000:1000 --cap-drop ALL \
  --security-opt no-new-privileges:true --memory 256m --memory-swap 448m --cpus 1 --pids-limit 128 \
  --mount "type=volume,source=$prefix-$member-home,target=/home/agent" \
  --mount "type=volume,source=$prefix-$member-project,target=/workspace" \
  "$image" node -e 'setInterval(()=>{},1000)' >/dev/null
 done
docker exec "$prefix-a" node -e 'require("fs").writeFileSync("/home/agent/private-test","synthetic credential");require("fs").writeFileSync("/workspace/private-test","synthetic file")'
docker exec "$prefix-b" node -e '
 const fs=require("fs"),assert=require("assert/strict");
 for(const path of ["/home/agent/private-test","/workspace/private-test","/var/run/docker.sock","/etc/canopy-host/host.json"]){assert.equal(fs.existsSync(path),false,path);}
 assert.equal(fs.readFileSync("/sys/fs/cgroup/memory.max","utf8").trim(),String(256*1048576));
 assert.equal(fs.readFileSync("/sys/fs/cgroup/memory.swap.max","utf8").trim(),String(192*1048576));
 assert.equal(process.getuid(),1000);
 const status=fs.readFileSync("/proc/self/status","utf8");
 assert.match(status,/CapEff:\s+0+\n/);
 assert.match(status,/NoNewPrivs:\s+1\n/);
 assert.throws(()=>fs.writeFileSync("/opt/canopy/management-test","untrusted"),{code:"EACCES"});
 console.log("PASS: member volumes isolated, host management paths absent, RAM and 75% swap limits enforced.");'
docker kill "$prefix-b" >/dev/null
[[ $(docker inspect --format '{{.State.Running}}' "$prefix-a") == true ]]
echo 'PASS: terminating one member container does not terminate the other.'

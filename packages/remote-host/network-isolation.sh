#!/usr/bin/env bash
# Host-owned firewall for Canopy bridges. Never run inside a workspace.
set -euo pipefail
[[ $EUID == 0 ]] || { echo 'Run as root on the workspace host.' >&2; exit 1; }
command -v iptables >/dev/null
command -v ip6tables >/dev/null
# cnp* is reserved for bridges created by DockerWorkspaces. Unrelated Docker
# networks are unaffected. Host-initiated runner connections keep their replies.
ensure() {
  local binary=$1 chain=$2; shift 2
  "$binary" -w -C "$chain" "$@" 2>/dev/null || "$binary" -w -I "$chain" 1 "$@"
}
for binary in iptables ip6tables; do
  "$binary" -w -N CANOPY-INPUT 2>/dev/null || "$binary" -w -S CANOPY-INPUT >/dev/null
  "$binary" -w -N CANOPY-EGRESS 2>/dev/null || "$binary" -w -S CANOPY-EGRESS >/dev/null
  # Populate before attaching, and never flush a live chain.
  ensure "$binary" CANOPY-INPUT -j DROP
  ensure "$binary" CANOPY-INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  ensure "$binary" INPUT -i 'cnp+' -j CANOPY-INPUT
  if [[ $binary == iptables ]]; then
    # Only the authenticated HTTPS facade is reachable from development
    # containers. Loopback management/runner ports remain behind INPUT DROP.
    ensure "$binary" CANOPY-INPUT -p tcp --dport 443 -j ACCEPT
    # Includes cloud metadata, private management services and other members.
    for range in 169.254.0.0/16 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 127.0.0.0/8; do
      ensure "$binary" CANOPY-EGRESS -d "$range" -j DROP
    done
  else
    # Workspace networks are IPv4 only; refuse alternate IPv6 routes.
    ensure "$binary" CANOPY-EGRESS -j DROP
  fi
  ensure "$binary" FORWARD -i 'cnp+' -j CANOPY-EGRESS
done

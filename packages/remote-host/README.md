# Workspace runtime releases

Workspace images are built and tested for Linux arm64 and amd64 in `.github/workflows/workspace-image.yml`. Main runtime changes and manual dispatches publish revision tags to GHCR. Only successful main releases promote `stable`; workspace data and credentials are excluded.

Set `CANOPY_WORKSPACE_IMAGE=ghcr.io/fluidworksapp/canopy-workspace:stable` in trusted VM provisioning. `install.sh` pulls the image rather than building it on the VM. Restarting or resuming a stopped workspace resolves the channel to an immutable digest. Running workspaces retain their current image until an explicit restart.

Persistent project/home volumes are reused. The original stopped container remains available, including its writable layer. Install custom tools in the persistent home or add them to the image; an old container's filesystem layer is retained for recovery but is not merged automatically into a new release.

New image readiness must pass before committing an upgrade. A failed candidate is preserved and the original is restored stopped. Interrupted host replacement quarantines the workspace. For offline recovery, stop and runtime-mask canopy-host.service, then run as root:

```
node /opt/canopy-host/recover-image-upgrade.mjs /etc/canopy-host/host.json /var/lib/canopy-host/image-upgrades WORKSPACE_ID
```

The command validates original identity and ownership, keeps all volumes and both container generations, and never starts compute. Review recovery before unmasking and starting the gateway.

The release artifact includes `workspace-release.json`, `workspace-host.tar.gz`, and its checksum. Publish that reviewed host archive to the configured private runtime bucket before changing VM provisioning. GHCR package visibility must be public and anonymous pulls verified before using a release on credential-free VMs.

Checks: remote-host Node suite; real Linux runtime/agent integration and isolation smoke tests; `smoke-image-upgrade.mjs` for image replacement, volume/file preservation and offline recovery.

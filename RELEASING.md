# Releasing Canopy

The complete illustrated lifecycle, build matrix, QA gates, stable aliases, and
failure policy are documented in
[docs/release-process.md](./docs/release-process.md).

## Quick path

Canopy uses a protected two-phase release:

Use `X.Y.Z` without a `v` for script arguments and version files. The script
adds `v` for the `release/vX.Y.Z` branch, `Release vX.Y.Z` PR, and `vX.Y.Z` tag.

```sh
# Phase 1: from a clean checkout, create the version-bump branch and PR.
./scripts/bump-version.sh X.Y.Z

# Merge the generated release/vX.Y.Z pull request.

# Phase 2: tag the merged main commit and trigger release CI.
./scripts/bump-version.sh --tag X.Y.Z
```

Never tag the release branch. The tag must point at the commit on `main` after
the version PR merges.

## Current build matrix

| Platform | Artifacts | Update path |
|---|---|---|
| macOS Apple Silicon | signed/notarized DMG and updater archive | in-app updater |
| macOS Intel | signed/notarized DMG, no dictation | in-app updater |
| Linux x86_64 | AppImage, `.deb`, `.rpm` | AppImage in-app; packages through package manager |
| Windows x86_64 | NSIS installer, currently unsigned | in-app updater |

Tauri cannot cross-compile the complete app between operating systems, so each
target builds on its native GitHub Actions runner.

## Publication gate

The tag workflow creates a **draft** GitHub Release. Before publishing:

1. Confirm all platform jobs completed.
2. Confirm updater signatures and `latest.json` exist.
3. Confirm every stable installer alias exists.
4. Install and smoke-test representative artifacts.
5. Review release notes, limitations, and version metadata.
6. Publish deliberately. Publishing activates latest-download URLs and updater
   rollout.

Required signing values live in GitHub Actions secrets, never in the repository
or Wiki. Use `scripts/export-signing-secrets.sh --set` from an authorized release
machine to validate and upload the macOS and updater credentials.

For a signed local macOS build:

```sh
./scripts/release-macos.sh aarch64   # or x86_64, or both
```

Do not move a published tag. Fix an incorrect release forward with a new patch
version.

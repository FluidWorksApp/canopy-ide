# Releasing Canopy

## Platforms

macOS and Linux are wired. Windows and the Homebrew cask are not done yet.

Tauri cannot cross-compile between operating systems — the linkers and the
system webview are native — so each OS builds on its own runner. There is no
way to produce the Windows or Linux build from a Mac.

| Platform | Artifacts | Self-updates? |
|---|---|---|
| macOS arm64 / x86_64 | `.app`, `.dmg`, `.app.tar.gz` + `.sig` | yes |
| Linux x86_64 | `.AppImage`, `.deb`, `.rpm` | **AppImage only** |

`.deb`/`.rpm` have no auto-update path: on those systems the package manager
owns updates, and fighting it corrupts installs.

## Identities and keys

| Thing | Value | Where it lives |
|---|---|---|
| Apple team | `5Y96U6L594` | — |
| Signing identity | `Developer ID Application: Ravichandran Raman (5Y96U6L594)` | login keychain, valid to Feb 2031 |
| Notary credentials | keychain profile `AC_PASSWORD` | login keychain |
| Updater signing key | `~/.tauri/canopy.key` (chmod 600, **no password**) | **not in the repo** |
| Updater public key | `plugins.updater.pubkey` | `src-tauri/tauri.conf.json` |

**If the updater private key is lost, every installed copy is permanently
un-updatable.** There is no recovery: the public key is compiled into every
copy already shipped. Keep a backup outside this machine.

The app currently signs as *Ravichandran Raman* (an individual Developer ID)
while the licence names *Cause Connect Pte Ltd*. Moving to an Organization
account needs a D-U-N-S number for the company.

## Local signed build

```sh
./scripts/release-macos.sh aarch64   # or x86_64, or both
```

It preflights the signing identity, the updater key, and the notary
credentials before spending a build, then signs, notarises, staples, and runs
a Gatekeeper assessment.

## Release via CI

Push a tag:

```sh
git tag v0.1.0 && git push --tags
```

`.github/workflows/release.yml` builds macOS (both arches) and Linux and
creates a **draft** release. Review it, then publish.

You can also run it from the Actions tab (`workflow_dispatch`) to get build
artifacts without cutting a release.

### Required secrets

| Secret | Consequence if missing |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | build **fails** (by design — see below) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | set it to an empty string; the key has no password |
| `APPLE_CERTIFICATE` | `.p12`, base64-encoded. Unsigned build → Gatekeeper blocks it on every Mac but this one |
| `APPLE_CERTIFICATE_PASSWORD` | password used when exporting the `.p12` |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: Ravichandran Raman (5Y96U6L594)` |
| `APPLE_ID` | the Apple account email |
| `APPLE_PASSWORD` | an **app-specific** password from appleid.apple.com, not the account password |
| `APPLE_TEAM_ID` | `5Y96U6L594` |

Export the certificate for CI (Keychain Access → right-click the Developer ID
Application cert → Export → .p12), then:

```sh
base64 -i Certificates.p12 | pbcopy   # paste into the APPLE_CERTIFICATE secret
```

## Gotchas that cost real time

- **`tauri build` exits 0 when updater signing fails.** It prints "a public key
  has been found, but no private key" and produces no `.sig`, with a green exit
  code. A release built that way looks fine and silently refuses to update every
  installed copy. Both the CI workflow and `release-macos.sh` assert a `.sig`
  exists rather than trust the exit code.
- **`TAURI_SIGNING_PRIVATE_KEY_PATH` does not work; the string form does.** Use
  `TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/canopy.key)"`.
- **The key has an empty password and tauri still prompts for it.** On a non-TTY
  that fails as `Device not configured (os error 6)`. Always set
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""`.
- **The hook helper is a second `[[bin]]` that no tauri command builds.**
  `scripts/prepare-sidecar.mjs` builds it and stages it as a sidecar, and it
  builds for an explicit `--target`: CI cross-compiles the Intel Mac build on an
  arm64 runner, so building for the host would put an arm64 helper inside an
  x86_64 app — failing only on a user's Intel Mac, at runtime, as agent hooks
  that silently do nothing.
- **Notarisation returning 403 "a required agreement is missing or has
  expired"** is an account-level problem, not a build one. Sign the pending
  agreement at <https://appstoreconnect.apple.com> → Business/Agreements. It
  blocks every app on the team.
- **Linux builds on ubuntu-22.04, not latest.** The glibc you build against is
  the *floor* for what users can run.
- **The updater endpoint needs the repo to be public.** GitHub release assets on
  a private repo require an auth header the updater does not send, so every
  update check 404s while `FluidWorksApp/canopy-ide` stays private.

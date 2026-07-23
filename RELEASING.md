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

The version lives in three files that must agree — `package.json`,
`src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json` — and the tag must match
them (the release name and `.dmg` filenames come from the config version, not
the tag). `scripts/bump-version.sh` keeps all four in sync:

```sh
./scripts/bump-version.sh 0.2.0   # bumps all three files, commits, tags v0.2.0
git push && git push --tags       # <- this triggers the release build
```

`.github/workflows/release.yml` builds macOS (both arches) and Linux and
creates a **draft** release. The draft is the QA gate: download the `.dmg`,
open it, check the asset list (installers + `latest.json` + `.sig`s + the
stable aliases below) — then publish. Publishing is the moment installed
copies start auto-updating to it.

You can also run the workflow from the Actions tab (`workflow_dispatch`) to
get a full signed build without cutting a release — it prints
"No releaseId or tagName provided, skipping all uploads", which is the
dry-run working as intended.

### Stable download URLs

The workflow uploads a version-less alias of every installer, because
`releases/latest/download/<name>` only resolves names that are identical in
every release. canopyide.dev and the README hardcode these; renaming one
breaks every published link:

| Alias | Points at |
|---|---|
| `Canopy-macos-arm64.dmg` | macOS Apple Silicon `.dmg` |
| `Canopy-linux-x86_64.AppImage` | Linux AppImage |
| `Canopy-linux-x86_64.deb` / `.rpm` | Linux packages |
| `Canopy-windows-x86_64-setup.exe` | reserved for the Windows installer |

Full URL form:
`https://github.com/FluidWorksApp/canopy-ide/releases/latest/download/<alias>`
— always the newest **published** release; drafts don't count, so links keep
serving the previous release until you hit Publish.

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

Export and validate all of these with one command — it finds the identity,
exports the `.p12`, dry-runs the exact import CI performs, and (with `--set`)
pushes the secrets via `gh`:

```sh
./scripts/export-signing-secrets.sh --set
```

The `.p12` may contain other identities besides the Developer ID one — that's
fine. CI imports the keychain itself and signs by the `APPLE_SIGNING_IDENTITY`
name; it does **not** hand the certificate to Tauri, whose importer rejects
multi-identity `.p12`s.

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
  builds for an explicit `--target` so the helper's arch always matches the app
  it ships inside. A host-arch build would put the wrong helper in a
  cross-compiled app — failing only at runtime, as agent hooks that silently do
  nothing.
- **Notarisation returning 403 "a required agreement is missing or has
  expired"** is an account-level problem, not a build one. Sign the pending
  agreement at <https://appstoreconnect.apple.com> → Business/Agreements. It
  blocks every app on the team.
- **Linux builds on ubuntu-22.04, not latest.** The glibc you build against is
  the *floor* for what users can run.
- **The updater endpoint needs the repo to be public.** GitHub release assets on
  a private repo require an auth header the updater does not send, so every
  update check 404s while `FluidWorksApp/canopy-ide` stays private.

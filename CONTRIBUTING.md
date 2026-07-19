# Contributing to Canopy

Thanks for your interest — issues, ideas, and pull requests are all welcome.
Canopy is a small, readable codebase and a good project to hack on.

## Getting set up

Prerequisites: **Rust** (stable) and **Node 20+**.

```sh
npm install
npm run tauri dev      # dev build with hot reload (or: npx tauri dev)
```

The first run compiles the Rust core and takes a few minutes; after that the
frontend hot-reloads and rebuilds are fast.

For TypeScript language features while developing, install the language server
globally (`npm i -g typescript-language-server typescript`) or have it in the
opened project's `node_modules`.

## Before you open a pull request

All of these should pass:

```sh
npm run typecheck    # tsc -b — the root tsconfig is solution-style, so this is
                     # the real type check (plain `tsc --noEmit` checks nothing)
npm run lint         # oxlint
npm run build        # tsc -b && vite build
cargo build --manifest-path src-tauri/Cargo.toml
```

Keep pull requests focused — one logical change per PR is easiest to review.
Explain the *why* in the description; link any related issue.

## Where things live

| Path | What |
|---|---|
| `src/` | React + Vite frontend (components, IPC wrappers, editor) |
| `src-tauri/src/` | Rust core — `pty.rs`, `lsp.rs`, `fsx.rs`, `git.rs`, `agents.rs` |
| `src-tauri/src/bin/canopy_hook.rs` | the agent-hook helper (a second binary) |
| `packages/ui/` | shared UI primitives (`@canopy/ui`) |
| `scripts/` | sidecar build + release tooling |
| `SPEC.md` | the full product spec |
| `RELEASING.md` | how signed releases are cut |

## House style

- **Match the surrounding code** — naming, formatting, and idiom.
- **Comments explain constraints and *why*, not *what*.** The codebase leans on
  this heavily; it's part of what keeps it approachable. A comment that restates
  the code is noise.
- **Rust owns all native processes** (PTYs, LSP servers, watchers). The frontend
  never spawns anything itself — it goes through a Tauri command.
- **Raw bytes end-to-end** on the terminal path; no filtering or normalization.

## Reporting bugs and requesting features

Use the issue templates. For bugs, include your OS, the app version, and steps
to reproduce. For security issues, see [SECURITY.md](./SECURITY.md) — please
report those privately rather than opening an issue.

## License

By contributing, you agree that your contributions are licensed under the
project's [MIT License](./LICENSE.md).

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
npm run test         # vitest — frontend unit + component tests
npm run build        # tsc -b && vite build
cargo test --manifest-path src-tauri/Cargo.toml --no-default-features
```

CI (`.github/workflows/ci.yml`) runs the same checks on every pull request, so a
green local run is a green PR. `--no-default-features` compiles dictation (the
ONNX stack) out — the tests don't touch it and it keeps the build fast, matching
what CI runs.

Keep pull requests focused — one logical change per PR is easiest to review.
Explain the *why* in the description; link any related issue.

## Tests are test-first

Canopy is written test-first, and new behaviour should arrive with a test.

- **Write the failing test first**, watch it fail, then make it pass, then
  refactor. A test you've never seen fail is a test that might assert nothing.
- **Put logic in a framework-free module and test it directly.** `src/collab-ot.ts`
  is the model: the operational-transform core lives apart from Monaco/DOM/relay
  precisely so it can be exercised in isolation — a wrong transform diverges two
  buffers *silently*, so it is fuzzed (`scripts/collab-fuzz.mjs`) and unit-tested
  (`src/collab-ot.test.ts`) rather than eyeballed. Prefer this shape over reaching
  into a 1,000-line component for the one pure function you actually changed.
- **Where tests live.** Frontend: a `*.test.ts` / `*.test.tsx` next to the file
  under test (Vitest + Testing Library; jsdom and the Tauri IPC boundary are
  mocked in `src/test/setup.ts` — use `mockCommands({...})` for a command a test
  needs). Rust: a `#[cfg(test)] mod tests` at the bottom of the module, same as
  `git.rs`, `relay.rs` and `cli.rs` already do.
- **Test behaviour, not implementation** — what a user or caller observes, so the
  test survives a refactor.

Run one file while iterating:

```sh
npm run test:watch -- src/collab-ot.test.ts     # frontend, re-runs on save
cargo test --manifest-path src-tauri/Cargo.toml --no-default-features git::tests
```

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

// Builds the sidecars the app ships (the hook helper and the PTY host) and
// stages them as Tauri externalBin entries.
//
// The helper uses its independent agent-hook crate, keeping Tauri application
// resources and GUI dependencies out of its link. Neither `tauri dev` nor
// `tauri build` builds that crate automatically — so without this the app
// starts up, fails to install the helper, and registers agent hooks pointing at
// a binary that does not exist. That failure is invisible: Claude never reports
// a hook that won't execute.
//
// Always builds for an explicit --target so the helper's arch matches the app
// it ships inside. Building for the host arch instead would stage the wrong
// helper in any cross-compiled app — a mismatch that surfaces only at runtime,
// as hooks that silently do nothing.
//
// Tauri resolves externalBin entries by appending the target triple, then drops
// the file next to the app binary (Canopy.app/Contents/MacOS/canopy-hook),
// which is exactly where install_hook_helper() looks.
//
// canopy-pty-host is the detached process that owns hosted terminals. It is a
// member of the src-tauri workspace but is built through its own manifest, so
// tauri-build never runs for it either. The app installs a copy of it outside
// the bundle at runtime (src-tauri/src/pty_hosted/install.rs), so an update
// that replaces the bundle never deletes the binary a running host came from.
// On Windows it is the named-pipe host (the app does not launch it there yet);
// it is staged so every bundle has it.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const release = process.argv.includes("--release");
const profile = release ? "release" : "debug";

// Every externalBin entry in src-tauri/tauri.conf.json, with the crate that
// builds it.
const SIDECARS = [
  { name: "canopy-hook", manifest: join(root, "packages", "agent-hook", "Cargo.toml") },
  { name: "canopy-pty-host", manifest: join(root, "crates", "canopy-pty-host", "Cargo.toml") },
];

const hostTriple = () =>
  execFileSync("rustc", ["-vV"], { encoding: "utf8" })
    .split("\n")
    .find((l) => l.startsWith("host:"))
    ?.slice(5)
    .trim();

// TAURI_ENV_TARGET_TRIPLE is set by Tauri when it runs beforeBuildCommand, and
// is the target the app itself is being built for.
const triple = process.env.TAURI_ENV_TARGET_TRIPLE || hostTriple();
if (!triple) {
  console.error("prepare-sidecar: could not determine target triple");
  process.exit(1);
}

const ext = triple.includes("-windows-") ? ".exe" : "";
const destDir = join(root, "src-tauri", "binaries");

// No placeholder is needed: neither crate runs tauri-build or validates the
// application's externalBin before it exists.
mkdirSync(destDir, { recursive: true });

for (const { name, manifest } of SIDECARS) {
  const dest = join(destDir, `${name}-${triple}${ext}`);

  // Ask cargo where it put the binary rather than assuming
  // src-tauri/target/<triple>/<profile>/. A `[build] target-dir` in any
  // .cargo/config.toml — or CARGO_TARGET_DIR — relocates the whole output tree,
  // and this repo's worktrees share one build cache that way. Guessing the
  // layout makes the build fail right after a successful compile.
  const args = [
    "build",
    "--manifest-path",
    manifest,
    "--bin",
    name,
    "--target",
    triple,
    "--message-format",
    "json-render-diagnostics",
  ];
  if (release) args.push("--release");
  console.log(`prepare-sidecar: cargo ${args.join(" ")}`);
  // json-render-diagnostics keeps warnings and progress human-readable on
  // stderr; only the artifact stream needs capturing.
  const out = execFileSync("cargo", args, {
    encoding: "utf8",
    stdio: ["inherit", "pipe", "inherit"],
    maxBuffer: 256 * 1024 * 1024,
  });

  let src = null;
  for (const line of out.split("\n")) {
    if (!line.startsWith("{")) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.reason === "compiler-artifact" && msg.executable && msg.target?.name === name) {
      src = msg.executable;
    }
  }

  // Fall back to the default layout: a fully cached build still reports the
  // artifact, but don't let an unexpected message stream be fatal on its own.
  if (!src) {
    const metadata = JSON.parse(execFileSync("cargo", ["metadata", "--manifest-path", manifest, "--no-deps", "--format-version", "1"], {encoding:"utf8"}));
    src = join(metadata.target_directory, triple, profile, `${name}${ext}`);
  }

  if (!existsSync(src) || !statSync(src).isFile() || statSync(src).size === 0) {
    console.error(`prepare-sidecar: expected ${src} after build`);
    process.exit(1);
  }

  copyFileSync(src, dest);
  console.log(`prepare-sidecar: staged ${dest} (${profile}, ${triple})`);

  if (name === "canopy-pty-host" && release && triple.includes("-apple-darwin")) {
    stageSignedHost(dest);
  }
}

// tauri-bundler signs every externalBin entry with the app's own entitlements
// (JIT, library-validation off, DYLD variables, microphone), one set for every
// binary and no per-binary setting. The PTY host is a long-lived process that
// needs none of them, so for macOS release builds it is not an externalBin:
// this stages a copy signed here with src-tauri/pty-host-entitlements.plist, and
// src-tauri/tauri.release-macos.conf.json (passed with --config by the release
// build) places that copy at Contents/MacOS/canopy-pty-host. The bundler signs
// only frameworks, externalBin and the app itself, never `macOS.files`, so
// this signature is the one that ships.
//
// With APPLE_SIGNING_IDENTITY unset the copy is staged unsigned, so a build
// without signing still produces a complete bundle.
function stageSignedHost(unsigned) {
  const staged = join(destDir, "canopy-pty-host-signed");
  copyFileSync(unsigned, staged);
  const identity = process.env.APPLE_SIGNING_IDENTITY;
  if (!identity) {
    console.log("prepare-sidecar: APPLE_SIGNING_IDENTITY not set, staged the PTY host unsigned");
    return;
  }
  execFileSync(
    "codesign",
    [
      "--force",
      "--options",
      "runtime",
      "--timestamp",
      "--entitlements",
      join(root, "src-tauri", "pty-host-entitlements.plist"),
      "--sign",
      identity,
      staged,
    ],
    { stdio: "inherit" },
  );
  execFileSync("codesign", ["--verify", "--strict", staged], { stdio: "inherit" });
  console.log(`prepare-sidecar: signed ${staged} with its own entitlements`);
}

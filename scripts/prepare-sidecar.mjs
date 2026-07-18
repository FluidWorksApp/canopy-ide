// Builds the hook helper and stages it as a Tauri sidecar.
//
// The helper is a second [[bin]] in the same crate, and neither `tauri dev` nor
// `tauri build` builds anything but `default-run` — so without this the app
// starts up, fails to install the helper, and registers agent hooks pointing at
// a binary that does not exist. That failure is invisible: Claude never reports
// a hook that won't execute.
//
// Always builds for an explicit --target. CI cross-compiles the Intel macOS
// build on an arm64 runner, so building for the host would stage an arm64
// helper inside an x86_64 app — a mismatch that surfaces only on a user's Intel
// Mac, at runtime, as hooks that silently do nothing.
//
// Tauri resolves externalBin entries by appending the target triple, then drops
// the file next to the app binary (Canopy.app/Contents/MacOS/canopy-hook),
// which is exactly where install_hook_helper() looks.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = join(root, "src-tauri", "Cargo.toml");
const release = process.argv.includes("--release");
const profile = release ? "release" : "debug";

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

const ext = process.platform === "win32" ? ".exe" : "";
const destDir = join(root, "src-tauri", "binaries");
const dest = join(destDir, `canopy-hook-${triple}${ext}`);

// Bootstrap the sidecar's own existence check. Building --bin canopy-hook
// compiles the canopy crate, whose tauri build.rs validates that every
// externalBin (binaries/canopy-hook-<triple>) already exists — but that file is
// exactly what this build produces. On a fresh checkout binaries/ is empty (it
// is gitignored), so without a placeholder the build fails before it can ever
// create the binary: "resource path binaries/canopy-hook-<triple> doesn't
// exist". Stage an empty placeholder first to satisfy the check; the real
// binary overwrites it below. (Locally this is invisible because a prior build
// already left the file in place.)
mkdirSync(destDir, { recursive: true });
if (!existsSync(dest)) writeFileSync(dest, "");

const args = ["build", "--manifest-path", manifest, "--bin", "canopy-hook", "--target", triple];
if (release) args.push("--release");
console.log(`prepare-sidecar: cargo ${args.join(" ")}`);
execFileSync("cargo", args, { stdio: "inherit" });

// Passing --target always nests output under target/<triple>/<profile>/.
const src = join(root, "src-tauri", "target", triple, profile, `canopy-hook${ext}`);
if (!existsSync(src)) {
  console.error(`prepare-sidecar: expected ${src} after build`);
  process.exit(1);
}

copyFileSync(src, dest);
console.log(`prepare-sidecar: staged ${dest} (${profile}, ${triple})`);

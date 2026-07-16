// Stages the hook helper as a Tauri sidecar.
//
// The helper is a second [[bin]] in the same crate, and neither `tauri dev` nor
// `tauri build` builds anything but `default-run` — so without this the app
// starts up, fails to install the helper, and registers agent hooks pointing at
// a binary that does not exist. That failure is invisible: Claude never reports
// a hook that won't execute.
//
// Tauri resolves externalBin entries by appending the target triple, then drops
// the file next to the app binary (Canopy.app/Contents/MacOS/canopy-hook),
// which is exactly where install_hook_helper() looks.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const release = process.argv.includes("--release");
const profile = release ? "release" : "debug";

// Honour the triple Tauri is actually building for (cross-compiles, universal
// builds); fall back to this host's triple.
const triple =
  process.env.TAURI_ENV_TARGET_TRIPLE ??
  execFileSync("rustc", ["-vV"], { encoding: "utf8" })
    .split("\n")
    .find((l) => l.startsWith("host:"))
    ?.slice(5)
    .trim();

if (!triple) {
  console.error("prepare-sidecar: could not determine target triple");
  process.exit(1);
}

const ext = process.platform === "win32" ? ".exe" : "";
const src = join(root, "src-tauri", "target", profile, `canopy-hook${ext}`);
if (!existsSync(src)) {
  console.error(`prepare-sidecar: ${src} not built — run the cargo build first`);
  process.exit(1);
}

const destDir = join(root, "src-tauri", "binaries");
mkdirSync(destDir, { recursive: true });
const dest = join(destDir, `canopy-hook-${triple}${ext}`);
copyFileSync(src, dest);
console.log(`prepare-sidecar: ${profile} -> ${dest}`);

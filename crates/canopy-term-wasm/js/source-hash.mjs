// One hash over everything the wasm build is made from. The app ships a
// prebuilt copy of the engine (shared/terminalEngine/pkg, built by CI's
// "Terminal engine (wasm)" job, so that building the frontend needs neither
// Rust nor Zig); shared/terminalEngine/pkg/SOURCE_HASH records the sources that
// copy was built from. CI fails when they no longer match.
//
//   node crates/canopy-term-wasm/js/source-hash.mjs            print the hash
//   node crates/canopy-term-wasm/js/source-hash.mjs --check    compare with SOURCE_HASH
//   node crates/canopy-term-wasm/js/source-hash.mjs --write    record it
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const stamp = join(root, "shared/terminalEngine/pkg/SOURCE_HASH");
const inputs = [
  "crates/canopy-term-core/src",
  "crates/canopy-term-core/Cargo.toml",
  "crates/canopy-term-input/src",
  "crates/canopy-term-input/Cargo.toml",
  "crates/canopy-term-wasm/src",
  "crates/canopy-term-wasm/vendor",
  "crates/canopy-term-wasm/build.rs",
  "crates/canopy-term-wasm/Cargo.toml",
  "crates/canopy-term-wasm/Cargo.lock",
  // The pinned Ghostty revision and Zig version.
  ".github/actions/ghostty-vendor/pins.env",
];

function files(path) {
  const full = join(root, path);
  if (!statSync(full).isDirectory()) return [path];
  return readdirSync(full, { withFileTypes: true })
    .filter((entry) => entry.name !== "target" && !entry.name.startsWith("."))
    .flatMap((entry) => files(join(path, entry.name)));
}

const hash = createHash("sha256");
for (const file of inputs.flatMap(files).sort()) {
  hash.update(relative(root, join(root, file)).split(sep).join("/"));
  hash.update("\0");
  // Line endings must not change the answer between checkouts.
  hash.update(readFileSync(join(root, file)).toString("latin1").replace(/\r\n/g, "\n"), "latin1");
  hash.update("\0");
}
const digest = hash.digest("hex");

const mode = process.argv[2];
if (mode === "--write") {
  writeFileSync(stamp, `${digest}\n`);
  console.log(`recorded ${digest}`);
} else if (mode === "--check") {
  const recorded = readFileSync(stamp, "utf8").trim();
  if (recorded !== digest) {
    console.error(
      [
        "The bundled terminal engine is stale.",
        `  shared/terminalEngine/pkg was built from sources ${recorded}`,
        `  the sources are now                         ${digest}`,
        "Take pkg-web from this job's canopy-term-wasm artifact, copy it over",
        "shared/terminalEngine/pkg, run this script with --write, and commit both.",
        "(scripts/update-terminal-engine.sh does all three from a CI run.)",
      ].join("\n"),
    );
    process.exit(1);
  }
  console.log(`bundled engine matches its sources (${digest})`);
} else {
  console.log(digest);
}

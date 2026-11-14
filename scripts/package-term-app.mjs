// Packages the standalone Canopy Terminal download (canopy-term-app plus the
// canopy-pty-host it starts) for the release page:
//
//   macOS Apple silicon   Canopy-Terminal-macos-arm64.zip
//       one `Canopy Terminal.app` (own bundle id, icon from the app); signed with
//       the hardened runtime and a secure timestamp, notarized and stapled when
//       asked to
//   Linux x86_64          Canopy-Terminal-linux-x86_64.tar.gz
//       canopy-term-app, canopy-pty-host, README.txt, LICENSE.md; not signed
//
// and `<asset>.sha256` beside each (sha256sum format). Windows is not packaged:
// the terminal app has no host launch there. Intel macOS is not packaged either
// (the release builds it only inside the IDE).
//
//   node scripts/package-term-app.mjs --target <triple> --version <x.y.z> \
//     --term-app <binary> --host <binary> --out <dir> [--sign] [--notarize]
//
// Without --sign nothing is signed and the script says so: that is the
// secret-free dry run, which proves the layout and the archives only. --sign
// needs APPLE_SIGNING_IDENTITY (a Developer ID Application identity already in
// the keychain). --notarize (implies --sign) needs APPLE_ID, APPLE_PASSWORD and
// APPLE_TEAM_ID, the same secrets tauri-action uses for the IDE.
//
// Signing follows scripts/prepare-sidecar.mjs: hardened runtime, secure
// timestamp, and no entitlements at all for either binary
// (src-tauri/term-app-entitlements.plist, src-tauri/pty-host-entitlements.plist).
// The host is signed first with its own plist, then the bundle (which seals and
// signs the app's main executable). No --deep: every piece is signed on purpose.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export const MAC_TARGET = "aarch64-apple-darwin";
export const LINUX_TARGET = "x86_64-unknown-linux-gnu";
export const APP_NAME = "Canopy Terminal";
export const APP_EXE = "canopy-term-app";
export const HOST_EXE = "canopy-pty-host";

/** The release asset name for `target`, or throws for a target with none. */
export function assetName(target) {
  if (target === MAC_TARGET) return "Canopy-Terminal-macos-arm64.zip";
  if (target === LINUX_TARGET) return "Canopy-Terminal-linux-x86_64.tar.gz";
  throw new Error(
    `no standalone terminal download for ${target} (macOS arm64 and Linux x86_64 only)`,
  );
}

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The app's identifier with `.terminal` appended: a sibling bundle id. */
export const bundleId = (appIdentifier) => `${appIdentifier}.terminal`;

export function infoPlist({ version, identifier, minimumSystemVersion, copyright }) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`invalid version ${version}`);
  const rows = [
    ["CFBundleDevelopmentRegion", "en"],
    ["CFBundleExecutable", APP_EXE],
    ["CFBundleIconFile", "icon"],
    ["CFBundleIdentifier", bundleId(identifier)],
    ["CFBundleInfoDictionaryVersion", "6.0"],
    ["CFBundleName", APP_NAME],
    ["CFBundleDisplayName", APP_NAME],
    ["CFBundlePackageType", "APPL"],
    ["CFBundleShortVersionString", version],
    ["CFBundleVersion", version],
    ["LSApplicationCategoryType", "public.app-category.developer-tools"],
    ["LSMinimumSystemVersion", minimumSystemVersion],
    ["NSHumanReadableCopyright", copyright],
  ];
  const body = rows
    .map(([k, v]) => `\t<key>${k}</key>\n\t<string>${esc(v)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${body}
\t<key>NSHighResolutionCapable</key>
\t<true/>
</dict>
</plist>
`;
}

export function readme({ version, os }) {
  const start =
    os === "macos"
      ? `Open "${APP_NAME}.app". The first time, macOS asks you to confirm that it was\ndownloaded from the internet; it is signed and notarized, so the dialog\nhas an Open button and no malware warning.`
      : `Run ./${APP_EXE} from this folder (or copy both programs to a directory on your PATH).\nIt needs a display (X11 or Wayland) and Vulkan or OpenGL drivers.`;
  return `Canopy Terminal ${version} (beta)

A native terminal window for Canopy's persistent terminal host. It works on its
own; the Canopy IDE is not needed.

${start}

Files
  ${APP_EXE}   the window
  ${HOST_EXE}    the host that keeps terminals running after the window closes;
                      the window starts it for you (a copy is kept in
                      ~/.canopy/pty-host/term-app-bin/) and it exits a minute
                      after the last terminal is closed or killed

Sharing with the Canopy IDE
  Both use ~/.canopy/pty-host/host.sock. They share one host only when they are
  the same version (${version}). A host started by a different version is stopped and
  replaced if it has no terminals; if it still has terminals, ${APP_EXE} says so and
  leaves it alone. Pass --socket <path> to use a separate host.

Run ./${APP_EXE} --help for the options. Source and issues:
https://github.com/FluidWorksApp/canopy-ide

MIT licensed; see LICENSE.md.
`;
}

/** `<hex>  <name>\n`, what `sha256sum` writes and `shasum -a 256 -c` reads. */
export function sha256Line(bytes, name) {
  return `${createHash("sha256").update(bytes).digest("hex")}  ${name}\n`;
}

const run = (cmd, args, opts = {}) => {
  console.log(`+ ${cmd} ${args.join(" ")}`);
  return execFileSync(cmd, args, { stdio: "inherit", ...opts });
};

function need(path, what) {
  if (!existsSync(path) || !statSync(path).isFile() || statSync(path).size === 0) {
    throw new Error(`${what} is missing or empty: ${path}`);
  }
  return path;
}

function writeChecksum(asset) {
  const out = `${asset}.sha256`;
  writeFileSync(out, sha256Line(readFileSync(asset), basename(asset)));
  return out;
}

function stageLinux({ version, termApp, host, stage }) {
  mkdirSync(stage, { recursive: true });
  for (const [src, name] of [
    [termApp, APP_EXE],
    [host, HOST_EXE],
  ]) {
    copyFileSync(src, join(stage, name));
    chmodSync(join(stage, name), 0o755);
  }
  writeFileSync(join(stage, "README.txt"), readme({ version, os: "linux" }));
  copyFileSync(join(root, "LICENSE.md"), join(stage, "LICENSE.md"));
}

function packageLinux({ version, termApp, host, out }) {
  const asset = join(out, assetName(LINUX_TARGET));
  const work = mkdtempSync(join(tmpdir(), "canopy-term-linux-"));
  try {
    const dir = `canopy-terminal-${version}-linux-x86_64`;
    stageLinux({ version, termApp, host, stage: join(work, dir) });
    // Owner and group are normalised where GNU tar can (the Linux runner).
    const gnu = /GNU tar/.test(execFileSync("tar", ["--version"], { encoding: "utf8" }));
    const own = gnu ? ["--owner=0", "--group=0", "--numeric-owner"] : [];
    run("tar", [...own, "-czf", asset, "-C", work, dir]);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return asset;
}

function readAppConfig() {
  const c = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8"));
  return {
    identifier: c.identifier,
    minimumSystemVersion: c.bundle.macOS.minimumSystemVersion,
    copyright: c.bundle.copyright,
  };
}

function packageMac({ version, termApp, host, out, sign, notarize, env }) {
  const asset = join(out, assetName(MAC_TARGET));
  const work = mkdtempSync(join(tmpdir(), "canopy-term-mac-"));
  try {
    const app = join(work, `${APP_NAME}.app`);
    const macos = join(app, "Contents", "MacOS");
    const resources = join(app, "Contents", "Resources");
    mkdirSync(macos, { recursive: true });
    mkdirSync(resources, { recursive: true });
    for (const [src, name] of [
      [termApp, APP_EXE],
      [host, HOST_EXE],
    ]) {
      copyFileSync(src, join(macos, name));
      chmodSync(join(macos, name), 0o755);
    }
    copyFileSync(
      need(join(root, "src-tauri", "icons", "icon.icns"), "the app icon"),
      join(resources, "icon.icns"),
    );
    writeFileSync(
      join(app, "Contents", "Info.plist"),
      infoPlist({ version, ...readAppConfig() }),
    );
    writeFileSync(join(app, "Contents", "PkgInfo"), "APPL????");

    if (sign) {
      const id = env.APPLE_SIGNING_IDENTITY;
      const common = ["--force", "--options", "runtime", "--timestamp", "--sign", id];
      run("codesign", [
        ...common,
        "--entitlements",
        join(root, "src-tauri", "pty-host-entitlements.plist"),
        join(macos, HOST_EXE),
      ]);
      run("codesign", [
        ...common,
        "--entitlements",
        join(root, "src-tauri", "term-app-entitlements.plist"),
        app,
      ]);
      run("codesign", ["--verify", "--strict", "--verbose=2", join(macos, HOST_EXE)]);
      run("codesign", ["--verify", "--strict", "--verbose=2", app]);
    } else {
      console.log("package-term-app: UNSIGNED (no --sign): not for distribution.");
    }

    const zip = (dest) => run("ditto", ["-c", "-k", "--keepParent", app, dest]);
    if (notarize) {
      const submit = join(work, "submit.zip");
      zip(submit);
      // notarytool exits 0 on a rejected submission too: read the status.
      const raw = execFileSync(
        "xcrun",
        [
          "notarytool",
          "submit",
          submit,
          "--apple-id",
          env.APPLE_ID,
          "--password",
          env.APPLE_PASSWORD,
          "--team-id",
          env.APPLE_TEAM_ID,
          "--wait",
          "--timeout",
          "30m",
          "--output-format",
          "json",
        ],
        { encoding: "utf8" },
      );
      console.log(raw);
      const result = JSON.parse(raw);
      if (result.status !== "Accepted") {
        if (result.id) {
          run("xcrun", [
            "notarytool",
            "log",
            result.id,
            "--apple-id",
            env.APPLE_ID,
            "--password",
            env.APPLE_PASSWORD,
            "--team-id",
            env.APPLE_TEAM_ID,
          ]);
        }
        throw new Error(`notarization was not accepted: ${result.status}`);
      }
      run("xcrun", ["stapler", "staple", app]);
      run("xcrun", ["stapler", "validate", app]);
    } else if (sign) {
      console.log("package-term-app: signed but NOT NOTARIZED (no --notarize): Gatekeeper will block it.");
    } else {
      console.log("package-term-app: notarization skipped (not signed).");
    }
    rmSync(asset, { force: true });
    zip(asset);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return asset;
}

export function parseArgs(argv) {
  const o = { sign: false, notarize: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--sign") o.sign = true;
    else if (a === "--notarize") o.notarize = o.sign = true;
    else if (["--target", "--version", "--term-app", "--host", "--out"].includes(a)) {
      const v = argv[++i];
      if (!v) throw new Error(`${a} needs a value`);
      o[a.slice(2).replace("-a", "A")] = v;
    } else throw new Error(`unknown argument ${a}`);
  }
  for (const k of ["target", "version", "termApp", "host", "out"]) {
    if (!o[k]) throw new Error(`--${k.replace("A", "-a").toLowerCase()} is required`);
  }
  return o;
}

export function packageTermApp(o, env = process.env) {
  const out = resolve(o.out);
  const name = assetName(o.target);
  if (o.sign && o.target !== MAC_TARGET) throw new Error("only the macOS app is signed");
  if (o.sign && !env.APPLE_SIGNING_IDENTITY) {
    throw new Error("--sign needs APPLE_SIGNING_IDENTITY");
  }
  if (o.notarize) {
    for (const k of ["APPLE_ID", "APPLE_PASSWORD", "APPLE_TEAM_ID"]) {
      if (!env[k]) throw new Error(`--notarize needs ${k}`);
    }
  }
  const termApp = resolve(need(o.termApp, APP_EXE));
  const host = resolve(need(o.host, HOST_EXE));
  mkdirSync(out, { recursive: true });
  const args = { version: o.version, termApp, host, out, sign: o.sign, notarize: o.notarize, env };
  const asset = o.target === MAC_TARGET ? packageMac(args) : packageLinux(args);
  const sum = writeChecksum(asset);
  console.log(`package-term-app: wrote ${asset} (${statSync(asset).size} bytes) and ${sum}`);
  return { asset, sum, name };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    packageTermApp(parseArgs(process.argv.slice(2)));
  } catch (e) {
    console.error(`package-term-app: ${e.message}`);
    process.exit(1);
  }
}

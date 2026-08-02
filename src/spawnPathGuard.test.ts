// If this goes red, something new execs a binary by bare name.
//
// The bug class, which cost a whole afternoon before it was named: a GUI app on
// macOS is started by launchd, not by a shell, so it inherits
// `/usr/bin:/bin:/usr/sbin:/sbin` and nothing else. Every child it spawns
// inherits that. `node`, `npx`, `gh`, `adb` and every agent CLI live in
// /opt/homebrew/bin or a version manager's shims, and none of those are on it.
//
// What makes it expensive is that it is invisible in development. `pnpm tauri
// dev` is started from a terminal, so the dev build has the user's real PATH
// and everything works. The installed build fails on the same machine, same
// binary, same config. "Works locally, broken in the app" is the signature, and
// it reaches users rather than CI.
//
// Two ways to be safe, and a spawn must use one:
//
//   * go through a login shell (`$SHELL -lc …`), like pty.rs and agents.rs — a
//     login shell reads the profile that builds PATH in the first place;
//   * or resolve the binary through procenv.rs, and hand the child
//     `child_path()` so the things IT spawns can be found too.
//
// A bare name execed directly is neither. If you are adding one, the fix is
// `crate::procenv::resolve_command`, not an entry in the allowlist below.
/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const RUST = join(process.cwd(), "src-tauri", "src");

/** Binaries a machine has no matter how the process was started — the ones in
 *  the minimal PATH launchd hands a GUI app. Verified by running
 *  `env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin command -v <name>`; anything not
 *  on that list has to be resolved. */
const ALWAYS_PRESENT = new Set([
  "sh",
  "cp",
  "git",
  "curl",
  "open",
  "osascript",
  "lsof",
  "launchctl",
  "java",
  // Not unix, so not this problem — Windows children inherit PATH from the
  // registry however they were launched.
  "explorer",
  "xdg-open",
  "where",
]);

function rustFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return rustFiles(path);
    return e.isFile() && e.name.endsWith(".rs") ? [path] : [];
  });
}

interface Spawn {
  file: string;
  line: number;
  target: string;
}

/** Every `Command::new("literal")` in the Rust sources. Only string literals:
 *  a variable is a resolved path, a detected SDK binary or a shell, all of
 *  which are the safe shapes. */
function literalSpawns(): Spawn[] {
  const out: Spawn[] = [];
  for (const file of rustFiles(RUST)) {
    const text = readFileSync(file, "utf8");
    text.split("\n").forEach((line, i) => {
      const m = /Command::new\("([^"]+)"\)/.exec(line);
      if (!m) return;
      out.push({ file: file.slice(RUST.length + 1), line: i + 1, target: m[1] });
    });
  }
  return out;
}

describe("no spawn relies on a PATH a GUI app does not have", () => {
  it("execs only binaries that exist in the minimal launchd PATH", () => {
    const risky = literalSpawns().filter(
      (s) => !s.target.startsWith("/") && !ALWAYS_PRESENT.has(s.target),
    );
    expect(
      risky.map((s) => `${s.file}:${s.line} Command::new("${s.target}")`),
      "resolve these through crate::procenv::resolve_command — a GUI-launched " +
        "app cannot find them, and this fails only in the installed build",
    ).toEqual([]);
  });

  it("finds the spawn sites at all, so a rename cannot silently pass it", () => {
    // A guard that scans nothing is a guard that always passes.
    expect(literalSpawns().length).toBeGreaterThan(10);
  });
});

describe("procenv is the one place that answers this", () => {
  const procenv = readFileSync(join(RUST, "procenv.rs"), "utf8");

  it("resolves a bare name through a login shell", () => {
    expect(procenv).toContain("fn resolve_command");
    expect(procenv).toContain('"-lc"');
  });

  it("hands the child a PATH as well as a resolved binary", () => {
    // Resolving alone gets an agent CLI started and leaves it unable to run
    // git — the failure then reads as the agent's fault, not the app's.
    expect(procenv).toContain("fn child_path");
    expect(procenv).toContain("fn login_path");
  });

  it("is used by the spawns that need it", () => {
    for (const file of ["companion.rs"]) {
      const text = readFileSync(join(RUST, file), "utf8");
      expect(text, `${file} should resolve through procenv`).toContain("procenv::");
    }
  });
});

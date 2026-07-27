import { describe, expect, it } from "vitest";
import {
  resolveNativeTsc,
  resolveServerRoot,
  resolveTypescriptLaunch,
  serverUnavailableMessage,
  specForPath,
  SERVERS,
} from "./servers";

const statter = (present: string[]) => {
  const set = new Set(present);
  return async (path: string) => set.has(path);
};

describe("specForPath", () => {
  it("picks a server by extension, case-insensitively", () => {
    expect(specForPath("/w/a.rs")?.id).toBe("rust");
    expect(specForPath("/w/a.PY")?.id).toBe("python");
    expect(specForPath("/w/a.tsx")?.id).toBe("typescript");
  });

  it("covers nothing it has no server for", () => {
    expect(specForPath("/w/README.md")).toBeUndefined();
    expect(specForPath("/w/Makefile")).toBeUndefined();
  });
});

describe("resolveServerRoot", () => {
  const rust = SERVERS.find((s) => s.id === "rust")!;

  it("walks up to the nearest Cargo.toml, not the project root", async () => {
    // The case this exists for: Canopy opens the repo, Cargo.toml is in src-tauri.
    const root = await resolveServerRoot(
      "/repo/src-tauri/src/lsp.rs",
      "/repo",
      rust,
      statter(["/repo/src-tauri/Cargo.toml"]),
    );
    expect(root).toBe("/repo/src-tauri");
  });

  it("stops at the project root rather than escaping it", async () => {
    const root = await resolveServerRoot(
      "/repo/crate/src/main.rs",
      "/repo",
      rust,
      statter(["/Cargo.toml", "/repo-outer/Cargo.toml"]),
    );
    expect(root).toBe("/repo");
  });

  it("prefers the deepest marker when a workspace nests", async () => {
    const root = await resolveServerRoot(
      "/repo/crates/inner/src/x.rs",
      "/repo",
      rust,
      statter(["/repo/Cargo.toml", "/repo/crates/inner/Cargo.toml"]),
    );
    expect(root).toBe("/repo/crates/inner");
  });

  it("uses the root itself when it holds the marker", async () => {
    const root = await resolveServerRoot(
      "/repo/src/main.rs",
      "/repo",
      rust,
      statter(["/repo/Cargo.toml"]),
    );
    expect(root).toBe("/repo");
  });

  it("leaves a spec without markers on the root Canopy passed", async () => {
    const ts = SERVERS.find((s) => s.id === "typescript")!;
    expect(ts.rootMarkers).toBeUndefined();
    const root = await resolveServerRoot(
      "/repo/src/deep/a.ts",
      "/repo",
      ts,
      statter(["/repo/src/deep/Cargo.toml"]),
    );
    expect(root).toBe("/repo");
  });
});

describe("serverUnavailableMessage", () => {
  const rust = SERVERS.find((s) => s.id === "rust")!;

  it("names the binary and how to install it when spawn found nothing", () => {
    const msg = serverUnavailableMessage(
      rust,
      new Error("failed to spawn rust-analyzer: No such file or directory (os error 2)"),
    );
    expect(msg).toContain("rust-analyzer not found on PATH");
    expect(msg).toContain("rustup component add rust-analyzer");
  });

  it("names pyright's install line too", () => {
    const py = SERVERS.find((s) => s.id === "python")!;
    expect(serverUnavailableMessage(py, "failed to spawn pyright-langserver: ENOENT")).toContain(
      "npm i -g pyright",
    );
  });

  it("passes a real start failure through instead of blaming PATH", () => {
    const msg = serverUnavailableMessage(rust, new Error("client stopped during initialize"));
    expect(msg).toContain("rust-analyzer failed to start");
    expect(msg).not.toContain("not found on PATH");
  });
});

describe("resolveNativeTsc", () => {
  it("finds whichever platform package npm actually installed", async () => {
    const arm = "/proj/node_modules/@typescript/typescript-darwin-arm64/lib/tsc";
    expect(await resolveNativeTsc("/proj", statter([arm]))).toBe(arm);
    const linux = "/proj/node_modules/@typescript/typescript-linux-x64/lib/tsc";
    expect(await resolveNativeTsc("/proj", statter([linux]))).toBe(linux);
  });

  it("finds the Windows executable, which carries an extension", async () => {
    const win = "/proj/node_modules/@typescript/typescript-win32-x64/lib/tsc.exe";
    expect(await resolveNativeTsc("/proj", statter([win]))).toBe(win);
  });

  it("is undefined when no platform package is installed", async () => {
    expect(await resolveNativeTsc("/proj", statter([]))).toBeUndefined();
  });
});

describe("resolveTypescriptLaunch", () => {
  const ts = SERVERS.find((s) => s.id === "typescript")!;
  const tsserver = "/proj/node_modules/typescript/lib/tsserver.js";
  const native = "/proj/node_modules/@typescript/typescript-darwin-arm64/lib/tsc";
  const launch = (present: string[]) =>
    resolveTypescriptLaunch(ts, "/proj", "/proj/node_modules/.bin/tsls", statter(present));

  it("drives a project's own tsserver through the wrapper, as before", async () => {
    // A project pinning TypeScript 6 must not be moved onto a different engine.
    const l = await launch([tsserver]);
    expect(l.command).toBe("/proj/node_modules/.bin/tsls");
    expect(l.args).toEqual(["--stdio"]);
    expect(l.initializationOptions).toEqual({ tsserver: { path: tsserver } });
  });

  it("keeps using tsserver even when a native compiler sits beside it", async () => {
    // Both present is the ordinary TypeScript 6 project; the native binary
    // must not hijack a toolchain that already works.
    expect((await launch([tsserver, native])).initializationOptions).toEqual({
      tsserver: { path: tsserver },
    });
  });

  it("talks straight to the native server when the project is TypeScript 7", async () => {
    // TypeScript 7 ships no tsserver at all, so the wrapper has nothing to run
    // and the compiler binary answers LSP itself.
    const l = await launch([native]);
    expect(l.command).toBe(native);
    expect(l.args).toEqual(["--lsp", "--stdio"]);
    expect(l.initializationOptions).toBeUndefined();
  });

  it("falls back to the wrapper's own lookup when the project has neither", async () => {
    const l = await launch([]);
    expect(l.command).toBe("/proj/node_modules/.bin/tsls");
    expect(l.initializationOptions).toEqual({ tsserver: { path: undefined } });
  });
});

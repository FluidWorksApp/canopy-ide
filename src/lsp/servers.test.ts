import { describe, expect, it } from "vitest";
import {
  resolveServerRoot,
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

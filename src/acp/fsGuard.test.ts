import { describe, expect, it } from "vitest";
import { checkFsAccess } from "./fsGuard";

const roots = ["/work"];
const rw = { roots, authority: "workspace-write" as const };
const ro = { roots, authority: "read-only" as const };

describe("checkFsAccess", () => {
  it("allows reads and writes inside a root", () => {
    expect(checkFsAccess("read", "/work/src/a.ts", ro)).toEqual({ ok: true, path: "/work/src/a.ts" });
    expect(checkFsAccess("write", "/work/src/a.ts", rw)).toEqual({ ok: true, path: "/work/src/a.ts" });
  });

  it("rejects relative paths", () => {
    const r = checkFsAccess("read", "src/a.ts", rw);
    expect(r.ok).toBe(false);
  });

  it("resolves .. segments before the root check", () => {
    expect(checkFsAccess("read", "/work/a/../b.ts", rw)).toEqual({ ok: true, path: "/work/b.ts" });
    expect(checkFsAccess("read", "/work/../etc/passwd", rw).ok).toBe(false);
  });

  it("does not treat a sibling with the same prefix as inside the root", () => {
    expect(checkFsAccess("read", "/work-other/a.ts", rw).ok).toBe(false);
  });

  it("denies outside every root and allows any listed root", () => {
    expect(checkFsAccess("read", "/etc/hosts", rw).ok).toBe(false);
    expect(checkFsAccess("read", "/extra/a", { ...rw, roots: ["/work", "/extra"] }).ok).toBe(true);
  });

  it("denies writes when read-only but still reads", () => {
    const w = checkFsAccess("write", "/work/a.ts", ro);
    expect(w.ok).toBe(false);
    if (!w.ok) expect(w.blocked).toBe(true);
    expect(checkFsAccess("read", "/work/a.ts", ro).ok).toBe(true);
  });

  it.each([
    "/work/.git/hooks/pre-commit",
    "/work/.git/config",
    "/work/.claude/settings.json",
    "/work/.claude/settings.local.json",
    "/work/.codex/config.toml",
    "/work/.kiro/settings/mcp.json",
    "/work/.mcp.json",
    "/work/sub/.mcp.json",
    "/work/.Claude/Settings.json",
    "/work/.GIT/Hooks/pre-commit",
    "/work/opencode.json",
    "/work/sub/opencode.jsonc",
    "/work/.opencode/plugin/x.js",
    "/work/.gitmodules",
    "/work/.husky/pre-commit",
    "/work/.vscode/tasks.json",
    "/work/.git",
  ])("denies writes to protected %s", (path) => {
    const r = checkFsAccess("write", path, rw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.blocked).toBe(true);
  });

  it("allows reading protected files and writing ordinary dotfiles", () => {
    expect(checkFsAccess("read", "/work/.git/config", rw).ok).toBe(true);
    expect(checkFsAccess("write", "/work/.gitignore", rw).ok).toBe(true);
    expect(checkFsAccess("write", "/work/.git/info/exclude", rw).ok).toBe(true);
    expect(checkFsAccess("write", "/work/.vscode/launch.json", rw).ok).toBe(true);
  });

  it("handles Windows drive paths", () => {
    const win = { roots: ["C:\\work"], authority: "workspace-write" as const };
    expect(checkFsAccess("read", "C:\\work\\a.ts", win)).toEqual({ ok: true, path: "C:/work/a.ts" });
    expect(checkFsAccess("read", "c:/work/a.ts", win).ok).toBe(true);
    expect(checkFsAccess("read", "D:\\work\\a.ts", win).ok).toBe(false);
  });
});

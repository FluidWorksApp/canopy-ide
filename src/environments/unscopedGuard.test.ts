import { describe, expect, it, vi } from "vitest";
import { assertScopedCall, guardUnscoped } from "./unscopedGuard";

describe("unscoped call guard", () => {
  it("is silent for the primary machine and for a tab with no machine", () => {
    const warn = vi.fn();
    expect(assertScopedCall("git_status", undefined, { primary: "local", warn })).toBe(false);
    expect(assertScopedCall("git_status", "local", { primary: "local", warn })).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns, or throws when strict, for a tab on another machine", () => {
    const warn = vi.fn();
    expect(assertScopedCall("fs_write", "remote:ws", { primary: "local", warn })).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("fs_write ran on local"));
    expect(() => assertScopedCall("fs_write", "remote:ws", { primary: "local", strict: true })).toThrow(/remote:ws/);
  });

  it("returns the function itself when disabled, so release builds pay nothing", () => {
    const fn = () => 1;
    expect(guardUnscoped("x", fn, () => "remote:ws", { primary: "local", enabled: false })).toBe(fn);
    const guarded = guardUnscoped("x", fn, () => "remote:ws", { primary: "local", enabled: true, strict: true });
    expect(() => guarded()).toThrow();
  });
});

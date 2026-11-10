import { beforeEach, expect, it } from "vitest";
import type { Host } from "../host/contract";
import { PTY_ALIAS_BASE, aliasOf, aliasPty, forgetEnvironment, isAliasPty, resetPtyRoutes, routeOf } from "./ptyRoute";

const host = { kind: "socket" } as Host;
beforeEach(resetPtyRoutes);

it("gives one alias per machine and terminal, above any real id", () => {
  const a = aliasPty("remote:a", 3, host, false);
  const again = aliasPty("remote:a", 3, host, false);
  const b = aliasPty("remote:b", 3, host, false);
  expect(a).toBe(again);
  expect(b).not.toBe(a);
  expect(a).toBeGreaterThanOrEqual(PTY_ALIAS_BASE);
  expect(isAliasPty(a)).toBe(true);
  expect(isAliasPty(3)).toBe(false);
  expect(aliasOf("remote:a", 3)).toBe(a);
});

it("never routes an ordinary id", () => {
  aliasPty("remote:a", 3, host, false);
  expect(routeOf(3)).toBeNull();
  expect(routeOf(PTY_ALIAS_BASE + 999)).toBeNull();
});

it("forgets a machine's terminals when it is let go", () => {
  const a = aliasPty("remote:a", 3, host, false);
  const b = aliasPty("remote:b", 3, host, false);
  forgetEnvironment("remote:a");
  expect(routeOf(a)).toBeNull();
  expect(routeOf(b)?.env).toBe("remote:b");
});

import { describe, expect, it } from "vitest";
import { pickAutomaticProfile } from "./accountPool";

describe("pickAutomaticProfile", () => {
  const base = { cli: "claude", ids: ["default", "a", "b"], now: 1000 };
  it("prefers the least recently used", () => {
    expect(pickAutomaticProfile({ ...base, limits: {}, lastUsed: { default: 5, a: 1, b: 3 } })).toBe("a");
  });
  it("skips limited accounts", () => {
    expect(pickAutomaticProfile({ ...base, limits: { "claude:a": { until: 2000 } }, lastUsed: { default: 5, b: 3 } })).toBe("b");
  });
  it("never blocks when all are limited", () => {
    const limits = Object.fromEntries(base.ids.map((i) => [`claude:${i}`, { until: 2000 }]));
    expect(pickAutomaticProfile({ ...base, limits, lastUsed: {} })).toBe("default");
  });
});

describe("pickAutomaticProfile usage", () => {
  it("prefers the account with the most plan headroom", () => {
    expect(pickAutomaticProfile({ cli: "claude", ids: ["default", "a"], now: 1, limits: {}, lastUsed: { a: 99 }, usage: { default: 80, a: 20 } })).toBe("a");
  });
});

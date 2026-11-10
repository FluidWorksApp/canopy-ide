import { describe, expect, it, vi } from "vitest";
import { EnvironmentRegistry, type Environment } from "./registry";
import { envOf, parseScopedKey, sameScoped, scoped, scopedKey } from "./scoped";

const env = (id: string, over: Partial<Environment> = {}): Environment => ({
  id,
  name: id,
  host: {} as never,
  status: "connected",
  readOnly: false,
  ...over,
});

describe("scoped ids", () => {
  it("builds a key that survives the colon already inside an environment id", () => {
    const key = scopedKey({ env: "remote:coraa-workstation", id: 7 });
    expect(key).toBe("remote:coraa-workstation|7");
    expect(parseScopedKey(key)).toEqual({ env: "remote:coraa-workstation", id: "7" });
  });
  it("tells terminal 3 here from terminal 3 elsewhere", () => {
    expect(sameScoped({ env: "local", id: 3 }, { env: "remote:w", id: 3 })).toBe(false);
    expect(sameScoped({ env: "local", id: 3 }, { env: "local", id: 3 })).toBe(true);
  });
  it("reads a record with no environment as the primary one", () => {
    expect(envOf({}, "local")).toBe("local");
    expect(envOf({ env: "remote:w" }, "local")).toBe("remote:w");
    expect(scoped(4, undefined, "local")).toEqual({ env: "local", id: 4 });
  });
  it("keeps a separator that is part of the id", () => {
    expect(parseScopedKey("local|a|b")).toEqual({ env: "local", id: "a|b" });
  });
  it("rejects strings that are not scoped keys", () => {
    for (const bad of ["", "nobar", "|7", "local|"]) expect(parseScopedKey(bad)).toBeNull();
  });
});

describe("EnvironmentRegistry", () => {
  it("makes the first registered environment the primary", () => {
    const r = new EnvironmentRegistry();
    expect(r.primary).toBeUndefined();
    r.register(env("local"));
    r.register(env("remote:w"));
    expect(r.primary?.id).toBe("local");
    expect(r.list().map((e) => e.id)).toEqual(["local", "remote:w"]);
  });
  it("promotes another environment when the primary is removed", () => {
    const r = new EnvironmentRegistry();
    r.register(env("local"));
    r.register(env("remote:w"));
    r.unregister("local");
    expect(r.primary?.id).toBe("remote:w");
    r.unregister("remote:w");
    expect(r.primary).toBeUndefined();
  });
  it("changes the primary only to an environment it holds", () => {
    const r = new EnvironmentRegistry();
    r.register(env("local"));
    r.register(env("remote:w"));
    r.setPrimary("nope");
    expect(r.primary?.id).toBe("local");
    r.setPrimary("remote:w");
    expect(r.primary?.id).toBe("remote:w");
  });
  it("tells subscribers about changes, and keeps going when one throws", () => {
    const r = new EnvironmentRegistry();
    const bad = vi.fn(() => {
      throw new Error("x");
    });
    const good = vi.fn();
    r.subscribe(bad);
    const off = r.subscribe(good);
    r.register(env("local"));
    r.setStatus("local", "reconnecting");
    expect(good).toHaveBeenCalledTimes(2);
    expect(r.get("local")?.status).toBe("reconnecting");
    off();
    r.setStatus("local", "connected");
    expect(good).toHaveBeenCalledTimes(2);
  });
  it("does not notify for a status that did not change", () => {
    const r = new EnvironmentRegistry();
    r.register(env("local"));
    const fn = vi.fn();
    r.subscribe(fn);
    r.setStatus("local", "connected");
    expect(fn).not.toHaveBeenCalled();
  });
});

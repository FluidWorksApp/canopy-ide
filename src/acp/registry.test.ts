import { beforeEach, describe, expect, it, vi } from "vitest";
import { AcpRegistryError, fetchAcpRegistry, parseRegistry } from "./registry";

const registry = {
  version: "1.0.0",
  agents: [
    {
      id: "gemini",
      name: "Gemini CLI",
      version: "0.67.0",
      description: "d",
      distribution: { npx: { package: "@google/gemini-cli@0.67.0", args: ["--acp"] } },
    },
    {
      id: "pyagent",
      name: "Py",
      version: "1.0.0",
      distribution: { uvx: { package: "pyagent==1.0.0" } },
    },
    {
      id: "goose",
      name: "Goose",
      version: "1.57.0",
      distribution: {
        binary: {
          "linux-x86_64": { archive: "https://example.com/g.tar.gz", cmd: "./goose", args: ["acp"] },
        },
      },
    },
    { id: "BAD ID", name: "x", version: "1.0.0", distribution: { npx: { package: "x@1.0.0" } } },
    { id: "unpinned", name: "u", version: "1.0.0", distribution: { npx: { package: "x" } } },
    {
      id: "http-only",
      name: "h",
      version: "1.0.0",
      distribution: { binary: { "linux-x86_64": { archive: "http://e.com/a", cmd: "./a" } } },
    },
  ],
};

const ok = (body: unknown) =>
  vi.fn(async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200 }));

beforeEach(() => localStorage.clear());

describe("parseRegistry", () => {
  it("maps npx, uvx and binary distributions to launch commands", () => {
    const agents = parseRegistry(registry, "linux-x86_64");
    expect(agents.map((a) => a.id)).toEqual(["gemini", "pyagent", "goose"]);
    expect(agents[0].launch[0]).toMatchObject({
      command: "npx",
      args: ["-y", "@google/gemini-cli@0.67.0", "--acp"],
      needsInstall: false,
    });
    expect(agents[1].launch[0]).toMatchObject({ command: "uvx", args: ["pyagent==1.0.0"] });
    expect(agents[2].launch[0]).toMatchObject({ command: "goose", args: ["acp"], needsInstall: true });
  });
  it("omits binaries for other platforms", () => {
    expect(parseRegistry(registry, "darwin-aarch64").some((a) => a.id === "goose")).toBe(false);
  });
  it("rejects a payload that is not a registry", () => {
    expect(() => parseRegistry({ nope: 1 })).toThrow(AcpRegistryError);
  });
});

describe("fetchAcpRegistry", () => {
  it("fetches, validates and caches", async () => {
    const f = ok(registry);
    const a = await fetchAcpRegistry({ fetchImpl: f as never, platform: "linux-x86_64" });
    expect(a).toHaveLength(3);
    const b = await fetchAcpRegistry({ fetchImpl: f as never, platform: "linux-x86_64" });
    expect(b).toHaveLength(3);
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("rejects invalid schema without a cache", async () => {
    await expect(fetchAcpRegistry({ fetchImpl: ok({ agents: "x" }) as never })).rejects.toMatchObject({
      reason: "invalid",
    });
  });
  it("is offline when the network fails and nothing is cached", async () => {
    const f = vi.fn(async () => {
      throw new TypeError("network down");
    });
    await expect(fetchAcpRegistry({ fetchImpl: f as never })).rejects.toMatchObject({ reason: "offline" });
  });
  it("serves a stale cache when offline", async () => {
    await fetchAcpRegistry({ fetchImpl: ok(registry) as never, platform: "linux-x86_64", now: 0 });
    const f = vi.fn(async () => {
      throw new TypeError("network down");
    });
    const agents = await fetchAcpRegistry({
      fetchImpl: f as never,
      platform: "linux-x86_64",
      now: 7 * 24 * 3600 * 1000,
    });
    expect(agents).toHaveLength(3);
    expect(f).toHaveBeenCalled();
  });
  it("treats a non-200 as offline", async () => {
    const f = vi.fn(async () => new Response("no", { status: 503 }));
    await expect(fetchAcpRegistry({ fetchImpl: f as never })).rejects.toMatchObject({ reason: "offline" });
  });
});

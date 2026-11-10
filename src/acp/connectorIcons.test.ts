import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  connectorIconFor,
  loadConnectorIcon,
  registerConnectorIcon,
  resetConnectorIconCache,
  trustedIconUrl,
} from "./connectorIcons";
import { parseRegistry } from "./registry";

const GOOD = "https://cdn.agentclientprotocol.com/registry/v1/latest/gemini.svg";
beforeEach(() => {
  localStorage.clear();
  resetConnectorIconCache();
});

describe("trustedIconUrl", () => {
  it("accepts only an https svg on the registry's CDN", () => {
    expect(trustedIconUrl(GOOD)).toBe(GOOD);
    for (const bad of [
      "http://cdn.agentclientprotocol.com/x.svg",
      "https://evil.example/x.svg",
      "https://cdn.agentclientprotocol.com/x.png",
      "https://cdn.agentclientprotocol.com.evil.example/x.svg",
      "javascript:alert(1)",
      "",
      42,
      undefined,
    ]) {
      expect(trustedIconUrl(bad)).toBeUndefined();
    }
  });
});

describe("loadConnectorIcon", () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>';
  it("fetches once, returns a data URL, and caches", async () => {
    const f = vi.fn(async () => new Response(svg));
    const first = await loadConnectorIcon(GOOD, f as never);
    expect(first?.startsWith("data:image/svg+xml;base64,")).toBe(true);
    await loadConnectorIcon(GOOD, f as never);
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("refuses an untrusted host without fetching", async () => {
    const f = vi.fn();
    expect(await loadConnectorIcon("https://evil.example/x.svg", f as never)).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });
  it("returns null for non-svg bodies, errors, and oversized files", async () => {
    expect(await loadConnectorIcon(GOOD, (async () => new Response("<html>")) as never)).toBeNull();
    resetConnectorIconCache();
    expect(await loadConnectorIcon(GOOD, (async () => { throw new Error("x"); }) as never)).toBeNull();
    resetConnectorIconCache();
    const big = `<svg>${"a".repeat(70_000)}</svg>`;
    expect(await loadConnectorIcon(GOOD, (async () => new Response(big)) as never)).toBeNull();
  });
});

describe("registered icons", () => {
  it("remembers a connector's icon by CLI id and ignores untrusted ones", () => {
    registerConnectorIcon("gemini-cli", GOOD);
    registerConnectorIcon("bad", "https://evil.example/x.svg");
    expect(connectorIconFor("gemini-cli")).toBe(GOOD);
    expect(connectorIconFor("bad")).toBeUndefined();
  });
});

describe("registry parsing", () => {
  it("keeps a trusted icon and drops others", () => {
    const agents = parseRegistry(
      {
        agents: [
          { id: "a", name: "A", version: "1.0.0", icon: GOOD, distribution: { npx: { package: "a@1.0.0" } } },
          { id: "b", name: "B", version: "1.0.0", icon: "https://evil.example/b.svg", distribution: { npx: { package: "b@1.0.0" } } },
        ],
      },
      "darwin-aarch64",
    );
    expect(agents.map((a) => a.icon)).toEqual([GOOD, undefined]);
  });
});

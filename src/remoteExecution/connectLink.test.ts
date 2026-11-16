import { expect, it } from "vitest";
import { connectError, maskedLink, parseConnectLink, routeLabel } from "./connectLink";
import { insideRemoteRoot, normalizeRemoteRoot } from "./remoteRoot";

const TOKEN = "synthetic-token-0123456789abcdef";

it("reads the address and token from a canopy-host link", () => {
  expect(parseConnectLink(`  http://box.tail1234.ts.net:8787/connect#token=${TOKEN} `)).toEqual({ endpoint: "http://box.tail1234.ts.net:8787", token: TOKEN });
  expect(parseConnectLink(`http://127.0.0.1:8787/connect#token=${encodeURIComponent(TOKEN)}`)).toEqual({ endpoint: "http://127.0.0.1:8787", token: TOKEN });
});

it("rejects links without a token, public plain-http hosts and junk", () => {
  expect(() => parseConnectLink("http://127.0.0.1:8787/connect")).toThrow(/isn't a canopy-host link/);
  expect(() => parseConnectLink(`http://vm.example:8787/connect#token=${TOKEN}`)).toThrow(/isn't private/);
  expect(() => parseConnectLink("not a link")).toThrow(/isn't a canopy-host link/);
});

it("hides the token, says how the machine is reached, and explains failures", () => {
  expect(maskedLink(`http://box.tail1234.ts.net:8787/connect#token=${TOKEN}`)).toBe("http://box.tail1234.ts.net:8787/connect#token=••••••••••••");
  expect(maskedLink(`http://vm.example:8787/connect#token=${TOKEN}`)).not.toContain(TOKEN);
  expect(maskedLink("http://box")).toBe("http://box");
  expect(routeLabel("http://box.tail1234.ts.net:8787")).toBe("box.tail1234.ts.net · over Tailscale");
  expect(routeLabel("http://127.0.0.1:8787")).toBe("127.0.0.1 · through your SSH tunnel");
  expect(routeLabel("https://vm.example")).toBe("vm.example · over https");
  expect(connectError(new Error("401 Unauthorized"), "http://127.0.0.1:8787")).toMatch(/didn't accept this link/);
  expect(connectError(new TypeError("Failed to fetch"), "http://box.tail1234.ts.net:8787")).toMatch(/Can't reach box\.tail1234\.ts\.net.*same tailnet/);
  expect(connectError(new TypeError("Failed to fetch"), "http://127.0.0.1:8787")).toMatch(/SSH tunnel is open/);
});

it("keeps the remote root absolute and checks paths against it", () => {
  expect(normalizeRemoteRoot("/home/me/work/")).toBe("/home/me/work");
  expect(normalizeRemoteRoot("relative")).toBe("/workspace");
  expect(normalizeRemoteRoot("/home/../etc")).toBe("/workspace");
  expect(normalizeRemoteRoot(undefined)).toBe("/workspace");
  expect(insideRemoteRoot("/home/me/work/app", "/home/me/work")).toBe(true);
  expect(insideRemoteRoot("/home/me/workshop", "/home/me/work")).toBe(false);
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// preview.rs serves each project on p-<hash>.localhost. The window's policy has
// to allow that host, or WebKit leaves the preview frame on about:blank.
const security = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8")).app.security;
const directive = (csp: string, name: string) =>
  csp.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name} `)) ?? "";

describe("preview frame policy", () => {
  it.each(["csp", "devCsp"])("%s allows project preview hosts in frames", (key) => {
    expect(directive(security[key], "frame-src")).toContain("http://*.localhost:*");
  });
});

import { describe, expect, it } from "vitest";
import { parseVibeIntent } from "./vibeIntent";

describe("silence is the default", () => {
  it("leaves ordinary build requests alone", () => {
    for (const message of [
      "add a login button",
      "add a dark mode toggle to the header",
      "make the primary button blue",
      "the checkout page is broken, please fix it",
      "connect the form to the existing handler",
      "deploy is failing in CI, can you look at the config",
      "",
    ]) {
      expect(parseVibeIntent(message), message).toBeNull();
    }
  });
});

describe("installing", () => {
  it("reads the verbs that actually mean a dependency", () => {
    expect(parseVibeIntent("install stripe")).toEqual({
      kind: "install",
      packages: [{ name: "stripe", dev: false }],
    });
    expect(parseVibeIntent("add the package zod")).toMatchObject({
      kind: "install",
      packages: [{ name: "zod" }],
    });
    expect(parseVibeIntent("pnpm add react-hook-form")).toMatchObject({
      kind: "install",
    });
  });

  it("keeps a version and a scope apart", () => {
    expect(parseVibeIntent("install stripe@^5.2.0")).toMatchObject({
      packages: [{ name: "stripe", version: "^5.2.0" }],
    });
    expect(parseVibeIntent("install @stripe/stripe-js")).toMatchObject({
      packages: [{ name: "@stripe/stripe-js" }],
    });
    expect(parseVibeIntent("install @stripe/stripe-js@latest")).toMatchObject({
      packages: [{ name: "@stripe/stripe-js", version: "latest" }],
    });
  });

  it("takes several packages and notices a dev dependency", () => {
    const intent = parseVibeIntent("install vitest and happy-dom as a dev dependency");
    expect(intent?.kind).toBe("install");
    if (intent?.kind !== "install") return;
    expect(intent.packages.map((p) => p.name)).toEqual(["vitest", "happy-dom"]);
    expect(intent.packages.every((p) => p.dev)).toBe(true);
  });
});

describe("linking", () => {
  it("recognises the providers Canopy can actually reach", () => {
    expect(parseVibeIntent("connect supabase")).toEqual({
      kind: "link",
      provider: "supabase",
    });
    expect(parseVibeIntent("hook this up to Neon please")).toMatchObject({
      provider: "neon",
    });
    expect(parseVibeIntent("set up stripe for me")).toMatchObject({
      provider: "stripe",
    });
  });

  it("stays silent on a provider it has no headless path to", () => {
    expect(parseVibeIntent("connect to our internal billing service")).toBeNull();
  });
});

describe("deploying", () => {
  it("reads production as production", () => {
    for (const message of [
      "deploy to production",
      "publish this live",
      "ship it to prod",
      "let's go live",
    ]) {
      expect(parseVibeIntent(message), message).toMatchObject({
        kind: "deploy",
        target: "production",
      });
    }
  });

  it("treats a bare deploy as a preview", () => {
    expect(parseVibeIntent("deploy this")).toEqual({
      kind: "deploy",
      target: "preview",
    });
    expect(parseVibeIntent("publish a preview")).toMatchObject({
      target: "preview",
    });
  });

  it("never reads production as preview when both could match", () => {
    // "publish to production" matches the looser preview pattern too; the
    // stricter reading must win, because it is the one that asks first.
    expect(parseVibeIntent("publish to production")).toMatchObject({
      target: "production",
    });
  });
});

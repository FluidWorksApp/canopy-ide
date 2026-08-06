import { describe, expect, it } from "vitest";
import { proposeAbstraction, type AbstractionContext } from "./vibeAbstractions";
import { PUBLISH_CONFIRMATION } from "./vibeDeploy";

const ctx = (over: Partial<AbstractionContext> = {}): AbstractionContext => ({
  cwd: "/w/app",
  entries: ["package.json", "package-lock.json"],
  packageManagerField: null,
  dependencies: {},
  devDependencies: {},
  link: {
    cliInstalled: true,
    authenticated: true,
    presentSecrets: [],
    envFileTracked: false,
  },
  deploy: { dirty: false, cliInstalled: true },
  ...over,
});

/** Verification is a separate argument on purpose: it is what the session
 *  observed, not a property of the project, so a test must state it outright
 *  rather than tuck it into the context. */
const propose = (
  intent: Parameters<typeof proposeAbstraction>[0],
  context: AbstractionContext,
  verification: "verified" | "incomplete" | "failed" = "verified",
) => proposeAbstraction(intent, context, verification);

describe("installing", () => {
  it("proposes an argv the lockfile chose, never a shell string", () => {
    const p = propose(
      { kind: "install", packages: [{ name: "stripe" }] },
      ctx({ entries: ["package.json", "pnpm-lock.yaml"] }),
    );
    expect(p.kind).toBe("run");
    if (p.kind !== "run") return;
    expect(p.argv[0]).toBe("pnpm");
    expect(p.argv).toContain("stripe");
    // The whole point of the argv boundary: nothing is ever one string.
    expect(p.argv.every((a) => typeof a === "string")).toBe(true);
    expect(p.cwd).toBe("/w/app");
  });

  it("does not reinstall what is already there", () => {
    const p = propose(
      { kind: "install", packages: [{ name: "stripe" }] },
      ctx({ dependencies: { stripe: "^5.0.0" } }),
    );
    expect(p.kind).toBe("guide");
    expect(p.title).toMatch(/already installed/i);
  });

  it("still installs when a specific version was asked for", () => {
    // "install stripe@^6" against stripe@5 is a real request, not a no-op.
    const p = propose(
      { kind: "install", packages: [{ name: "stripe", version: "^6" }] },
      ctx({ dependencies: { stripe: "^5.0.0" } }),
    );
    expect(p.kind).toBe("run");
  });

  it("passes the planner's refusal through in the user's language", () => {
    const p = propose(
      { kind: "install", packages: [{ name: "--registry=http://evil" }] },
      ctx(),
    );
    expect(p.kind).toBe("refuse");
    expect(p.detail).toBeTruthy();
  });
});

describe("linking", () => {
  it("guides but never runs, because a step needs the user's own secret", () => {
    const p = propose({ kind: "link", provider: "supabase" }, ctx());
    // A `run` here would mean Canopy executing "collect an API key".
    expect(p.kind).toBe("guide");
    if (p.kind !== "guide") return;
    expect(p.detail).toMatch(/server-side/);
  });

  it("names variables and never carries a value", () => {
    const p = propose({ kind: "link", provider: "stripe" }, ctx());
    if (p.kind !== "guide") throw new Error("expected a guide");
    expect(p.detail).not.toMatch(/sk_live|sk_test|=\s*\S{20,}/);
  });

  it("refuses when the env file would be committed", () => {
    const p = propose(
      { kind: "link", provider: "supabase" },
      ctx({ link: { ...ctx().link, envFileTracked: true } }),
    );
    expect(p.kind).toBe("refuse");
  });
});

describe("deploying", () => {
  const withProvider = (over: Partial<AbstractionContext> = {}) =>
    ctx({ entries: ["package.json", "vercel.json"], ...over });

  it("asks for the exact phrase before anything reaches production", () => {
    const p = propose({ kind: "deploy", target: "production" }, withProvider());
    expect(p.kind).toBe("run");
    if (p.kind !== "run") return;
    expect(p.confirmLabel).toBe(PUBLISH_CONFIRMATION);
    expect(p.detail).toContain(PUBLISH_CONFIRMATION);
  });

  it("refuses a dirty tree rather than publishing unknown content", () => {
    // A real refusal must survive the confirmed:true call that produces argv.
    // If that call's result were used as the answer without checking it, every
    // gate other than the confirmation would silently evaporate here.
    const p = propose(
      { kind: "deploy", target: "production" },
      withProvider({ deploy: { dirty: true, cliInstalled: true } }),
    );
    expect(p.kind).toBe("refuse");
  });

  it("refuses to publish work nothing verified", () => {
    const p = propose({ kind: "deploy", target: "production" }, withProvider(), "failed");
    expect(p.kind).toBe("refuse");
  });

  it("refuses production on merely incomplete evidence, not only on failure", () => {
    // "incomplete" is the state a session is in before anything has been
    // checked, which is exactly when a publish must not go out.
    const p = propose({ kind: "deploy", target: "production" }, withProvider(), "incomplete");
    expect(p.kind).toBe("refuse");
  });

  it("refuses when there is no provider to deploy to", () => {
    const p = propose({ kind: "deploy", target: "preview" }, ctx());
    expect(p.kind).toBe("refuse");
  });

  it("carries a preview's missing-evidence caveat rather than hiding it", () => {
    const p = propose({ kind: "deploy", target: "preview" }, withProvider(), "incomplete");
    if (p.kind !== "run") throw new Error("expected a run");
    expect(p.caveat).toBeTruthy();
  });
});

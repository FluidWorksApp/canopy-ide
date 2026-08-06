import { describe, expect, it } from "vitest";
import {
  PUBLISH_CONFIRMATION,
  deployProviderById,
  detectDeployProvider,
  planDeploy,
  type DeployContext,
} from "./vibeDeploy";

const vercel = deployProviderById("vercel")!;
const ctx = (over: Partial<DeployContext> = {}): DeployContext => ({
  verification: "verified",
  dirty: false,
  cliInstalled: true,
  confirmed: true,
  ...over,
});

describe("provider detection", () => {
  it("recognises a project by the config it already committed", () => {
    expect(detectDeployProvider(["vercel.json", "package.json"])?.id).toBe("vercel");
    expect(detectDeployProvider(["fly.toml"])?.id).toBe("fly");
    expect(detectDeployProvider(["wrangler.jsonc"])?.id).toBe("cloudflare");
  });

  it("returns null rather than guessing a default", () => {
    expect(detectDeployProvider(["package.json", "README.md"])).toBeNull();
  });
});

describe("preview deploys", () => {
  it("goes out for verified work with no caveat", () => {
    const plan = planDeploy(vercel, "preview", ctx(), "/app");
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.argv).toEqual(["vercel"]);
    expect(plan.caveat).toBeNull();
  });

  it("still goes out when verification is incomplete, but says so", () => {
    const plan = planDeploy(vercel, "preview", ctx({ verification: "incomplete" }), "/app");
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.caveat).toMatch(/couldn't fully verify/i);
  });

  it("is refused when the checks actually failed", () => {
    const plan = planDeploy(vercel, "preview", ctx({ verification: "failed" }), "/app");
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.refusal).toBe("verification-failed");
  });

  it("does not need confirmation, because a preview is disposable", () => {
    const plan = planDeploy(vercel, "preview", ctx({ confirmed: false }), "/app");
    expect(plan.ok).toBe(true);
  });
});

describe("production deploys", () => {
  it("needs verified evidence, a clean tree, and the exact phrase", () => {
    expect(
      planDeploy(vercel, "production", ctx({ verification: "incomplete" }), "/app"),
    ).toMatchObject({ ok: false, refusal: "not-verified" });
    expect(planDeploy(vercel, "production", ctx({ dirty: true }), "/app")).toMatchObject({
      ok: false,
      refusal: "uncommitted-changes",
    });
    const unconfirmed = planDeploy(vercel, "production", ctx({ confirmed: false }), "/app");
    expect(unconfirmed).toMatchObject({ ok: false, refusal: "not-confirmed" });
    if (!unconfirmed.ok) {
      expect(unconfirmed.needs).toBe(PUBLISH_CONFIRMATION);
      expect(unconfirmed.why).toMatch(/yours to decide/);
    }
  });

  it("publishes only when all three hold", () => {
    const plan = planDeploy(vercel, "production", ctx(), "/app");
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.argv).toEqual(["vercel", "--prod"]);
    expect(plan.summary).toMatch(/production/i);
  });

  it("explains what a dirty tree actually risks", () => {
    const plan = planDeploy(vercel, "production", ctx({ dirty: true }), "/app");
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.why).toMatch(/isn't what was verified/);
  });
});

describe("prerequisites", () => {
  it("refuses with no provider and offers the install when the CLI is missing", () => {
    expect(planDeploy(null, "preview", ctx(), "/app")).toMatchObject({
      ok: false,
      refusal: "no-provider",
    });
    const missing = planDeploy(vercel, "preview", ctx({ cliInstalled: false }), "/app");
    expect(missing).toMatchObject({ ok: false, refusal: "cli-missing" });
    if (!missing.ok) expect(missing.needs).toBe("npm install -g vercel");
  });
});

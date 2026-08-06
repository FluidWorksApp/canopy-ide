import { describe, expect, it } from "vitest";
import {
  SERVICE_PROVIDERS,
  clientVarName,
  envLine,
  planLink,
  providerById,
  type LinkContext,
} from "./vibeServices";

const ctx = (over: Partial<LinkContext> = {}): LinkContext => ({
  cliInstalled: true,
  authenticated: true,
  presentSecrets: [],
  envFileTracked: false,
  ...over,
});

describe("the provider registry", () => {
  it("only lists services reachable without a browser", () => {
    for (const p of SERVICE_PROVIDERS) {
      expect(p.reach.length, p.id).toBeGreaterThan(0);
      if (p.reach.includes("cli")) expect(p.cli, p.id).toBeTruthy();
    }
  });

  it("marks server-only keys as unpublishable", () => {
    const supabase = providerById("supabase")!;
    expect(supabase.secrets.find((s) => s.name === "SUPABASE_SERVICE_ROLE_KEY")!.publishable)
      .toBe(false);
    expect(supabase.secrets.find((s) => s.name === "SUPABASE_ANON_KEY")!.publishable).toBe(true);
    expect(providerById("neon")!.secrets.every((s) => !s.publishable)).toBe(true);
  });
});

describe("link planning", () => {
  it("refuses a provider with no verified headless path", () => {
    const plan = planLink("some-saas", ctx());
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.refusal).toBe("unknown-provider");
  });

  it("refuses to write keys into a git-tracked env file", () => {
    const plan = planLink("supabase", ctx({ envFileTracked: true }));
    expect(plan.ok).toBe(false);
    if (!plan.ok) {
      expect(plan.refusal).toBe("env-file-is-tracked");
      expect(plan.why).toMatch(/commit them/);
    }
  });

  it("installs before authenticating, and collects before writing", () => {
    const plan = planLink("supabase", ctx({ cliInstalled: false, authenticated: false }));
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const kinds = plan.steps.map((s) => s.kind);
    expect(kinds.indexOf("install-cli")).toBeLessThan(kinds.indexOf("authenticate"));
    expect(kinds.lastIndexOf("collect-secret")).toBeLessThan(kinds.indexOf("write-env"));
  });

  it("asks only for the secrets the project is missing", () => {
    const plan = planLink(
      "supabase",
      ctx({ presentSecrets: ["SUPABASE_URL", "SUPABASE_ANON_KEY"] }),
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const asked = plan.steps.flatMap((s) => (s.kind === "collect-secret" ? [s.secret.name] : []));
    expect(asked).toEqual(["SUPABASE_SERVICE_ROLE_KEY"]);
  });

  it("says nothing is needed when the project is already linked", () => {
    const neon = providerById("neon")!;
    const plan = planLink("neon", ctx({ presentSecrets: neon.secrets.map((s) => s.name) }));
    expect(plan.ok && plan.steps).toEqual([]);
    expect(plan.ok && plan.summary).toMatch(/already linked/);
  });

  it("never puts a secret value anywhere in the plan", () => {
    const plan = planLink("stripe", ctx({ cliInstalled: false, authenticated: false }));
    // The whole plan is loggable: it names variables, never their contents.
    const serialized = JSON.stringify(plan);
    expect(serialized).toContain("STRIPE_SECRET_KEY");
    expect(serialized).not.toMatch(/sk_(live|test)_/);
  });
});

describe("client exposure and env formatting", () => {
  it("prefixes only publishable keys, and never twice", () => {
    const supabase = providerById("supabase")!;
    const anon = supabase.secrets.find((s) => s.name === "SUPABASE_ANON_KEY")!;
    const role = supabase.secrets.find((s) => s.name === "SUPABASE_SERVICE_ROLE_KEY")!;
    expect(clientVarName(supabase, anon)).toBe("NEXT_PUBLIC_SUPABASE_ANON_KEY");
    expect(clientVarName(supabase, role)).toBe("SUPABASE_SERVICE_ROLE_KEY");
    expect(
      clientVarName(supabase, { ...anon, name: "NEXT_PUBLIC_SUPABASE_ANON_KEY" }),
    ).toBe("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  });

  it("quotes and escapes values that would otherwise break the file", () => {
    expect(envLine("A", "plain")).toBe("A=plain");
    expect(envLine("A", "has space")).toBe('A="has space"');
    expect(envLine("A", 'quote"inside')).toBe('A="quote\\"inside"');
    expect(envLine("A", "back\\slash")).toBe('A="back\\\\slash"');
    expect(envLine("A", "hash#comment")).toBe('A="hash#comment"');
  });
});

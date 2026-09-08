// Preview runs on local managed servers. Only an explicitly confirmed,
// freshly verified production publication may invoke a deployment CLI.
export type DeployTarget = "preview" | "production";

export interface DeployProvider {
  id: string;
  label: string;
  bin: string;
  install: string;
  /** Files whose presence means this project already uses the provider. */
  markers: string[];
  /** Argv after the binary, per target. */
  args: { production: string[] };
  docs: string;
}

export const DEPLOY_PROVIDERS: readonly DeployProvider[] = [
  {
    id: "vercel",
    label: "Vercel",
    bin: "vercel",
    install: "npm install -g vercel",
    markers: ["vercel.json", ".vercel"],
    args: { production: ["--prod"] },
    docs: "https://vercel.com/docs/cli",
  },
  {
    id: "netlify",
    label: "Netlify",
    bin: "netlify",
    install: "npm install -g netlify-cli",
    markers: ["netlify.toml", ".netlify"],
    args: { production: ["deploy", "--prod"] },
    docs: "https://docs.netlify.com/cli/get-started/",
  },
  {
    id: "cloudflare",
    label: "Cloudflare Pages",
    bin: "wrangler",
    install: "npm install -g wrangler",
    markers: ["wrangler.toml", "wrangler.jsonc", "wrangler.json"],
    args: { production: ["pages", "deploy", "--branch", "main"] },
    docs: "https://developers.cloudflare.com/workers/wrangler/",
  },
  {
    id: "fly",
    label: "Fly.io",
    bin: "flyctl",
    install: "brew install flyctl",
    markers: ["fly.toml"],
    args: { production: ["deploy"] },
    docs: "https://fly.io/docs/flyctl/",
  },
];

/** Which provider this project already uses, by the config it committed.
 *  Guessing a provider it doesn't use would publish somewhere nobody expects,
 *  so absence returns null rather than a default. */
export function detectDeployProvider(entries: readonly string[]): DeployProvider | null {
  const present = new Set(entries);
  return (
    DEPLOY_PROVIDERS.find((p) => p.markers.some((m) => present.has(m))) ?? null
  );
}

/** The phrase a user must actually say to publish. Requiring an exact string
 *  keeps an agent's paraphrase of enthusiasm from becoming consent. */
export const PUBLISH_CONFIRMATION = "Publish to production";

export interface DeployContext {
  /** Independently observed verification for the work being deployed. */
  verification: "verified" | "incomplete" | "failed";
  /** Whether the component has uncommitted changes. */
  dirty: boolean;
  /** Whether the provider's CLI is on PATH. */
  cliInstalled: boolean;
  /** Whether the user said the exact confirmation phrase this turn. */
  confirmed: boolean;
  /** Commit plus deployment configuration fingerprint, observed on disk. */
  revision?: string | null;
}

export type DeployPlan =
  | {
      ok: true;
      provider: DeployProvider;
      target: DeployTarget;
      argv: string[];
      cwd: string;
      /** Set when a preview is going out with evidence missing, so the link is
       *  never handed over as though it were checked. */
      caveat: string | null;
      summary: string;
    }
  | { ok: false; refusal: DeployRefusal; why: string; needs?: string };

export type DeployRefusal =
  | "local-preview"
  | "no-provider"
  | "cli-missing"
  | "not-verified"
  | "uncommitted-changes"
  | "not-confirmed"
  | "verification-failed";

export function planDeploy(
  provider: DeployProvider | null,
  target: DeployTarget,
  context: DeployContext,
  cwd: string,
): DeployPlan {
  if (target === "preview") {
    return { ok: false, refusal: "local-preview", why: "Preview runs locally in the project browser. Deployment publishes to production." };
  }
  if (!provider) {
    return {
      ok: false,
      refusal: "no-provider",
      why: "this project has no deployment config, so there is nowhere it already publishes to",
    };
  }
  if (!context.cliInstalled) {
    return {
      ok: false,
      refusal: "cli-missing",
      why: `${provider.label} deploys through its CLI, which isn't installed`,
      needs: provider.install,
    };
  }
  // A failed verification blocks even a preview: a preview link is still a
  // link someone will open and judge.
  if (context.verification === "failed") {
    return {
      ok: false,
      refusal: "verification-failed",
      why: "the checks failed, so there is nothing worth putting on a URL yet",
    };
  }

  if (target === "production") {
    if (context.verification !== "verified") {
      return {
        ok: false,
        refusal: "not-verified",
        why: "production needs independently verified evidence, and this turn's verification is incomplete",
      };
    }
    if (context.dirty) {
      return {
        ok: false,
        refusal: "uncommitted-changes",
        why: "there are unsaved changes, so what would go live isn't what was verified",
      };
    }
    if (!context.confirmed) {
      return {
        ok: false,
        refusal: "not-confirmed",
        why: "publishing is yours to decide, not mine",
        needs: PUBLISH_CONFIRMATION,
      };
    }
  }

  return {
    ok: true,
    provider,
    target,
    argv: [provider.bin, ...provider.args[target]],
    cwd,
    caveat: null,
    summary: `Publishing to production on ${provider.label}.`,
  };
}

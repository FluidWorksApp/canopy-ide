// Linking a project to a backing service — the second managed abstraction.
//
// The rule that shapes all of this: a credential is the one thing Build mode
// handles that cannot be un-leaked. So the design is not "be careful with
// secrets", it is "never be in a position to leak one":
//
//   - A secret's VALUE never enters a plan, a transcript, an event, or a
//     summary. Plans carry the NAMES of the variables a service needs and
//     nothing else, so the whole planning path can be logged safely.
//   - Secrets go to an untracked env file, and a target that git would track
//     is refused rather than written — .env is git-ignored by convention, not
//     by guarantee, so the caller must prove it.
//   - Every provider here is reachable by CLI, API or MCP, which is what the
//     owner asked for: nothing requires clicking through a dashboard.

export type ServiceReach = "cli" | "api" | "mcp";

export interface ServiceSecret {
  /** The env var name — never its value. */
  name: string;
  /** What it is, in the words a non-engineer would use. */
  purpose: string;
  /** Publishable keys are safe in a client bundle; secret ones never are. */
  publishable: boolean;
}

export interface ServiceProvider {
  id: string;
  label: string;
  /** How Canopy can drive it without a browser. */
  reach: ServiceReach[];
  /** The CLI that would do the work, when reach includes "cli". */
  cli?: { bin: string; install: string };
  secrets: ServiceSecret[];
  /** Where the project reads them from at runtime. */
  envFile: string;
  /** Client-side frameworks only expose vars with the right prefix, and a key
   *  that never reaches the browser looks like a broken integration. */
  clientPrefix?: string;
  docs: string;
}

/** Providers Canopy can link today. Deliberately small: each entry is a claim
 *  that we know how to reach it headlessly, and an unverified entry would send
 *  someone to a dashboard the whole feature exists to avoid. */
export const SERVICE_PROVIDERS: readonly ServiceProvider[] = [
  {
    id: "supabase",
    label: "Supabase",
    reach: ["cli", "api", "mcp"],
    cli: { bin: "supabase", install: "npm install -g supabase" },
    secrets: [
      { name: "SUPABASE_URL", purpose: "which project to talk to", publishable: true },
      { name: "SUPABASE_ANON_KEY", purpose: "browser-side access", publishable: true },
      {
        name: "SUPABASE_SERVICE_ROLE_KEY",
        purpose: "server-side access that bypasses row security",
        publishable: false,
      },
    ],
    envFile: ".env.local",
    clientPrefix: "NEXT_PUBLIC_",
    docs: "https://supabase.com/docs/guides/cli",
  },
  {
    id: "neon",
    label: "Neon",
    reach: ["cli", "api", "mcp"],
    cli: { bin: "neonctl", install: "npm install -g neonctl" },
    secrets: [
      { name: "DATABASE_URL", purpose: "the Postgres connection string", publishable: false },
    ],
    envFile: ".env.local",
    docs: "https://neon.tech/docs/reference/neon-cli",
  },
  {
    id: "firebase",
    label: "Firebase",
    reach: ["cli", "api"],
    cli: { bin: "firebase", install: "npm install -g firebase-tools" },
    secrets: [
      { name: "FIREBASE_PROJECT_ID", purpose: "which project to talk to", publishable: true },
      { name: "FIREBASE_API_KEY", purpose: "browser-side access", publishable: true },
      {
        name: "FIREBASE_SERVICE_ACCOUNT",
        purpose: "server-side admin access",
        publishable: false,
      },
    ],
    envFile: ".env.local",
    clientPrefix: "NEXT_PUBLIC_",
    docs: "https://firebase.google.com/docs/cli",
  },
  {
    id: "stripe",
    label: "Stripe",
    reach: ["cli", "api", "mcp"],
    cli: { bin: "stripe", install: "brew install stripe/stripe-cli/stripe" },
    secrets: [
      {
        name: "STRIPE_PUBLISHABLE_KEY",
        purpose: "browser-side checkout",
        publishable: true,
      },
      { name: "STRIPE_SECRET_KEY", purpose: "server-side charges", publishable: false },
      {
        name: "STRIPE_WEBHOOK_SECRET",
        purpose: "proving webhooks really came from Stripe",
        publishable: false,
      },
    ],
    envFile: ".env.local",
    docs: "https://docs.stripe.com/stripe-cli",
  },
];

export const providerById = (id: string): ServiceProvider | undefined =>
  SERVICE_PROVIDERS.find((p) => p.id === id);

export type LinkStep =
  | { kind: "install-cli"; bin: string; command: string; why: string }
  | { kind: "authenticate"; bin: string; command: string; why: string }
  | { kind: "collect-secret"; secret: ServiceSecret; why: string }
  | { kind: "write-env"; file: string; names: string[]; why: string };

export type LinkPlan =
  | { ok: true; provider: ServiceProvider; steps: LinkStep[]; summary: string }
  | { ok: false; refusal: LinkRefusal; why: string };

export type LinkRefusal = "unknown-provider" | "env-file-is-tracked";

export interface LinkContext {
  /** Whether the provider's CLI is on PATH. */
  cliInstalled: boolean;
  /** Whether that CLI already holds a session. */
  authenticated: boolean;
  /** Secret names the project's env file already defines. Values never come
   *  in here — presence is the only thing this needs to know. */
  presentSecrets: readonly string[];
  /** Whether git would track the env file. True means refuse. */
  envFileTracked: boolean;
}

/** Order matters: nothing can authenticate before the CLI exists, and nothing
 *  should be written before we know where it is going is safe. */
export function planLink(providerId: string, context: LinkContext): LinkPlan {
  const provider = providerById(providerId);
  if (!provider) {
    return {
      ok: false,
      refusal: "unknown-provider",
      why: `Build mode has no verified headless path to "${providerId}"`,
    };
  }
  if (context.envFileTracked) {
    return {
      ok: false,
      refusal: "env-file-is-tracked",
      why: `${provider.envFile} is tracked by git — writing keys there would commit them`,
    };
  }

  const steps: LinkStep[] = [];
  if (provider.cli && !context.cliInstalled) {
    steps.push({
      kind: "install-cli",
      bin: provider.cli.bin,
      command: provider.cli.install,
      why: `${provider.label} is driven by its CLI, which isn't installed yet`,
    });
  }
  if (provider.cli && !context.authenticated) {
    steps.push({
      kind: "authenticate",
      bin: provider.cli.bin,
      command: `${provider.cli.bin} login`,
      why: "this opens your browser once, and Canopy never sees the password",
    });
  }

  const present = new Set(context.presentSecrets);
  const missing = provider.secrets.filter((s) => !present.has(s.name));
  for (const secret of missing) {
    steps.push({
      kind: "collect-secret",
      secret,
      why: secret.publishable
        ? `${secret.purpose} — safe to ship to the browser`
        : `${secret.purpose} — must stay on the server`,
    });
  }
  if (missing.length > 0) {
    steps.push({
      kind: "write-env",
      file: provider.envFile,
      names: missing.map((s) => s.name),
      why: `${provider.envFile} is untracked, so these stay out of git`,
    });
  }

  return {
    ok: true,
    provider,
    steps,
    summary:
      steps.length === 0
        ? `${provider.label} is already linked.`
        : `Linking ${provider.label}: ${steps.length} step${steps.length === 1 ? "" : "s"}.`,
  };
}

/** What a client-exposed variable must be called for this project's framework
 *  to expose it. A publishable key with no prefix silently never reaches the
 *  browser, which reads as a broken integration rather than a naming mistake. */
export function clientVarName(provider: ServiceProvider, secret: ServiceSecret): string {
  if (!secret.publishable || !provider.clientPrefix) return secret.name;
  return secret.name.startsWith(provider.clientPrefix)
    ? secret.name
    : `${provider.clientPrefix}${secret.name}`;
}

/** A line for the env file. Kept here so the one place that formats a secret
 *  is the one place that can be audited for quoting. */
export function envLine(name: string, value: string): string {
  const needsQuotes = /[\s"'#$`\\]/.test(value);
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return needsQuotes ? `${name}="${escaped}"` : `${name}=${value}`;
}

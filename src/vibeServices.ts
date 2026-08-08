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
  /** Account-backed access is preferred to copied credentials. The account
   *  name is what Build asks the person to link when no authenticated API/MCP
   *  route is visible yet. */
  account?: { label: string; mcpAliases: string[] };
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
    account: { label: "Supabase", mcpAliases: ["supabase"] },
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
    account: { label: "Neon", mcpAliases: ["neon"] },
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
    account: { label: "Google", mcpAliases: ["firebase"] },
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
    account: { label: "Stripe", mcpAliases: ["stripe"] },
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
  | { kind: "use-linked-account"; reach: "api" | "mcp"; why: string }
  | { kind: "link-account"; accountLabel: string; why: string }
  | { kind: "install-cli"; bin: string; command: string; why: string }
  | { kind: "authenticate"; bin: string; command: string; why: string }
  | { kind: "collect-secret"; secret: ServiceSecret; why: string }
  | { kind: "write-env"; file: string; names: string[]; why: string };

export type LinkPlan =
  | { ok: true; provider: ServiceProvider; steps: LinkStep[]; summary: string }
  | { ok: false; refusal: LinkRefusal; why: string };

export type LinkRefusal = "unknown-provider" | "env-file-is-tracked";

export interface LinkContext {
  /** Authenticated provider access Canopy can already reach. API/MCP wins over
   *  CLI so a managed operation does not begin by asking for copied keys. */
  linkedReaches?: readonly ServiceReach[];
  /** Exact external MCP prefixes observed in enabled agent configuration.
   *  These contain names only; credentials remain in the provider server. */
  toolAllowances?: readonly string[];
  /** The host can pause and ask the person to connect this provider account. */
  accountLinkAvailable?: boolean;
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
  const linked = provider.reach.find(
    (reach): reach is "api" | "mcp" =>
      (reach === "api" || reach === "mcp") && context.linkedReaches?.includes(reach) === true,
  );
  if (linked) {
    steps.push({
      kind: "use-linked-account",
      reach: linked,
      why: `use the linked ${provider.account?.label ?? provider.label} account without copying a long-lived access token`,
    });
  } else if (provider.account && context.accountLinkAvailable) {
    steps.push({
      kind: "link-account",
      accountLabel: provider.account.label,
      why: `account-backed API access is preferred; ${provider.cli?.bin ?? "the provider CLI"} remains the fallback if linking is unavailable`,
    });
  } else if (provider.cli && !context.cliInstalled) {
    steps.push({
      kind: "install-cli",
      bin: provider.cli.bin,
      command: provider.cli.install,
      why: `${provider.label} is driven by its CLI, which isn't installed yet`,
    });
  }
  if (!linked && !context.accountLinkAvailable && provider.cli && !context.authenticated) {
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

/** Enabled MCP configs are the account/API route Build can use immediately.
 * Match provider-owned names and URLs only; a generic Google Drive server must
 * not gain Firebase authority merely because both accounts belong to Google. */
export function providerMcpToolAllowances(
  providerId: string,
  servers: readonly {
    name: string;
    url: string | null;
    enabled: boolean;
    sources: readonly { name: string; status: "enabled" | "disabled" | "pending" }[];
  }[],
): string[] {
  const aliases = providerById(providerId)?.account?.mcpAliases ?? [];
  if (aliases.length === 0) return [];
  const matches = (value: string) => {
    const words = value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    return aliases.some((alias) => words.includes(alias));
  };
  const allowances = new Set<string>();
  for (const server of servers) {
    if (!server.enabled || (!matches(server.name) && !matches(server.url ?? ""))) continue;
    for (const source of server.sources) {
      if (source.status !== "enabled" || !/^[A-Za-z0-9_-]+$/.test(source.name)) continue;
      allowances.add(`mcp__${source.name}`);
    }
  }
  return [...allowances];
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

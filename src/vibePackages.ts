// Managed package installation for Build mode.
//
// Build mode denies the agent a shell on purpose, so "add stripe" cannot be
// the agent running a command — it is the agent *asking*, and Canopy deciding.
// That inversion is the whole safety story here, and it only holds if the
// request can never become a command it wasn't:
//
//   - Every plan is an argv array. Never a shell string, so there is nothing
//     for a `;` or a backtick to escape into.
//   - A name that isn't a legal npm package name is refused, not sanitized.
//     Sanitizing invents a request the user never made.
//   - A leading `-` is refused even though it is otherwise legal-ish, because
//     an argument that reaches the runner as a flag is an injection whether or
//     not it passed the name rules.
//
// The runner comes from the lockfile first: the `packageManager` field states
// an intent, but a lockfile is evidence of what this project actually uses.

export type PackageRunner = "npm" | "pnpm" | "yarn" | "bun";

/** Lockfiles are evidence; the field is a claim. Evidence wins. */
const LOCKFILES: [string, PackageRunner][] = [
  ["pnpm-lock.yaml", "pnpm"],
  ["bun.lockb", "bun"],
  ["bun.lock", "bun"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
];

export function detectRunner(
  entries: readonly string[],
  packageManagerField?: string | null,
): PackageRunner {
  for (const [file, runner] of LOCKFILES) {
    if (entries.includes(file)) return runner;
  }
  const declared = (packageManagerField ?? "").split("@")[0];
  if (declared === "npm" || declared === "pnpm" || declared === "yarn" || declared === "bun") {
    return declared;
  }
  return "npm";
}

export interface PackageRequest {
  name: string;
  /** A semver range as the user said it — "^5.2.0", "latest", "5.2.0". */
  version?: string | null;
  dev?: boolean;
}

export type InstallPlan =
  | {
      ok: true;
      runner: PackageRunner;
      /** Argv, never a shell string. Element 0 is the runner binary. */
      argv: string[];
      cwd: string;
      /** What Ash says out loud before running it. */
      summary: string;
    }
  | { ok: false; refusal: InstallRefusal; why: string };

export type InstallRefusal =
  | "no-packages"
  | "too-many-packages"
  | "illegal-name"
  | "looks-like-a-flag"
  | "illegal-version";

/** npm's own naming rules, minus the deprecated-but-tolerated cases we have
 *  no reason to accept from a chat message. */
const NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
/** Deliberately narrow: ranges people actually type, nothing exotic enough to
 *  need a parser we would then have to trust. */
const VERSION = /^(?:latest|next|[~^]?\d+(?:\.\d+){0,2}(?:-[a-z0-9.]+)?)$/i;
const MAX_PACKAGES = 20;

const ADD_VERB: Record<PackageRunner, string> = {
  npm: "install",
  pnpm: "add",
  yarn: "add",
  bun: "add",
};

const DEV_FLAG: Record<PackageRunner, string> = {
  npm: "--save-dev",
  pnpm: "--save-dev",
  yarn: "--dev",
  bun: "--dev",
};

const list = (names: string[]) =>
  names.length === 1
    ? names[0]
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

export function planInstall(
  requests: readonly PackageRequest[],
  runner: PackageRunner,
  cwd: string,
): InstallPlan {
  if (requests.length === 0) {
    return { ok: false, refusal: "no-packages", why: "no package was named" };
  }
  if (requests.length > MAX_PACKAGES) {
    return {
      ok: false,
      refusal: "too-many-packages",
      why: `${requests.length} packages at once is more than Build mode will install unattended`,
    };
  }
  for (const request of requests) {
    const name = request.name.trim();
    if (name.startsWith("-")) {
      return {
        ok: false,
        refusal: "looks-like-a-flag",
        why: `"${name}" would reach ${runner} as a flag, not a package`,
      };
    }
    if (!NAME.test(name)) {
      return {
        ok: false,
        refusal: "illegal-name",
        why: `"${name}" is not a legal package name`,
      };
    }
    const version = request.version?.trim();
    if (version && !VERSION.test(version)) {
      return {
        ok: false,
        refusal: "illegal-version",
        why: `"${version}" is not a version range Build mode recognizes`,
      };
    }
  }

  // Dev and runtime dependencies cannot share one command without lying about
  // one of them, so the caller gets one plan per kind.
  const dev = requests.some((r) => r.dev);
  if (dev && requests.some((r) => !r.dev)) {
    return {
      ok: false,
      refusal: "too-many-packages",
      why: "runtime and dev dependencies need separate installs",
    };
  }

  const specs = requests.map((r) => {
    const version = r.version?.trim();
    return version ? `${r.name.trim()}@${version}` : r.name.trim();
  });
  const argv = [runner, ADD_VERB[runner], ...specs];
  if (dev) argv.push(DEV_FLAG[runner]);
  const names = requests.map((r) => r.name.trim());
  return {
    ok: true,
    runner,
    argv,
    cwd,
    summary: `Installing ${list(names)}${dev ? " as a dev dependency" : ""} with ${runner}.`,
  };
}

/** Whether a package is already there, so Ash can say "already installed"
 *  instead of running a command whose only effect is noise in the lockfile. */
export function alreadyInstalled(
  request: PackageRequest,
  dependencies: Readonly<Record<string, string>>,
  devDependencies: Readonly<Record<string, string>> = {},
): boolean {
  const name = request.name.trim();
  return name in dependencies || name in devDependencies;
}

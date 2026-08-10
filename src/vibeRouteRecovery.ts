import type { AccountStatus, AgentProfile, SetupReport } from "./ipc";
import { loginCommand } from "./profiles";
import { streamsStructured, type AgentCli } from "./projects";
import type { BuilderQuestionAction } from "./vibeBuilderSessionTypes";
import type { RouteCandidate } from "./vibeFailover";

export type VibeBuildCli = string;

export type VibeRouteRecoveryAction =
  | { kind: "install"; cli: VibeBuildCli }
  | { kind: "sign-in"; cli: VibeBuildCli }
  | { kind: "switch-account"; cli: VibeBuildCli }
  | { kind: "repair-integration"; cli: VibeBuildCli }
  | { kind: "agent-settings" };

export interface VibeRouteRecoveryResult {
  ok: boolean;
  prompt: string;
  detail?: string;
}

export interface VibeRecoveryTerminal {
  command: string;
  title: string;
  icon: string;
  run: false | "chore";
  env?: [string, string][];
  profile?: string;
}

export interface VibeRouteRecoveryDeps {
  clis: readonly AgentCli[];
  profiles: readonly AgentProfile[];
  activeProfileId: string;
  runTerminal(input: VibeRecoveryTerminal): void;
  profileAccounts(profileId: string): Promise<AccountStatus[]>;
  profileEnv(cli: string, profileId: string): Promise<[string, string][]>;
  setActiveProfile(profileId: string): void;
  primeLaunchEnv(): Promise<void>;
  setupAgentHooks(cli: string): Promise<SetupReport>;
  openAgentSettings(): void;
}

const RESPONSE_PREFIX = "vibe:route-recovery:";
const isBuildCli = (cli: string): cli is VibeBuildCli =>
  streamsStructured(cli);

export function routeRecoveryResponse(action: VibeRouteRecoveryAction): string {
  return action.kind === "agent-settings"
    ? `${RESPONSE_PREFIX}${action.kind}`
    : `${RESPONSE_PREFIX}${action.kind}:${action.cli}`;
}

export function parseRouteRecoveryResponse(
  response: string,
): VibeRouteRecoveryAction | null {
  if (!response.startsWith(RESPONSE_PREFIX)) return null;
  const [kind, cli, extra] = response.slice(RESPONSE_PREFIX.length).split(":");
  if (extra != null) return null;
  if (kind === "agent-settings" && cli == null) return { kind };
  if (!cli || !isBuildCli(cli)) return null;
  if (
    kind === "install" ||
    kind === "sign-in" ||
    kind === "switch-account" ||
    kind === "repair-integration"
  ) {
    return { kind, cli };
  }
  return null;
}

/** Turn fleet objections into the existing card contract. The response stays
 * private while the label is what the person sees in the transcript. Only the
 * two CLIs the dated structured-runner matrix admits can ever get an install
 * action; installing another registry entry cannot make it Build-capable. */
export function buildRouteRecoveryActions(
  candidates: readonly Pick<RouteCandidate, "cli" | "state">[],
  clis: readonly Pick<AgentCli, "id" | "name" | "install" | "rebound">[],
): BuilderQuestionAction[] {
  const names = new Map(clis.map((cli) => [cli.id, cli.name]));
  const installers = new Map(
    clis.map((cli) => [cli.id, Boolean(cli.install && !cli.rebound)]),
  );
  const actions: BuilderQuestionAction[] = [];
  const seen = new Set<string>();
  const add = (label: string, action: VibeRouteRecoveryAction) => {
    const response = routeRecoveryResponse(action);
    if (seen.has(response)) return;
    seen.add(response);
    actions.push({ label, response });
  };

  for (const candidate of candidates) {
    if (!isBuildCli(candidate.cli)) continue;
    const name = names.get(candidate.cli) ?? candidate.cli;
    const reasons = new Set(candidate.state.reasons);
    if (reasons.has("not-installed") && installers.get(candidate.cli)) {
      add(`Install ${name}`, { kind: "install", cli: candidate.cli });
    }
    if (reasons.has("signed-out") || reasons.has("auth-unknown")) {
      add(`Sign in to ${name}`, { kind: "sign-in", cli: candidate.cli });
      add(`Use another ${name} account`, {
        kind: "switch-account",
        cli: candidate.cli,
      });
    }
    if (reasons.has("integration-unhealthy")) {
      add(`Repair ${name} connection`, {
        kind: "repair-integration",
        cli: candidate.cli,
      });
    }
  }

  add("Agent settings & binary path", { kind: "agent-settings" });
  return actions;
}

const openSettingsResult = (
  deps: VibeRouteRecoveryDeps,
  detail: string,
): VibeRouteRecoveryResult => {
  deps.openAgentSettings();
  return {
    ok: true,
    prompt: "Agent settings are open.",
    detail,
  };
};

export async function executeVibeRouteRecovery(
  action: VibeRouteRecoveryAction,
  deps: VibeRouteRecoveryDeps,
): Promise<VibeRouteRecoveryResult> {
  if (action.kind === "agent-settings") {
    return openSettingsResult(
      deps,
      "Choose an agent binary, add an account, or repair its connection there.",
    );
  }

  const cli = deps.clis.find((candidate) => candidate.id === action.cli);
  if (!cli) {
    return openSettingsResult(
      deps,
      `Canopy could not find ${action.cli} in the current agent registry.`,
    );
  }

  if (action.kind === "install") {
    // This guard is repeated at execution time. A stale card must not turn a
    // later registry override into a vendor install that can never satisfy it.
    if (!isBuildCli(cli.id) || !cli.install || cli.rebound) {
      return openSettingsResult(
        deps,
        `${cli.name} is configured with a custom binary; set its path under Agents.`,
      );
    }
    deps.runTerminal({
      command: cli.install,
      title: `install ${cli.name}`,
      icon: "⬇",
      run: "chore",
    });
    return {
      ok: true,
      prompt: `Installing ${cli.name}.`,
      detail:
        "The install is running in Runs. Canopy will re-check agent availability when it exits.",
    };
  }

  if (action.kind === "sign-in") {
    const profile =
      deps.profiles.find((candidate) => candidate.id === deps.activeProfileId) ??
      deps.profiles[0];
    const profileId = profile?.id ?? deps.activeProfileId;
    const env = await deps.profileEnv(cli.id, profileId);
    deps.runTerminal({
      command: loginCommand(cli.bin),
      title: profile ? `${cli.name} — ${profile.label}` : `Sign in to ${cli.name}`,
      icon: cli.icon,
      run: false,
      env,
      profile: env.length > 0 ? profileId : undefined,
    });
    return {
      ok: true,
      prompt: `${cli.name} sign-in is open.`,
      detail: "Finish the provider's sign-in in the terminal, then retry your change.",
    };
  }

  if (action.kind === "switch-account") {
    const alternatives = deps.profiles.filter(
      (profile) => profile.id !== deps.activeProfileId,
    );
    const accounts = await Promise.all(
      alternatives.map(async (profile) => ({
        profile,
        accounts: await deps.profileAccounts(profile.id).catch(() => []),
      })),
    );
    const ready = accounts.find(({ accounts: rows }) =>
      rows.some((row) => row.agent === cli.id && row.state === "in"),
    );
    if (!ready) {
      return openSettingsResult(
        deps,
        `No other saved account is signed in to ${cli.name}. Add or sign in an account under Agents.`,
      );
    }
    deps.setActiveProfile(ready.profile.id);
    // setActiveProfile deliberately does not block on IPC. Build cannot race
    // that fire-and-forget cache refresh or its next agent would launch under
    // the old account while the card claims the switch already happened.
    await deps.primeLaunchEnv();
    return {
      ok: true,
      prompt: `Switched to ${ready.profile.label}.`,
      detail: `${cli.name} will use that account on the next Build attempt.`,
    };
  }

  const report = await deps.setupAgentHooks(cli.id);
  return report.ok
    ? {
        ok: true,
        prompt: `${cli.name}'s Canopy connection is repaired.`,
        detail: report.summary,
      }
    : {
        ok: false,
        prompt: `I couldn't finish repairing ${cli.name}.`,
        detail: report.summary,
      };
}

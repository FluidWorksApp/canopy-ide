import * as ipc from "./ipc";
import { fleetState, type FleetState } from "./fleetState";
import { planFor } from "./planUsage";
import { DEFAULT_PROFILE, supportsProfiles } from "./profiles";
import type { AgentCli } from "./projects";

type FleetCli = Pick<AgentCli, "id" | "name" | "bin">;

export interface FleetEvidence {
  accounts: Record<string, ipc.AccountStatus[] | undefined>;
  plans?: ipc.PlanUsage[];
  health?: ipc.IntegrationHealth[];
}

export interface FleetRouteSnapshot {
  cli: FleetCli;
  profile: string;
  state: FleetState;
  account?: ipc.AccountStatus;
  plan: ipc.PlanUsage | null;
  health?: ipc.IntegrationHealth;
}

export function fleetRouteFromEvidence(
  cli: FleetCli,
  profile: string,
  installed: Record<string, boolean>,
  evidence: FleetEvidence,
  now = Date.now(),
): FleetRouteSnapshot {
  const account = evidence.accounts[profile]?.find((row) => row.agent === cli.id);
  const plan = planFor(evidence.plans ?? [], cli.id, profile);
  // agentIntegrationHealth currently reads the default config root only. A
  // non-default profile gets no health claim rather than borrowing that answer.
  const health =
    profile === DEFAULT_PROFILE
      ? evidence.health?.find((row) => row.agent === cli.id)
      : undefined;
  return {
    cli,
    profile,
    account,
    plan,
    health,
    state: fleetState(
      {
        agent: cli.id,
        profile,
        installed: installed[cli.bin] === true,
        account,
        plan,
        health,
      },
      now,
    ),
  };
}

async function optional<T>(read: Promise<T>): Promise<T | undefined> {
  try {
    return await read;
  } catch {
    return undefined;
  }
}

export async function inspectFleetRoute(
  cli: FleetCli,
  profile: string,
  installed: Record<string, boolean>,
): Promise<FleetRouteSnapshot> {
  const [accounts, plans, health] = await Promise.all([
    optional(ipc.profileAccounts(profile)),
    optional(ipc.planUsage()),
    profile === DEFAULT_PROFILE
      ? optional(ipc.agentIntegrationHealth())
      : Promise.resolve(undefined),
  ]);
  return fleetRouteFromEvidence(cli, profile, installed, {
    accounts: { [profile]: accounts },
    plans,
    health,
  });
}

export async function inspectFleetTable(
  clis: readonly FleetCli[],
  profiles: readonly ipc.AgentProfile[],
  installed: Record<string, boolean>,
): Promise<FleetRouteSnapshot[]> {
  const [accountRows, plans, health] = await Promise.all([
    Promise.all(
      profiles.map(async (profile) => [
        profile.id,
        await optional(ipc.profileAccounts(profile.id)),
      ] as const),
    ),
    optional(ipc.planUsage()),
    optional(ipc.agentIntegrationHealth()),
  ]);
  const evidence: FleetEvidence = {
    accounts: Object.fromEntries(accountRows),
    plans,
    health,
  };
  return profiles.flatMap((profile) =>
    clis
      .filter(
        (cli) => profile.id === DEFAULT_PROFILE || supportsProfiles(cli.id),
      )
      .map((cli) => fleetRouteFromEvidence(cli, profile.id, installed, evidence)),
  );
}

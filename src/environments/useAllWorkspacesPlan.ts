// Reads every running machine for "All workspaces" and plans where each of
// their projects and terminals goes (allProjects.ts). One poller for the
// window, so a project that is asleep here, or that only another machine has,
// is still accounted for: per-project polling only ever ran inside an open,
// awake project and never saw the rest.
//
// Running machines only: reading one never wakes or resumes it.
import { useEffect, useRef, useState } from "react";
import { invoke as hostInvoke, isRemoteHost, isWorkspaceHost } from "../host";
import { nativeHost } from "../host/native";
import { activeWorkspace } from "../remoteExecution/workspace";
import { peekMachines, savedMachines } from "../machines/inventory";
import { repoResolver, type RepoMachine } from "../machines/repoIdentity";
import { connectMachine, joinThisMac, leaveThisMac } from "./live";
import { machineBadge, parseMachineSessions, THIS_MAC_ENV, workspacesToJoin } from "./allWorkspaceTabs";
import { planAllWorkspaces, type AllPlan, type MachineRead, type StoreProject } from "./allProjects";

const POLL_MS = 15_000;
const READ_TIMEOUT_MS = 10_000;
/** A machine that did not answer is left alone this long. */
const UNREACHABLE_MS = 60_000;

export const EMPTY_PLAN: AllPlan = { joins: new Map(), visiting: [] };

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

function withTimeout<T>(run: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    run,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timed out")), READ_TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** A machine's store and live terminals. Throws when it cannot be read. */
export async function readMachine(env: string, name: string, invoke: Invoke): Promise<MachineRead> {
  const [text, stats] = await Promise.all([
    withTimeout(invoke<string>("store_load")),
    withTimeout(invoke<unknown>("pty_stats")),
  ]);
  const store = (typeof text === "string" ? JSON.parse(text) : text) as { projects?: StoreProject[]; openIds?: string[] } | null;
  return {
    env,
    name: machineBadge(name),
    projects: Array.isArray(store?.projects) ? store.projects : [],
    openIds: Array.isArray(store?.openIds) ? store.openIds : [],
    sessions: parseMachineSessions(stats),
  };
}

/** Same plan? Compared by what the strip shows, so an unchanged pass does not re-render. */
function planKey(plan: AllPlan): string {
  const joins = [...plan.joins].map(([id, list]) => `${id}=${list.map((s) => `${s.env}:${s.session.id}:${s.session.title ?? ""}`).join(",")}`);
  const visiting = plan.visiting.map((v) => `${v.id}|${v.name}|${v.machines.join(",")}|${v.sessions.map((s) => `${s.env}:${s.session.id}:${s.session.title ?? ""}`).join(",")}`);
  return [...joins.sort(), "#", ...visiting].join("\n");
}

export function useAllWorkspacesPlan(on: boolean, primary: readonly StoreProject[]): AllPlan {
  const [plan, setPlan] = useState<AllPlan>(EMPTY_PLAN);
  const primaryRef = useRef(primary);
  primaryRef.current = primary;
  useEffect(() => {
    if (!on) {
      leaveThisMac();
      setPlan(EMPTY_PLAN);
      return;
    }
    let live = true;
    let running = false;
    let lastKey = "";
    const unreachableUntil = new Map<string, number>();
    const here = (): RepoMachine => ({
      env: isRemoteHost() ? `remote:${activeWorkspace()?.connection.workspaceId ?? "active"}` : THIS_MAC_ENV,
      invoke: hostInvoke,
      desktop: !isRemoteHost(),
    });
    const pass = async () => {
      const reads: MachineRead[] = [];
      const machines = new Map<string, RepoMachine>();
      const attempt = async (key: string, env: string, read: () => Promise<{ name: string; invoke: Invoke; desktop?: boolean }>) => {
        if ((unreachableUntil.get(key) ?? 0) > Date.now()) return;
        try {
          const machine = await read();
          reads.push(await readMachine(env, machine.name, machine.invoke));
          machines.set(env, { env, invoke: machine.invoke, desktop: machine.desktop });
          unreachableUntil.delete(key);
        } catch (error) {
          unreachableUntil.set(key, Date.now() + UNREACHABLE_MS);
          console.warn(`[all-workspaces] could not read ${key}: ${String((error as Error)?.message ?? error)}`);
        }
      };
      // While a workspace is the window's own machine, this Mac is one of the others.
      if (isWorkspaceHost()) {
        joinThisMac();
        await attempt(THIS_MAC_ENV, THIS_MAC_ENV, async () => ({
          name: "This Mac",
          invoke: (command, args) => nativeHost.invoke(command, args),
          desktop: true,
        }));
      }
      await savedMachines();
      if (!live) return;
      for (const workspace of workspacesToJoin(peekMachines(), activeWorkspace()?.connection.workspaceId)) {
        await attempt(workspace.id, `remote:${workspace.id}`, async () => {
          const machine = await connectMachine(workspace.id);
          return { name: machine.name, invoke: machine.invoke };
        });
        if (!live) return;
      }
      const primaryMachine = here();
      const next = await planAllWorkspaces(
        primaryRef.current,
        reads,
        async (env, project) => {
          const machine = env === "primary" ? primaryMachine : machines.get(env);
          if (!machine) return [];
          const found = await Promise.all(project.components.map((c) => repoResolver.repoOf(machine, c.path)));
          return found.filter((repo): repo is NonNullable<typeof repo> => !!repo);
        },
      );
      if (!live) return;
      const key = planKey(next);
      if (key === lastKey) return;
      lastKey = key;
      setPlan(next);
    };
    const tick = async () => {
      if (running) return;
      running = true;
      try {
        await pass();
      } catch (error) {
        console.warn(`[all-workspaces] pass failed: ${String((error as Error)?.message ?? error)}`);
      } finally {
        running = false;
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [on]);
  return plan;
}

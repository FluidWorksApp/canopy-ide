// Moving a Claude agent to a workspace, end to end: choose the workspace, read
// both machines, show what comes along (TeleportDialog), run the move
// (teleport/sessionMove.ts), and hand the window over at the end. All machine
// work goes through teleport/deps.ts; stopping, restoring and continuing the
// agent are the host view's own terminal paths, passed in.
import { TELEPORT_CLI_ID } from "../../shared/agentCliIdentity";
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { invoke as hostInvoke } from "../host";
import { useEffect, useMemo, useRef, useState } from "react";
import { Dialog } from "./Dialog";
import { TeleportDialog } from "./TeleportDialog";
import * as ipc from "../ipc";
import type { Project } from "../projects";
import { canonicalProjectId } from "../placement/identity";
import { openTemporaryWorkspace, type Invoke, type TemporaryWorkspace } from "../remoteExecution/temporaryWorkspace";
import { activeWorkspace } from "../remoteExecution/workspace";
import { peekWorkspaceList, refreshWorkspaceList } from "../remoteExecution/workspaceListCache";
import { sendTargets } from "../remoteExecution/SendToWorkspace";
import type { ManagedWorkspace } from "../remoteExecution/ManagedWorkspaces";
import { branchHeldElsewhere, carrySendFiles, isDirty, mirrorSendFiles, readRepoState, sha256Hex, teleportHome, transcriptIo } from "../teleport/deps";
import { chosen, defaultSelection, ignoredItem, type TeleportItem, type TeleportProgress } from "../teleport/selection";
import { checkMove, rebaseCwd, runMove, type MoveProject, type MovePlan } from "../teleport/sessionMove";

const local = <T,>(command: string, args?: Record<string, unknown>) => tauriInvoke<T>(command, args);
/** The machine the window is attached to: a workspace when connected to one. */
const here = <T,>(command: string, args?: Record<string, unknown>) => hostInvoke<T>(command, args);

/** The pseudo workspace id `continueOnDestination` receives when the agent moves to this Mac. */
export const TELEPORT_TO_MAC = "local";

/** The machine the agent is going to. */
interface DestEnd {
  invoke: Invoke;
  workspaceId: string;
  workspaceName: string;
}

export interface TeleportAgent {
  sessionId: string;
  cwd: string;
  idle: boolean;
  model?: string;
  /** Set when the agent runs in its own worktree. */
  worktree?: { root: string; repo: string; branch: string };
}

export function TeleportFlow({
  project,
  agent,
  onClose,
  onNotice,
  stopAgent,
  restoreAgent,
  continueOnDestination,
  onLinkProject,
  direction = "toWorkspace",
}: {
  project: Project;
  agent: TeleportAgent;
  onClose: () => void;
  onNotice: (text: string, tone: "info" | "warn" | "error" | "success") => void;
  /** Close the agent's tab here; its conversation is final once this resolves. */
  stopAgent: () => Promise<void>;
  /** Reopen it here after a failure. */
  restoreAgent: () => Promise<void>;
  /** Switch the window to the workspace and resume the session there. */
  continueOnDestination: (workspaceId: string, sessionId: string, cwd: string) => Promise<void>;
  onLinkProject: (env: string, id: string) => void;
  /** `toMac` is for a window connected to a workspace: the agent runs there and
   *  moves to this Mac. `continueOnDestination` then gets `TELEPORT_TO_MAC`. */
  direction?: "toWorkspace" | "toMac";
}) {
  const toMac = direction === "toMac";
  // The machine the agent is on now, and the one it is going to.
  const sourceInvoke = toMac ? here : local;
  const [workspaces, setWorkspaces] = useState<ManagedWorkspace[]>(() => sendTargets(peekWorkspaceList()?.workspaces ?? []));
  const [pick, setPick] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState("");
  const [temp, setTemp] = useState<DestEnd | null>(null);
  const tempRef = useRef<TemporaryWorkspace | null>(null);
  const [reasons, setReasons] = useState<string[]>([]);
  const [plan, setPlan] = useState<MovePlan | null>(null);
  const [items, setItems] = useState<TeleportItem[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState<TeleportProgress | null>(null);
  const [homes, setHomes] = useState<{ source: string; dest: string } | null>(null);
  const cancelled = useRef(false);
  const component = useMemo(
    () =>
      agent.worktree
        ? project.components.find((c) => c.path === agent.worktree?.repo)
        : project.components.find((c) => agent.cwd === c.path || agent.cwd.startsWith(`${c.path}/`)),
    [project, agent.cwd, agent.worktree],
  );

  useEffect(() => {
    let live = true;
    void refreshWorkspaceList().then((r) => live && setWorkspaces(sendTargets(r.workspaces))).catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => () => tempRef.current?.dispose(), []);

  const connect = async () => {
    if (!component || (!toMac && !pick)) return;
    setConnecting(true);
    setError("");
    try {
      let destEnd: DestEnd;
      if (toMac) {
        destEnd = { invoke: local, workspaceId: TELEPORT_TO_MAC, workspaceName: "This Mac" };
      } else {
        const ws = await openTemporaryWorkspace(pick as string);
        tempRef.current?.dispose();
        tempRef.current = ws;
        destEnd = ws;
      }
      const sourceRoot = agent.worktree?.root ?? component.path;
      const [source, dest, destStore, sourceRepo] = await Promise.all([
        teleportHome(sourceInvoke),
        teleportHome(destEnd.invoke),
        destEnd.invoke<string>("store_load"),
        readRepoState(sourceInvoke, sourceRoot),
      ]);
      const store = JSON.parse(destStore) as { projects: MoveProject[] };
      const env = toMac ? "local" : `remote:${pick}`;
      const sourceEnv = toMac ? `remote:${activeWorkspace()?.connection.workspaceId ?? ""}` : "local";
      const sourceEnd = { env: sourceEnv, project: project as unknown as MoveProject, home: source };
      // The repository facts below belong to the destination component the
      // project record points at, so they are read before the real check.
      let destRepo = null;
      let destDirty = false;
      let held = false;
      const counterpart = store.projects.find((p) => canonicalProjectId(p) === canonicalProjectId(project));
      const destComponent = counterpart?.components.find((c) => c.label === component.label) ?? counterpart?.components[0];
      if (destComponent) {
        destRepo = await readRepoState(destEnd.invoke, destComponent.path).catch(() => null);
        destDirty = await isDirty(destEnd.invoke, destComponent.path).catch(() => false);
        // A worktree agent gets a worktree of its own there, so the branch being
        // held elsewhere is reported when it is created.
        held = agent.worktree ? false : await branchHeldElsewhere(destEnd.invoke, destComponent.path, sourceRepo.branch).catch(() => false);
      }
      const result = checkMove({
        agent: { cli: TELEPORT_CLI_ID, sessionId: agent.sessionId, model: agent.model, cwd: agent.cwd, idle: agent.idle, worktree: agent.worktree },
        source: sourceEnd,
        dest: { env, home: dest },
        destProjects: store.projects,
        sourceRepo,
        destRepo,
        destDirty,
        branchHeldElsewhere: held,
      });
      // Ignored files travel through the project mirror, which only writes TO a
      // workspace and writes into the main checkout: not offered going back to
      // this Mac, nor for an agent in a worktree. Commits and tracked changes
      // always go (bundle and patch).
      const offerIgnored = !toMac && !agent.worktree;
      const candidates = offerIgnored
        ? await ipc.mirrorCandidates(project.id, component.id).catch(() => ({ relative: "", files: [] }))
        : { relative: "", files: [] };
      const status = await sourceInvoke<{ entries: unknown[] }>("git_status", { path: sourceRoot }).catch(() => ({ entries: [] as unknown[] }));
      const rows: TeleportItem[] = [
        { id: "changes", kind: "changes", label: `${status.entries.length} changed file${status.entries.length === 1 ? "" : "s"}`, detail: "with the commits" },
        ...candidates.files.map((f) => ignoredItem(f.path)),
        { id: "conversation", kind: "conversation", label: "The conversation", required: true },
      ];
      setItems(rows);
      setSelected(defaultSelection(rows));
      setHomes({ source, dest });
      setReasons(result.ok ? [] : result.reasons);
      setPlan(result.ok ? result.plan : null);
      setTemp(destEnd);
    } catch (e) {
      setError(`Could not prepare the move: ${String((e as Error)?.message ?? e)}`);
    } finally {
      setConnecting(false);
    }
  };

  // Going to this Mac there is nothing to choose or connect: prepare at once.
  useEffect(() => {
    if (toMac && component) void connect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const start = async () => {
    if (!plan || !temp || !component || !homes) return;
    cancelled.current = false;
    setProgress({ step: "prepare" });
    const files = chosen(items, selected)
      .filter((id) => id.startsWith("ignored:"))
      .map((id) => id.slice("ignored:".length));
    const sourceRoot = agent.worktree?.root ?? component.path;
    let destRoot = "";
    const send =
      toMac || agent.worktree
        ? carrySendFiles({
            source: sourceInvoke,
            dest: temp.invoke,
            sourceRepo: component.path,
            ...(agent.worktree ? { worktree: { root: agent.worktree.root, branch: agent.worktree.branch } } : {}),
          })
        : mirrorSendFiles({
            source: local,
            dest: temp.invoke,
            projectId: project.id,
            componentId: component.id,
            files,
            sourceRepo: component.path,
          });
    const io = transcriptIo({
      source: sourceInvoke,
      dest: temp.invoke,
      agent: { cwd: plan.agent.cwd, sessionId: agent.sessionId },
      destCwd: () => rebaseCwd(plan.agent.cwd, sourceRoot, destRoot) ?? destRoot,
    });
    const repo = await readRepoState(sourceInvoke, sourceRoot);
    const destEnvKey = toMac ? "local" : `remote:${temp.workspaceId}`;
    const outcome = await runMove(plan, {
      selection: files,
      sourceRoot,
      repo: { head: repo.head, origin: repo.origin, branch: repo.branch, worktree: null },
      async sendFiles(p, sel, onProgress) {
        const sent = await send(p, sel, onProgress);
        destRoot = sent.destRoot;
        return sent;
      },
      stopSource: () => stopAgent(),
      restoreSource: () => restoreAgent(),
      ...io,
      sha256: sha256Hex,
      resumeTarget: async (_p, args) => {
        await continueOnDestination(temp.workspaceId, args.sessionId, args.cwd);
      },
      saveLinks: async (next) => {
        onLinkProject(destEnvKey, next.dest.id);
        const store = JSON.parse(await temp.invoke<string>("store_load")) as { projects: MoveProject[] };
        store.projects = store.projects.map((p) => (p.id === next.dest.id ? next.dest : p));
        await temp.invoke("store_save", { data: JSON.stringify(store) });
      },
      onStep: (step, state, detail) => {
        if (state === "failed") setProgress({ step, failed: detail?.error ?? "Failed" });
        else setProgress({ step, fraction: state === "done" ? 1 : detail?.fraction });
      },
      isCancelled: () => cancelled.current,
    });
    if (outcome.ok) {
      onNotice(`Moved the agent to ${temp.workspaceName}.`, "success");
      onClose();
    } else {
      onNotice(
        `Teleport stopped at ${outcome.step}: ${outcome.error}${outcome.sourceStopped ? (outcome.sourceRestored ? " The agent was reopened here." : " The agent here was stopped.") : " Nothing was changed."}`,
        "error",
      );
    }
  };

  if (!component) {
    return (
      <Dialog title="Teleport" size="md" dismissLabel="Close" onDismiss={onClose} body={<p>This agent's folder is not inside a component of the project, so it cannot be moved.</p>} />
    );
  }
  if (toMac && !temp) {
    return (
      <Dialog
        title="Teleport to this Mac"
        size="md"
        dismissLabel="Cancel"
        onDismiss={onClose}
        body={error ? <p className="workspace-feedback error" role="alert">{error}</p> : <p role="status">Preparing…</p>}
      />
    );
  }
  if (!temp || (!plan && reasons.length === 0)) {
    return (
      <Dialog
        title="Teleport to a workspace"
        size="md"
        dismissLabel="Cancel"
        onDismiss={onClose}
        actions={[{ label: connecting ? "Connecting…" : "Continue", primary: true, disabled: !pick || connecting, onClick: () => void connect() }]}
        body={
          <div>
            {workspaces.length === 0 && <p role="status">No workspace is running that you can connect to.</p>}
            <div role="radiogroup" aria-label="Workspace" className="cpick-machine-options">
              {workspaces.map((w) => (
                <button key={w.id} type="button" role="radio" aria-checked={pick === w.id} className={pick === w.id ? "is-selected" : ""} onClick={() => setPick(w.id)}>
                  {w.name}
                </button>
              ))}
            </div>
            {error && <p className="workspace-feedback error" role="alert">{error}</p>}
          </div>
        }
      />
    );
  }
  return (
    <TeleportDialog
      destinationName={temp.workspaceName}
      agentLabel={`claude · ${component.label}`}
      items={items}
      selected={selected}
      onSelectedChange={setSelected}
      reasons={reasons}
      progress={progress}
      onTeleport={() => void start()}
      onCancel={() => {
        cancelled.current = true;
        if (!progress || progress.failed) onClose();
      }}
    />
  );
}

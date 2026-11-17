// Send a project to a workspace the window is not connected to: pick a ready
// workspace, then the same setup the launch flow uses (repository on the same
// branch with unpushed commits and changes, chosen ignored files), run against a
// temporary connection so the window stays where it is. See docs/teleport-design.md,
// phase 1: files only, no session move.
import { useEffect, useRef, useState } from "react";
import { Button } from "../components/ui";
import { peekMachines, reachableMachines, refreshMachines, restoreMachines, subscribeMachines, type Machine } from "../machines/inventory";
import { ProjectSetupDialog } from "./ProjectSetupDialog";
import { openTemporaryWorkspace, type TemporaryWorkspace } from "./temporaryWorkspace";

/** Machines a project can be sent to: ready, and this account may connect.
 *  Cloud workspaces and the person's own machines alike (machines/inventory.ts). */
export const sendTargets = reachableMachines;

/** The machines to offer: every reachable one except `here`, the workspace
 *  this window is attached to (absent on this Mac). */
export function otherMachines(machines: readonly Machine[], here?: string): Machine[] {
  return reachableMachines(machines).filter((m) => m.id !== here);
}

let lastTargetsFetch = 0;
/** Fetch the list at most once a minute however many callers ask. */
function refreshTargetsSoon() {
  if (Date.now() - lastTargetsFetch < 60_000) return;
  lastTargetsFetch = Date.now();
  void refreshMachines();
}
/** Whether there is any machine this project could be sent to. Unknown counts
 *  as none, so the offer appears only once a ready one is seen. Checked
 *  again when the window regains focus and when the account changes. */
export function useHasSendTargets(here?: string): boolean {
  const [has, setHas] = useState(() => otherMachines(peekMachines(), here).length > 0);
  useEffect(() => {
    const unsubscribe = subscribeMachines((machines) => setHas(otherMachines(machines, here).length > 0));
    void restoreMachines()
      .then((machines) => setHas(otherMachines(machines, here).length > 0))
      .catch(() => {})
      .finally(refreshTargetsSoon);
    const onAccount = () => {
      setHas(false);
      lastTargetsFetch = 0;
      refreshTargetsSoon();
    };
    window.addEventListener("focus", refreshTargetsSoon);
    window.addEventListener("canopy:account-changed", onAccount);
    return () => {
      unsubscribe();
      window.removeEventListener("focus", refreshTargetsSoon);
      window.removeEventListener("canopy:account-changed", onAccount);
    };
  }, [here]);
  return has;
}

export function SendToWorkspace({
  projectId,
  projectName,
  components,
  here,
}: {
  projectId: string;
  projectName: string;
  components: { componentId: string; label: string }[];
  /** The workspace this window is attached to, which is never offered. */
  here?: string;
}) {
  const [workspaces, setWorkspaces] = useState<Machine[]>(() => otherMachines(peekMachines(), here));
  const [chosen, setChosen] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<TemporaryWorkspace | null>(null);
  const openRef = useRef<TemporaryWorkspace | null>(null);

  useEffect(() => {
    let live = true;
    void refreshMachines().then((r) => {
      if (!live) return;
      const machines = otherMachines(r.machines, here);
      setWorkspaces(machines);
      // The account being unreachable only matters when it leaves nothing to pick.
      if (r.failure && machines.length === 0) setError(`Could not read your workspaces: ${r.failure}`);
    });
    return () => {
      live = false;
    };
  }, [here]);

  // Always let go of the connection: it holds a heartbeat until disposed.
  useEffect(() => () => openRef.current?.dispose(), []);

  const connect = async () => {
    if (!chosen) return;
    setConnecting(true);
    setError("");
    try {
      const ws = await openTemporaryWorkspace(chosen);
      openRef.current?.dispose();
      openRef.current = ws;
      setOpen(ws);
    } catch (e) {
      setError(`Could not connect: ${String((e as Error)?.message ?? e)}`);
    } finally {
      setConnecting(false);
    }
  };

  if (open) {
    return (
      <ProjectSetupDialog
        projectId={projectId}
        projectName={projectName}
        workspaceName={open.workspaceName}
        components={components}
        remoteInvoke={open.invoke}
        target={open.connection}
        root={open.root}
      />
    );
  }

  return (
    <div className="mirror-setup" role="group" aria-label={`Send ${projectName} to a workspace`}>
      <p className="workspace-description">
        Choose a workspace to send {projectName} to. Your window stays here.
      </p>
      {workspaces.length === 0 && !error && <p className="workspace-description" role="status">No workspace or machine of yours is running that you can connect to.</p>}
      <div role="radiogroup" aria-label="Workspace" className="cpick-machine-options">
        {workspaces.map((w) => (
          <button
            key={w.id}
            type="button"
            role="radio"
            aria-checked={chosen === w.id}
            className={chosen === w.id ? "is-selected" : ""}
            onClick={() => setChosen(w.id)}
          >
            {w.name}
            {w.kind === "own" && <span className="cpick-machine-kind"> · your machine</span>}
          </button>
        ))}
      </div>
      {error && <p className="workspace-feedback error" role="alert">{error}</p>}
      <div className="account-sync-footer">
        <Button variant="accent" disabled={!chosen || connecting} onClick={() => void connect()}>
          {connecting ? "Connecting…" : "Continue"}
        </Button>
      </div>
    </div>
  );
}

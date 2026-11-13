// Send a project to a workspace the window is not connected to: pick a ready
// workspace, then the same setup the launch flow uses (repository on the same
// branch with unpushed commits and changes, chosen ignored files), run against a
// temporary connection so the window stays where it is. See docs/teleport-design.md,
// phase 1: files only, no session move.
import { useEffect, useRef, useState } from "react";
import { Button } from "../components/ui";
import type { ManagedWorkspace } from "./ManagedWorkspaces";
import { peekWorkspaceList, refreshWorkspaceList, restoreWorkspaceList, subscribeWorkspaceList } from "./workspaceListCache";
import { ProjectSetupDialog } from "./ProjectSetupDialog";
import { openTemporaryWorkspace, type TemporaryWorkspace } from "./temporaryWorkspace";

/** Workspaces a project can be sent to: ready, and this account may connect. */
export const sendTargets = (workspaces: readonly ManagedWorkspace[]): ManagedWorkspace[] =>
  workspaces.filter((w) => w.state === "ready" && w.access?.canConnect !== false);

let lastTargetsFetch = 0;
/** Fetch the list at most once a minute however many callers ask. */
function refreshTargetsSoon() {
  if (Date.now() - lastTargetsFetch < 60_000) return;
  lastTargetsFetch = Date.now();
  void refreshWorkspaceList().catch(() => {});
}
/** Whether there is any workspace this project could be sent to. Unknown counts
 *  as none, so the offer appears only once a ready workspace is seen. Checked
 *  again when the window regains focus and when the account changes. */
export function useHasSendTargets(): boolean {
  const [has, setHas] = useState(() => sendTargets(peekWorkspaceList()?.workspaces ?? []).length > 0);
  useEffect(() => {
    const unsubscribe = subscribeWorkspaceList((snap) => setHas(sendTargets(snap.workspaces).length > 0));
    void restoreWorkspaceList()
      .then((snap) => { if (snap) setHas(sendTargets(snap.workspaces).length > 0); })
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
  }, []);
  return has;
}

export function SendToWorkspace({
  projectId,
  projectName,
  components,
}: {
  projectId: string;
  projectName: string;
  components: { componentId: string; label: string }[];
}) {
  const [workspaces, setWorkspaces] = useState<ManagedWorkspace[]>(() => sendTargets(peekWorkspaceList()?.workspaces ?? []));
  const [chosen, setChosen] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<TemporaryWorkspace | null>(null);
  const openRef = useRef<TemporaryWorkspace | null>(null);

  useEffect(() => {
    let live = true;
    void refreshWorkspaceList()
      .then((r) => live && setWorkspaces(sendTargets(r.workspaces)))
      .catch((e) => live && setError(`Could not read your workspaces: ${String((e as Error)?.message ?? e)}`));
    return () => {
      live = false;
    };
  }, []);

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
      />
    );
  }

  return (
    <div className="mirror-setup" role="group" aria-label={`Send ${projectName} to a workspace`}>
      <p className="workspace-description">
        Choose a workspace to send {projectName} to. Your window stays here.
      </p>
      {workspaces.length === 0 && !error && <p className="workspace-description" role="status">No workspace is running that you can connect to.</p>}
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

import { useEffect, useState } from "react";
import * as ipc from "../ipc";
import type { ManagedWorkspace } from "../remoteExecution/ManagedWorkspaces";
import { peekWorkspaceList, refreshWorkspaceList } from "../remoteExecution/workspaceListCache";
import { Select, Switch } from "./ui";

const owned = (list: ManagedWorkspace[] | undefined) =>
  (list ?? []).filter((w) => w.access?.owner !== false && w.state !== "deleted" && w.state !== "deleting");

/** The owner's opt-in for their cloud workspace to answer Slack while no
 *  desktop is polling (docs/slack-hub-protocol.md §7). The hub arbitrates;
 *  this only records which workspace, if any, may. */
export function SlackWorkspaceCompanion({
  current,
  onChange,
}: {
  current: ipc.SlackWorkspaceCompanion | null;
  onChange: () => void;
}) {
  const [workspaces, setWorkspaces] = useState(() => owned(peekWorkspaceList()?.workspaces));
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    refreshWorkspaceList()
      .then((r) => live && setWorkspaces(owned(r.workspaces)))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  if (workspaces.length === 0 && !current) return null;
  const target = current?.workspaceId ?? picked ?? workspaces[0]?.id ?? "";
  const set = async (workspaceId: string, enabled: boolean) => {
    setBusy(true);
    try {
      await ipc.slackHub("workspace-companion", { workspaceId, enabled });
      setError(null);
      onChange();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="set-item-control set-inline">
        <Switch
          checked={current != null}
          disabled={busy || !target}
          onChange={(on) => void set(target, on)}
          aria-label="Answer Slack from my workspace when my desktop is offline"
        />
        <span className="set-item-desc">Answer Slack from my workspace when my desktop is offline</span>
        {workspaces.length > 1 && (
          <Select
            width="sm"
            value={target}
            disabled={busy}
            aria-label="Workspace that answers Slack"
            onChange={(e) => (current ? void set(e.target.value, true) : setPicked(e.target.value))}
          >
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </Select>
        )}
      </div>
      {error && (
        <div className="set-item-desc set-error" role="alert">
          {error}
        </div>
      )}
    </>
  );
}

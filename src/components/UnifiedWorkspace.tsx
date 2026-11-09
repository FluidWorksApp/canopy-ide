// One panel for everything Canopy can run or see: this Mac, cloud workspaces,
// T3 Code machines. Reads are read-only; opening or handing off goes through
// the callbacks the shell supplies. See docs/placement-and-unified-workspace.md
// for what can and cannot be read from a target that is not the active host.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Gathered } from "../placement/gather";
import { decideHandoff } from "../placement/launch";
import { getGlobalPreference, setGlobalPreference } from "../placement/preferences";
import { filterRows, groupByProject, type UnifiedFilter, type UnifiedRow } from "../placement/unified";
import { targetKey, type PlacementDecision, type Preference, type ResourceSnapshot } from "../placement/types";
import { PlacementPicker, targetName } from "./PlacementPicker";
import { Button } from "./ui";

const load = async (): Promise<Gathered> => (await import("../placement/gather")).gatherUnified();

function LoadBar({ r, name }: { r: ResourceSnapshot; name: string }) {
  const pct = r.online && r.capacity > 0 ? Math.min(100, Math.round((r.activeAgents / r.capacity) * 100)) : 0;
  return (
    <li className="unified-load">
      <span>{name}</span>
      {r.online ? (
        <>
          <progress max={100} value={pct} aria-label={`${name} load`} />
          <small>{r.activeAgents}/{r.capacity} agents</small>
        </>
      ) : (
        <small>offline</small>
      )}
    </li>
  );
}

export function UnifiedWorkspace({
  gather = load,
  onOpen,
  onHandOff,
}: {
  gather?: () => Promise<Gathered>;
  /** Open a thread or job in its own surface (T3 machine view, mesh). */
  onOpen?: (row: UnifiedRow) => void;
  /** Called with the target choosePlacement picked for a hand-off. */
  onHandOff?: (row: UnifiedRow, decision: PlacementDecision) => void;
}) {
  const [data, setData] = useState<Gathered | null>(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<UnifiedFilter>({ target: "all", kind: "all", text: "" });
  const [pref, setPref] = useState<Preference>(getGlobalPreference);
  const [handoff, setHandoff] = useState<{ id: string; decision: PlacementDecision } | null>(null);

  const refresh = useCallback(() => {
    setError("");
    gather().then(setData, (e) => setError(String((e as { message?: string })?.message ?? e)));
  }, [gather]);
  useEffect(refresh, [refresh]);

  const names = useMemo(() => {
    const out: Record<string, string> = {};
    for (const r of data?.rows ?? []) out[r.target.kind === "remote" ? r.target.workspaceId : r.target.kind === "t3" ? r.target.machineId : "local"] = r.targetLabel;
    return out;
  }, [data]);
  const groups = useMemo(() => groupByProject(filterRows(data?.rows ?? [], filter)), [data, filter]);

  const doHandOff = (row: UnifiedRow) => {
    const decision = decideHandoff({ projectId: row.name, agentKind: row.kind, resources: data?.resources ?? [], from: row.target });
    setHandoff({ id: row.id, decision });
    if (decision.target) onHandOff?.(row, decision);
  };

  return (
    <div className="unified-workspace" role="region" aria-label="All workspaces">
      <div className="unified-toolbar">
        <PlacementPicker label="Default run on" value={pref} onChange={(p) => { setPref(p); setGlobalPreference(p); }} names={names} />
        <label className="field"><span>Show</span>
          <select aria-label="Target filter" value={filter.target} onChange={(e) => setFilter({ ...filter, target: e.target.value as UnifiedFilter["target"] })}>
            <option value="all">All targets</option><option value="local">This Mac</option><option value="remote">Cloud</option><option value="t3">T3 Code</option>
          </select>
        </label>
        <label className="field"><span>Type</span>
          <select aria-label="Kind filter" value={filter.kind} onChange={(e) => setFilter({ ...filter, kind: e.target.value as UnifiedFilter["kind"] })}>
            <option value="all">Everything</option><option value="project">Projects</option><option value="agent">Agents</option><option value="thread">Threads</option><option value="job">Jobs</option>
          </select>
        </label>
        <input type="search" aria-label="Filter by name" placeholder="Filter" value={filter.text} onChange={(e) => setFilter({ ...filter, text: e.target.value })} />
        <Button size="sm" onClick={refresh}>Refresh</Button>
      </div>
      {error && <p role="alert" className="workspace-feedback error">{error}</p>}
      {!data && !error && <p className="remote-empty">Loading…</p>}
      {data && (
        <>
          <ul className="unified-loads" aria-label="Load per target">
            {data.resources.map((r) => <LoadBar key={targetKey(r.target)} r={r} name={targetName(r.target, names)} />)}
          </ul>
          {data.notes.map((n) => <p key={n} className="workspace-description">{n}</p>)}
          {!groups.length && <p className="remote-empty">Nothing matches.</p>}
          {groups.map((g) => (
            <section key={g.key} className="unified-group" aria-label={g.name}>
              <h4>{g.name}</h4>
              <ul>
                {g.rows.map((r) => (
                  <li key={r.id} className="unified-row">
                    <span className="unified-badge" data-target={r.target.kind}>{r.targetLabel}</span>
                    <span className="unified-kind">{r.kind}</span>
                    <span className="unified-status">{r.needsSetup ? "needs setup" : r.status}</span>
                    {r.branch && <code>{r.branch}</code>}
                    {onOpen && (r.kind === "thread" || r.kind === "job") && <Button size="sm" variant="ghost" onClick={() => onOpen(r)}>Open</Button>}
                    {r.kind !== "project" && <Button size="sm" variant="ghost" onClick={() => doHandOff(r)}>Hand off</Button>}
                    {handoff?.id === r.id && (
                      <small role="status">{handoff.decision.target ? `Could move to ${targetName(handoff.decision.target, names)}. ` : ""}{handoff.decision.reason}</small>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </>
      )}
    </div>
  );
}

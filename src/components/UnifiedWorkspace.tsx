// A compact view of work Canopy can see across every named machine. Reads are
// read-only; opening or handing off goes through callbacks supplied by the app.
// See docs/placement-and-unified-workspace.md for cross-machine limits.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Gathered } from "../placement/gather";
import { decideHandoff } from "../placement/launch";
import { getGlobalPreference, setGlobalPreference } from "../placement/preferences";
import { filterRows, groupByProject, type UnifiedFilter, type UnifiedKind, type UnifiedRow } from "../placement/unified";
import { targetKey, type DisplayTarget, type PlacementDecision, type Preference, type ResourceSnapshot } from "../placement/types";
import { PlacementPicker, targetName } from "./PlacementPicker";
import { Button } from "./ui";

const load = async (): Promise<Gathered> => (await import("../placement/gather")).gatherUnified();
const kindLabel: Record<UnifiedKind, string> = { project: "Project", agent: "Agent", thread: "Thread", job: "Job" };

function MachineSummary({ machine, resource }: { machine: DisplayTarget; resource?: ResourceSnapshot }) {
  const online = resource?.online ?? machine.online;
  const measured = online && resource && !resource.loadUnknown && resource.capacity > 0;
  const pct = measured ? Math.min(100, Math.round((resource.activeAgents / resource.capacity) * 100)) : 0;
  return (
    <li className="unified-machine" data-target-id={targetKey(machine.target)}>
      <div className="unified-machine-heading">
        <strong className="unified-machine-name">{machine.name}</strong>
        <span className={`unified-machine-state ${online ? "online" : "offline"}`}><i aria-hidden="true" />{online ? "Online" : "Offline"}</span>
      </div>
      {measured ? (
        <>
          <progress max={100} value={pct} aria-label={`${machine.name} load`} />
          <small>{resource.activeAgents} of {resource.capacity} agent slots in use</small>
        </>
      ) : <small>{online ? "Load unavailable" : "Not available for new work"}</small>}
    </li>
  );
}

export function UnifiedWorkspace({
  gather = load,
  onOpen,
  onHandOff,
}: {
  gather?: () => Promise<Gathered>;
  /** Open a thread or job in its own surface. */
  onOpen?: (row: UnifiedRow) => void;
  /** Called with the exact target selected for a hand-off. */
  onHandOff?: (row: UnifiedRow, decision: PlacementDecision) => void;
}) {
  const [data, setData] = useState<Gathered | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<UnifiedFilter>({ target: "all", kind: "all", text: "" });
  const [pref, setPref] = useState<Preference>(getGlobalPreference);
  const [handoff, setHandoff] = useState<{ id: string; decision: PlacementDecision } | null>(null);

  const refresh = useCallback(() => {
    setLoading(true);
    setError("");
    gather().then(value => { setData(value);setLoading(false); }, reason => { setError(String((reason as { message?: string })?.message ?? reason));setLoading(false); });
  }, [gather]);
  useEffect(refresh, [refresh]);

  const names = useMemo(() => {
    const out: Record<string, string> = {};
    for (const target of data?.targets ?? []) out[targetKey(target.target)] = target.name;
    for (const row of data?.rows ?? []) out[targetKey(row.target)] = row.targetLabel;
    return out;
  }, [data]);
  const visibleRows = useMemo(() => groupByProject(filterRows(data?.rows ?? [], filter)).flatMap(group => group.rows), [data, filter]);

  const doHandOff = (row: UnifiedRow) => {
    const decision = decideHandoff({ projectId: row.name, agentKind: row.kind, resources: data?.resources ?? [], from: row.target });
    setHandoff({ id: row.id, decision });
    if (decision.target) onHandOff?.(row, decision);
  };

  return (
    <div className="unified-workspace" role="region" aria-label="All workspaces">
      <div className="unified-toolbar" aria-label="Workspace filters">
        <PlacementPicker
          label="Default run on"
          value={pref}
          onChange={(preference) => { setPref(preference); setGlobalPreference(preference); }}
          names={names}
          targets={data?.targets}
        />
        <label className="field"><span>Machine</span>
          <select aria-label="Machine filter" value={filter.target} onChange={(event) => setFilter({ ...filter, target: event.target.value })}>
            <option value="all">All machines</option>
            {data?.targets.map(machine => <option key={targetKey(machine.target)} value={targetKey(machine.target)}>{machine.name}</option>)}
          </select>
        </label>
        <label className="field"><span>Type</span>
          <select aria-label="Type filter" value={filter.kind} onChange={(event) => setFilter({ ...filter, kind: event.target.value as UnifiedFilter["kind"] })}>
            <option value="all">Everything</option><option value="project">Projects</option><option value="agent">Agents</option><option value="thread">Threads</option><option value="job">Jobs</option>
          </select>
        </label>
        <label className="field unified-search"><span>Find work</span><input type="search" aria-label="Filter by name" placeholder="Project, branch, or machine" value={filter.text} onChange={(event) => setFilter({ ...filter, text: event.target.value })} /></label>
        <Button size="sm" onClick={refresh} disabled={loading} aria-label="Refresh all workspaces">Refresh</Button>
      </div>

      {loading && !data && !error && <div className="unified-state" role="status"><strong>Loading work from your machines…</strong><span>Checking availability and visible projects.</span></div>}
      {error && <div className="unified-state error" role="alert"><strong>Could not load workspaces: {error}</strong><span>Your existing work is unchanged.</span><Button size="sm" onClick={refresh}>Try again</Button></div>}
      {data && (
        <>
          <ul className="unified-machines" aria-label="Machine availability">
            {data.targets.map(machine => <MachineSummary key={targetKey(machine.target)} machine={machine} resource={data.resources.find(resource => targetKey(resource.target) === targetKey(machine.target))} />)}
          </ul>
          {data.notes.length > 0 && <aside className="unified-limitations" aria-label="Workspace visibility limits"><strong>Visibility</strong>{data.notes.map(note => <p key={note}>{note}</p>)}</aside>}
          {visibleRows.length > 0 ? (
            <div className="unified-table-wrap">
              <table className="unified-table" aria-label="Work across all machines">
                <thead><tr><th scope="col">Work</th><th scope="col">Machine</th><th scope="col">Type</th><th scope="col">Status</th><th scope="col">Branch</th><th scope="col">Actions</th></tr></thead>
                <tbody>
                  {visibleRows.map(row => {
                    const canOpen = !!onOpen && row.target.kind === "t3" && (row.kind === "thread" || row.kind === "job");
                    const canHandOff = row.kind !== "project";
                    return <tr key={row.id} className="unified-row" data-row-id={row.id}>
                      <th scope="row" data-label="Work"><span className="unified-work-name">{row.name}</span></th>
                      <td data-label="Machine"><span className="unified-target-badge" data-target-id={targetKey(row.target)}>{row.targetLabel}</span></td>
                      <td data-label="Type"><span className="unified-kind">{kindLabel[row.kind]}</span></td>
                      <td data-label="Status"><span className={`unified-status${row.needsSetup ? " attention" : ""}`}>{row.needsSetup ? "Needs setup" : row.status}</span></td>
                      <td data-label="Branch">{row.branch ? <code>{row.branch}</code> : <span className="unified-none" aria-label="No branch">None</span>}</td>
                      <td data-label="Actions" className="unified-actions"><div className="unified-action-buttons">
                        {canOpen && <Button size="sm" variant="ghost" onClick={() => onOpen(row)} aria-label={`Open ${row.name} on ${row.targetLabel}`}>Open</Button>}
                        {canHandOff && <Button size="sm" variant="ghost" onClick={() => doHandOff(row)} aria-label={`Hand off ${row.name} from ${row.targetLabel}`}>Hand off</Button>}
                        {!canOpen && !canHandOff && <span className="unified-none">None</span>}
                        {handoff?.id === row.id && <small role="status">{handoff.decision.target ? `Could move to ${targetName(handoff.decision.target, names)}. ` : ""}{handoff.decision.reason}</small>}
                      </div></td>
                    </tr>;
                  })}
                </tbody>
              </table>
            </div>
          ) : <div className="unified-state"><strong>{data.rows.length ? "No work matches these filters." : "No work is visible yet."}</strong><span>{data.rows.length ? "Change a filter to see more work." : "Open or set up a project on a connected machine, then refresh."}</span></div>}
        </>
      )}
    </div>
  );
}

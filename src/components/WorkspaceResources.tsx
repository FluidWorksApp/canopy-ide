// The status bar's resource popover for a cloud workspace shared by several
// people: what's available, who is using it, and the cache apart. Numbers
// and grouping come from resourceAttribution.ts, chip wording from
// resourceChip.ts.
import { CPU_LOW_SAMPLES, memoryAvailability } from "../resourceAttribution";
import { availabilityClass, fmtAllocated, fmtBytes, fmtCores, peopleRows, type Workspace } from "../resourceChip";

/** The popover for a workspace that reports availability. */
export function WorkspaceResourcesPanel({
  ws,
  selfId,
  cpuLowStreak,
}: {
  ws: Workspace & { workingSetBytes: number };
  selfId: string;
  cpuLowStreak: number;
}) {
  const rows = peopleRows(ws, selfId);
  const memLevel = memoryAvailability(ws.availableBytes, ws.memoryLimitBytes);
  const cpuLow = cpuLowStreak >= CPU_LOW_SAMPLES;
  const machine = ws.machine;
  return (
    <>
      <div className="bd-head">
        <span>Workspace resources</span>
      </div>
      <div className="bd-resource-section">
        <span className="bd-resource-label">Available now</span>
        <dl className="bd-resource-grid">
          <dt>Memory</dt>
          <dd>
            {ws.availableBytes != null ? (
              <span className={availabilityClass(memLevel)}>{fmtBytes(ws.availableBytes)} free</span>
            ) : (
              <span>{fmtBytes(ws.workingSetBytes)} in use</span>
            )}{" "}
            <span className="bd-resource-muted">
              {ws.memoryLimitBytes ? `of ${fmtBytes(ws.memoryLimitBytes)}` : "no limit set"}
            </span>
          </dd>
          <dt>CPU</dt>
          <dd>
            {ws.cpusAvailable != null ? (
              <span className={cpuLow ? "res-low" : undefined}>{fmtCores(ws.cpusAvailable)} free</span>
            ) : ws.cpusUsed != null ? (
              <span>{fmtCores(ws.cpusUsed)} in use</span>
            ) : (
              <span>—</span>
            )}{" "}
            <span className="bd-resource-muted">{ws.cpus ? `of ${fmtAllocated(ws.cpus)}` : "no limit set"}</span>
          </dd>
        </dl>
      </div>
      {machine && (
        <div className="bd-resource-section">
          <span className="bd-resource-label">This machine</span>
          <dl className="bd-resource-grid">
            <dt>Memory</dt>
            <dd>
              <span className={availabilityClass(memoryAvailability(machine.memoryAvailableBytes, machine.memoryTotalBytes))}>
                {fmtBytes(machine.memoryAvailableBytes)} free
              </span>{" "}
              <span className="bd-resource-muted">of {fmtBytes(machine.memoryTotalBytes)}</span>
            </dd>
            <dt>CPU</dt>
            <dd>
              <span>{machine.cpusAvailable != null ? `${fmtCores(machine.cpusAvailable)} free` : "—"}</span>{" "}
              <span className="bd-resource-muted">of {fmtAllocated(machine.cpus)}</span>
            </dd>
          </dl>
          <p className="bd-workspace-note bd-resource-muted">
            Everything running on this computer, including teammates' own workspaces.
          </p>
        </div>
      )}
      <div className="bd-resource-section">
        {rows ? (
          <table className="bd-resource-table">
            <caption className="bd-resource-label">Who is using it</caption>
            <thead>
              <tr>
                <th scope="col">Person</th>
                <th scope="col">Memory</th>
                <th scope="col">CPU</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} className={r.kind === "you" ? "bd-resource-you" : undefined}>
                  <th scope="row">
                    {r.label}
                    {r.kind === "services" && <span className="bd-resource-muted"> · desktop, browsers, Canopy</span>}
                    {r.kind === "runtime" && (
                      <span className="bd-resource-muted">
                        {r.key === "runtime:main" ? " · its owner and anyone connected to it" : " · own workspace on this machine"}
                      </span>
                    )}
                    {(r.kind === "you" || r.kind === "teammate" || r.kind === "unknown") && (
                      <span className="bd-resource-muted">
                        {" "}
                        · {r.terminals} {r.terminals === 1 ? "terminal" : "terminals"}
                      </span>
                    )}
                  </th>
                  <td>{fmtBytes(r.memoryBytes)}</td>
                  <td>{r.cpusUsed == null ? "—" : fmtCores(r.cpusUsed)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <>
            <span className="bd-resource-label">Who is using it</span>
            <p className="bd-workspace-note bd-resource-muted">
              {fmtBytes(ws.workingSetBytes)} in use. Per-person usage appears once the workspace has measured its terminals.
            </p>
          </>
        )}
      </div>
      {ws.reclaimableBytes != null && (
        <div className="bd-resource-section">
          <span className="bd-resource-label">Reclaimable cache — freed automatically when needed</span>
          <dl className="bd-resource-grid">
            <dt>Cached files</dt>
            <dd>{fmtBytes(ws.reclaimableBytes)}</dd>
          </dl>
          <p className="bd-workspace-note bd-resource-muted">
            Recently read files kept in memory to speed things up. It isn't counted as in use: the system frees it as soon as anything needs the room.
          </p>
        </div>
      )}
    </>
  );
}

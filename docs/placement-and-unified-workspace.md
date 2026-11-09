# Placement and the unified workspace

Where an agent runs (this Mac, a cloud workspace, a T3 Code machine) is a
placement decision. The engine is in `src/placement/`.

## Pieces

- `types.ts`, `balancer.ts`: `choosePlacement` picks a target from preferences,
  live `ResourceSnapshot`s and where the project is already set up. It returns
  the target, a reason, alternatives and `needsSetup`.
- `preferences.ts`: Local, Remote, Balance or Auto at three levels, stored in
  localStorage. Agent beats project beats global; Auto defers to the next
  level and ends at Balance.
- `resources.ts`, `gather.ts`: collect snapshots from real sources (terminal
  stats, `memory_info`, the workspace list, saved T3 machines).
- `launch.ts`: `decideLaunch` reads the stored preferences and calls the
  balancer; `decideHandoff` does the same with the current target excluded.
- `unified.ts`: pure merge of local, remote, T3 and mesh job data into
  `UnifiedRow`s, grouped by project name, filterable.

## Where you see it

- Workspaces panel, "All workspaces": one list with a target badge per row,
  load bars per target, filters, a default Run on picker, Open for T3 threads,
  and Hand off, which shows (and reports) where the balancer would move a task.
- Project settings (edit project): "Run agents on" for that project.
- Agent launch button (ticket tab): the caret menu has "Run on: ..." rows that
  set the preference for the agent kind. Launch consults the stored
  preferences. If the decision is a remote that lacks the project, the
  on-demand setup dialog (`ProjectSetupDialog`) opens first and the launch
  continues after it. If nothing has room, the reason is shown and nothing starts.

## Limits

- The host is a global singleton (`src/host`). Only the active host's projects
  and terminals can be read. Other cloud workspaces contribute their state and
  size from the workspace list; their projects and agents are not listed, and
  their load reads as idle. While a remote workspace is active, this Mac's
  projects are not readable.
- Launching only reaches the active host. When the decision names another
  target, the ticket view tells the user and starts on the active workspace.
  Switching workspaces (or the mesh job path) is how work reaches another
  target. Hand off reports the chosen target to the caller; it does not
  re-dispatch by itself yet.
- Setup runs against the active remote host, so the setup dialog is only
  useful when that remote is the active workspace.
- T3 threads are read from the first `orchestration.subscribeShell` snapshot
  (`listShell`). The thread fields are optional because the shape is not pinned
  by a live-server test. T3 load is not measured (reads as idle).
- Mesh jobs shown are the durable records of jobs sent to cloud workspaces
  (`localRemoteJobs`); incoming approvals are not listed. Open is wired for T3
  threads only.
- Agent-level launch preferences are keyed by agent CLI id; hand-off uses the
  project name since unified rows carry no project id, so per-project
  preferences are not applied to hand-offs.

# Placement and the unified workspace

Placement decides which machine runs a new agent. Machine placement is separate
from Git checkout placement, which decides whether Canopy uses the current
checkout or creates a worktree.

## Launch flow

Every primary agent launch includes the same machine choices. The chosen CLI and
machine are confirmed together for that launch; choosing a machine here does not
silently rewrite the CLI's saved default:

1. **Automatic** picks an eligible online machine using current availability and
   measured load. It prefers a machine where the project is already set up.
2. **This Mac** selects the local machine.
3. Every connected machine appears by its user-facing name. The choice retains
   that machine's stable workspace or machine ID.

At project and agent override levels, **Use default** inherits the next setting.
It does not balance by itself. The precedence is agent, then project, then
global. An explicit **Automatic** at any level stops inheritance and performs
a fresh balancing decision. The global setting offers Automatic, This Mac, and
named machines because there is no higher setting to inherit. The agent menu's
**Default machine for…** action edits the persistent agent default separately
from the machine choice for the current launch.

The visible process is:

```text
Start agent
  -> choose the agent CLI
  -> choose Automatic, This Mac, or a connected machine by name
  -> keep current checkout or create a Git worktree independently
  -> launch on that exact active machine
     or show a named switch, open, or setup step before launch
```

Canopy never changes a concrete machine choice into another machine. If a
saved machine is missing from the current inventory, the launch dialog keeps
that exact choice visible as unavailable so the final check can refuse it. If
the selected machine is inactive or its current integration cannot accept a
direct launch, Canopy names the required transition instead of starting on the
active machine. A selected active workspace that does not have the same project
ID opens the setup dialog before launch; matching display names alone never
count as project identity. If connected-machine discovery fails, launch stops
with that discovery error rather than treating the unread inventory as an empty
set and balancing elsewhere.

Older `canopy:placement:v1` settings remain readable. Legacy project or agent
`auto` values become Use default. Legacy global `auto` and `balance` values
become Automatic. Legacy `local` becomes This Mac. A generic legacy remote
value cannot identify a specific machine, so it degrades safely without
inventing a target.

## All workspaces dashboard

Open the workspace switcher in the header and choose **All workspaces…**. The
same menu also contains **New workspace…** and **Manage workspaces…**.

The dashboard shows all machines uniformly by name. Availability and load
summaries appear first. A compact table then labels each visible row with Work,
Machine, Type, Status, Branch, and Actions. Filters select a named machine, work
type, or matching text. On narrow windows, each table row becomes a labeled
stacked card while preserving the table's accessible structure and keyboard
controls.

The **Default run on** control changes the global placement preference.
**Open** enters a supported thread surface. **Hand off** reports the exact
machine selected by the balancer to the caller; it does not claim that work
moved when no dispatch path exists.

## Implementation pieces

- `types.ts` defines concrete targets, stable target keys, inheritance, and
  automatic preferences.
- `preferences.ts` stores global, project, and agent preferences in
  localStorage and migrates legacy values.
- `balancer.ts` chooses among eligible online resource snapshots using project
  setup, known load, available capacity, CPU load, and free memory.
- `resources.ts` and `gather.ts` collect machine names, availability, and load
  through the existing host and connection seams. Picker inventory lists names
  without opening machine shells; one fresh full gather runs before dispatch.
- `launch.ts` resolves preferences and creates launch, hand-off, or named
  transition decisions.
- `unified.ts` merges visible projects, agents, threads, and jobs into rows and
  filters them by stable target ID.

## Current limits

- The host is a global singleton. Only the active host's projects and terminals
  can be read. Other connected machines show their name and availability, and a
  ready workspace's load is read on demand through the account
  (`src/remoteExecution/workspaceProbe.ts`): a short, read-only look that lists
  its sessions. That count is of running sessions, agents and shells together, so
  it is labelled "sessions", not agent slots. Their projects and agents appear
  only after switching to them. While a remote workspace is active, this Mac's
  projects are not readable.
- Direct agent launch reaches only the active local or workspace host. Selecting
  an inactive local or workspace target produces a named switch step. Selecting
  a machine whose integration currently exposes files and terminals rather
  than project agent tabs produces a named open step. Neither case silently
  falls back to the active host.
- Setup runs against the active workspace host. Canopy only opens setup for the
  selected active workspace.
- Some connected-machine thread fields are optional because their live protocol
  shape is not pinned by an integration test. Load is shown as unavailable when
  it cannot be measured.
- Durable jobs sent to workspaces can appear in the dashboard. Incoming
  approvals are not listed.
- Agent preferences use the agent CLI ID. Dashboard hand-off rows carry a
  project name rather than a project ID, so project-specific preferences do not
  apply to hand-off decisions.

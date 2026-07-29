// The cleanup task's arithmetic and its wording, away from the dialog that
// shows them.
//
// The Rust side (cleanup.rs) decides what is disposable and what is
// recommended; everything here is the presentation of that answer: the grouping
// by checkout, what a row and a group are worth, and the one sentence each state
// gets. Pure functions, so the rules that decide what a click will delete are
// tested rather than clicked.
import type * as ipc from "./ipc";

/** One checkout and the disposable directories inside it. */
export interface CleanupGroup {
  workspace: ipc.CleanupWorkspace;
  targets: ipc.CleanupTarget[];
}

/**
 * Targets grouped under their checkout, biggest opportunity first.
 *
 * The order is a property of the *scan*, never of the selection: it is computed
 * from what could be reclaimed, so ticking a box can't make a group jump under
 * the cursor. Within a group Rust already sorted by size.
 */
export function groupTargets(scan: ipc.CleanupScan): CleanupGroup[] {
  const groups = scan.workspaces.map((workspace) => ({
    workspace,
    targets: scan.targets.filter((t) => t.workspace === workspace.path),
  }));
  return groups
    .filter((g) => g.targets.length > 0)
    .sort(
      (a, b) =>
        b.workspace.recommended_bytes - a.workspace.recommended_bytes ||
        b.workspace.bytes - a.workspace.bytes ||
        a.workspace.path.localeCompare(b.workspace.path),
    );
}

/** What is ticked when the dialog opens: exactly what Rust recommended, and
 *  nothing a workspace is holding. */
export const defaultSelection = (scan: ipc.CleanupScan): Set<string> =>
  new Set(scan.targets.filter((t) => t.recommended).map((t) => t.path));

export const bytesOf = (targets: ipc.CleanupTarget[], selected: Set<string>): number =>
  targets.reduce((n, t) => (selected.has(t.path) ? n + t.bytes : n), 0);

export const countOf = (targets: ipc.CleanupTarget[], selected: Set<string>): number =>
  targets.reduce((n, t) => (selected.has(t.path) ? n + 1 : n), 0);

/** Tri-state for a group's own checkbox. */
export function groupState(
  group: CleanupGroup,
  selected: Set<string>,
): "none" | "some" | "all" {
  const n = countOf(group.targets, selected);
  if (n === 0) return "none";
  return n === group.targets.length ? "all" : "some";
}

/** Toggle a whole group: any partial selection fills, a full one empties. The
 *  header box is a shortcut, not a third kind of state to reason about. */
export function toggleGroup(
  group: CleanupGroup,
  selected: Set<string>,
): Set<string> {
  const next = new Set(selected);
  const all = groupState(group, selected) === "all";
  for (const t of group.targets) {
    if (all) next.delete(t.path);
    else next.add(t.path);
  }
  return next;
}

export function toggleTarget(path: string, selected: Set<string>): Set<string> {
  const next = new Set(selected);
  if (!next.delete(path)) next.add(path);
  return next;
}

/** Disk, at the precision the number deserves: nobody needs three decimals of
 *  a gigabyte, and "0.0 GB" is not an answer for 40 MB. */
export function fmtBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** What the checkout is called in the list: its branch, because that is what a
 *  person calls the thing they were working on — with the folder name for the
 *  detached and non-git cases that have no branch to name. */
export function workspaceLabel(ws: ipc.CleanupWorkspace): string {
  if (ws.branch) return ws.branch;
  return ws.name;
}

export interface StateChip {
  label: string;
  /** "hold" is why it isn't offered, "done" why it is, "info" is context. */
  tone: "hold" | "done" | "info";
  /** The long form, for the row's tooltip — "already merged into origin/main". */
  title?: string;
}

/**
 * The chips on a checkout's header — the whole "is this thing in use" answer at
 * a glance, in the order that decides it.
 *
 * Hibernation is a chip and not a hidden rule: the user asked whether a sleeping
 * project should be cleaned, and the answer this feature gives ("no, not by
 * default, but it's your call") is only honest if the row says so.
 */
export function stateChips(ws: ipc.CleanupWorkspace): StateChip[] {
  const chips: StateChip[] = [];
  if (ws.busy) chips.push({ label: "in use", tone: "hold" });
  if (ws.asleep) chips.push({ label: "hibernating", tone: "hold" });
  if (ws.dirty > 0)
    chips.push({ label: `±${ws.dirty} uncommitted`, tone: "hold" });
  // Why a workspace whose branch is two days old is being offered anyway: the
  // work is in main. Marked "done" rather than "merged" because a squash-merged
  // branch reaches this the other way (its remote branch is gone), and both mean
  // the same thing to the person deciding.
  if (ws.landed) chips.push({ label: "done", tone: "done", title: ws.landed });
  if (ws.main) chips.push({ label: "main checkout", tone: "info" });
  if (ws.idle_days != null)
    chips.push({
      label:
        ws.idle_days === 0
          ? "committed today"
          : `idle ${ws.idle_days}d`,
      tone: "info",
    });
  return chips;
}

/** The button's own label, which is the only place the consequence is stated in
 *  full: how much, and whether it is recoverable. */
export function reclaimLabel(bytes: number, trash: boolean): string {
  if (bytes === 0) return trash ? "Move to Trash" : "Delete";
  return trash ? `Move ${fmtBytes(bytes)} to Trash` : `Delete ${fmtBytes(bytes)}`;
}

/** What happened, in one line. Failures and refusals are named rather than
 *  folded into the total — a cleanup that silently skipped half of what was
 *  ticked reads as a cleanup that worked. */
export function outcomeSummary(o: ipc.CleanupOutcome): string {
  const parts: string[] = [];
  const what = `${o.removed.length} director${o.removed.length === 1 ? "y" : "ies"}`;
  parts.push(
    o.trashed
      ? `Moved ${what} to the Trash — ${fmtBytes(o.bytes)}, back when you empty it.`
      : `Deleted ${what} — ${fmtBytes(o.bytes)} reclaimed.`,
  );
  if (o.failed.length > 0) parts.push(`${o.failed.length} couldn't be removed.`);
  if (o.refused.length > 0)
    parts.push(`${o.refused.length} refused as not safe to delete.`);
  return parts.join(" ");
}

/** How full a volume is, as the bar's percentage and its tone. Disk is not like
 *  a token budget: 75% full is unremarkable, 95% is why builds start failing. */
export function diskFill(disk: ipc.DiskUsage): {
  pct: number;
  tone: "normal" | "warn" | "critical";
} {
  const used = Math.max(0, disk.total_bytes - disk.free_bytes);
  const pct = disk.total_bytes > 0 ? (used / disk.total_bytes) * 100 : 0;
  return {
    pct: Math.min(100, Math.max(0, pct)),
    tone: pct >= 95 ? "critical" : pct >= 85 ? "warn" : "normal",
  };
}

// ---------------------------------------------------------------------------
// What the last scan found.
//
// The usage panel wants a number the moment it opens, and scanning to get one
// would put a minute of disk walking behind a click that was only asking about
// tokens. So the last scan's total is remembered — in localStorage, like the
// other records of a session's shape — and shown with its age, which is the
// honest version: "1.2 GB, as of this morning", never a fresh-looking figure
// nobody measured.

const LAST_SCAN_KEY = "canopy.cleanup.lastScan.v1";

export interface LastScan {
  bytes: number;
  recommendedBytes: number;
  at: number;
}

export function rememberScan(scan: ipc.CleanupScan, now = Date.now()): void {
  try {
    localStorage.setItem(
      LAST_SCAN_KEY,
      JSON.stringify({
        bytes: scan.bytes,
        recommendedBytes: scan.recommended_bytes,
        at: now,
      } satisfies LastScan),
    );
  } catch {
    // A panel line is not worth an exception; it just shows nothing.
  }
}

export function lastScan(): LastScan | null {
  try {
    const raw = JSON.parse(localStorage.getItem(LAST_SCAN_KEY) ?? "null") as LastScan;
    if (!raw || typeof raw.bytes !== "number" || typeof raw.at !== "number") return null;
    return raw;
  } catch {
    return null;
  }
}

/** "1.2 GB reclaimable · 3h ago", or null when nothing has been scanned. Ages
 *  out rather than lying: a week-old figure is worse than no figure. */
export function lastScanNote(scan: LastScan | null, now = Date.now()): string | null {
  if (!scan) return null;
  const ms = Math.max(0, now - scan.at);
  const days = Math.floor(ms / 86_400_000);
  if (days >= 7) return null;
  const hours = Math.floor(ms / 3_600_000);
  const mins = Math.floor(ms / 60_000);
  const when =
    days >= 1 ? `${days}d ago` : hours >= 1 ? `${hours}h ago` : mins >= 1 ? `${mins}m ago` : "just now";
  if (scan.bytes === 0) return `nothing to reclaim · ${when}`;
  return `${fmtBytes(scan.recommendedBytes)} idle of ${fmtBytes(scan.bytes)} · ${when}`;
}

/** The line under the title while nothing is selected: what a scan found, and
 *  whether the walk gave up early. */
export function scanSummary(scan: ipc.CleanupScan): string {
  if (scan.targets.length === 0)
    return "Nothing to reclaim — no build output, installs or caches found.";
  const ws = scan.workspaces.filter((w) => w.bytes > 0).length;
  const where = ws === 1 ? "1 workspace" : `${ws} workspaces`;
  const head = `${fmtBytes(scan.bytes)} across ${where}; ${fmtBytes(
    scan.recommended_bytes,
  )} of it looks idle.`;
  return scan.truncated
    ? `${head} The scan stopped early — there may be more.`
    : head;
}

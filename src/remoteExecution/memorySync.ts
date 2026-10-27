// Team memory for a cloud workspace's agents.
//
// The ledger that holds team memory lives on this computer; the agents run in
// the VM and ask the workspace's Canopy service (canopy_memory,
// canopy_memory_propose). So this keeps the service's copy current — every
// memory a person approved and that hasn't expired, exactly what the desktop
// bridge would serve — and brings the agents' proposals back into the ledger
// as "proposed", where the Memory panel is the only place they become memory.
//
// Runs on every workspace connect (workspaceSync.ts), again whenever a memory
// changes here, and polls for proposals while connected.
import { invoke, isWorkspaceHost } from "../host";
import { appendLedger, queryLedger, subscribeLedger, type LedgerEntry } from "../ledger";
import { servedToAgents, type MemoryData, type MemoryScope } from "../memoryLedger";

/** A proposal as the service queues it (crates/canopy-service/src/memory.rs). */
export interface QueuedProposal {
  memoryId: string;
  ptyId: number;
  terminal?: string | null;
  cwd?: string | null;
  by: string;
  scope: MemoryScope;
  subject: string;
  data: MemoryData;
  expiresAt: number;
  proposedMs: number;
}

const MAX_SYNCED = 5000;
export const PROPOSAL_POLL_MS = 60_000;
const RESYNC_DEBOUNCE_MS = 1500;

const norm = (p: string) => p.replace(/[\\/]+$/, "");
/** The open project directory a proposal came from: the longest root holding
 *  its cwd, else the first. */
export function rootFor(cwd: string | null | undefined, roots: string[]): string | null {
  let best: string | null = null;
  if (cwd) {
    const c = norm(cwd);
    for (const r of roots.map(norm))
      if ((c === r || c.startsWith(`${r}/`)) && (!best || r.length > best.length)) best = r;
  }
  return best ?? roots[0] ?? null;
}

/** Copy every servable memory of the open projects to the service. */
export async function pushWorkspaceMemory(roots: string[], now = Date.now()): Promise<number> {
  const seen = new Set<string>();
  const entries: LedgerEntry<MemoryData>[] = [];
  for (const root of [...new Set(roots)]) {
    const rows = await queryLedger<MemoryData>(root, { kinds: ["memory"], limit: 5000 }).catch(() => []);
    for (const e of rows) {
      if (!servedToAgents(e, now) || !e.data?.memoryId || seen.has(e.data.memoryId)) continue;
      seen.add(e.data.memoryId);
      entries.push(e);
    }
  }
  await invoke("workspace_memory_sync", { root: roots[0] ?? "", entries: entries.slice(0, MAX_SYNCED) });
  return entries.length;
}

/** Take the agents' proposals into the ledger as "proposed", then let the
 *  service drop them. A proposal already in the ledger (an earlier pull whose
 *  ack was lost) is only acknowledged. */
export async function pullWorkspaceProposals(roots: string[]): Promise<number> {
  if (!roots.length) return 0;
  const queued = await invoke<QueuedProposal[]>("workspace_memory_proposals", {});
  if (!queued?.length) return 0;
  const known = new Map<string, Set<string>>();
  const idsIn = async (root: string) => {
    let ids = known.get(root);
    if (!ids) {
      const rows = await queryLedger<MemoryData>(root, { kinds: ["memory"], limit: 5000 });
      ids = new Set(rows.map((e) => e.data?.memoryId).filter((id): id is string => !!id));
      known.set(root, ids);
    }
    return ids;
  };
  const done: string[] = [];
  let added = 0;
  for (const p of queued) {
    const root = rootFor(p.cwd, roots);
    if (!root || !p.memoryId) continue;
    try {
      const ids = await idsIn(root);
      if (!ids.has(p.memoryId)) {
        await appendLedger<MemoryData>(root, {
          kind: "memory",
          author: { kind: "agent", name: p.by || "agent", ptyId: p.ptyId },
          scope: p.scope,
          subject: p.subject,
          ref: { kind: "pty", id: String(p.ptyId) },
          data: { ...p.data, memoryId: p.memoryId, source: "agent" },
          expiresAt: p.expiresAt,
          status: "proposed",
        });
        ids.add(p.memoryId);
        added++;
      }
      done.push(p.memoryId);
    } catch {
      // Left queued; the next pull tries again.
    }
  }
  if (done.length) await invoke("workspace_memory_ack", { ids: done });
  return added;
}

/** Both directions, once. What workspaceSync runs on connect. */
export async function syncWorkspaceMemory(roots: string[]): Promise<void> {
  if (!isWorkspaceHost()) return;
  await Promise.allSettled([pushWorkspaceMemory(roots), pullWorkspaceProposals(roots)]);
}

/** Keep it current while connected: re-push when a memory changes here, and
 *  pull proposals every minute. A no-op outside a cloud workspace. */
export function startMemorySync(roots: () => string[]): () => void {
  if (!isWorkspaceHost()) return () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const off = subscribeLedger("*", (entry) => {
    if (entry.kind !== "memory") return;
    clearTimeout(timer);
    timer = setTimeout(() => void pushWorkspaceMemory(roots()).catch(() => {}), RESYNC_DEBOUNCE_MS);
  });
  const poll = setInterval(() => void pullWorkspaceProposals(roots()).catch(() => {}), PROPOSAL_POLL_MS);
  return () => {
    off();
    clearTimeout(timer);
    clearInterval(poll);
  };
}

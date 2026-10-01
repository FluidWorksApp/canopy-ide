import type { Project } from "./projects";

/** Everything a mounted ProjectView needs to recreate a tab around a PTY that
 * already exists in Rust. Kept outside React so opening or waking a project is
 * not a race against the render that installs its consumer. */
export interface TerminalAttachment {
  projectId: string;
  ptyId: number;
  sessionGeneration: number;
  cwd: string;
  name?: string;
  title: string;
  run: boolean;
  command?: string;
  componentId?: string;
  runCommandId?: string;
  activate: boolean;
  recovered: boolean;
  killOnClose: boolean;
}

type Consumer = (attachment: TerminalAttachment) => void;

export class TerminalAttachmentQueue {
  private readonly pending = new Map<string, TerminalAttachment>();
  private readonly consumers = new Map<string, Set<Consumer>>();
  /** Offered to this mounted consumer but not yet acknowledged by a commit. */
  private readonly offered = new Map<string, Consumer>();
  /** Acknowledged by this consumer. Keep the attachment until native exit so
   * an owning ProjectView that later unmounts cannot orphan the live PTY. */
  private readonly committed = new Map<
    string,
    { attachment: TerminalAttachment; consumer: Consumer }
  >();
  private readonly metrics = {
    enqueued: 0,
    acknowledged: 0,
    discarded: 0,
    forgotten: 0,
    requeued: 0,
  };

  private key(attachment: Pick<TerminalAttachment, "ptyId" | "sessionGeneration">) {
    return `${attachment.ptyId}:${attachment.sessionGeneration}`;
  }

  /** Publish before or after ProjectView mounts. Repeated native snapshot/event
   * delivery replaces the same lifetime rather than manufacturing extra tabs. */
  enqueue(attachment: TerminalAttachment) {
    this.metrics.enqueued += 1;
    const key = this.key(attachment);
    const committed = this.committed.get(key);
    if (committed) {
      // Snapshot reconciliation may refresh presentation metadata, but the
      // mounted owner already has this lifetime and must not receive it twice.
      committed.attachment = attachment;
      return;
    }
    const alreadyPending = this.pending.has(key);
    this.pending.set(key, attachment);
    // Event + live-snapshot reconciliation can report the same native lifetime
    // before React has committed and acknowledged the first offered tab. Do not
    // offer it twice against the same stale tabsRef in that render batch.
    if (alreadyPending) return;
    this.flush(attachment.projectId);
  }

  subscribe(projectId: string, consumer: Consumer): () => void {
    const listeners = this.consumers.get(projectId) ?? new Set<Consumer>();
    listeners.add(consumer);
    this.consumers.set(projectId, listeners);
    this.flush(projectId);
    return () => {
      listeners.delete(consumer);
      if (listeners.size === 0) this.consumers.delete(projectId);
      // An interrupted render never acknowledges. Its replacement subscriber
      // must receive those lifetimes again, while a still-mounted consumer must
      // not receive A twice just because B was enqueued before A committed.
      for (const [key, offeredTo] of this.offered) {
        if (offeredTo === consumer) this.offered.delete(key);
      }
      // A React commit only proves that this particular ProjectView owns the
      // tab. If it unmounts while the native PTY survives, its replacement is
      // the next owner and must receive the same lifetime again.
      for (const [key, entry] of this.committed) {
        if (entry.consumer !== consumer) continue;
        this.committed.delete(key);
        this.pending.set(key, entry.attachment);
        this.metrics.requeued += 1;
      }
      this.flush(projectId);
    };
  }

  /** Acknowledge only after React committed a tab with this attach id. Calling
   * setState is not enough: an interrupted/unmounted render must leave the PTY
   * pending for the next ProjectView mount. PTY ids are never reused in one
   * native process, while sessionGeneration keeps queue identity explicit. */
  acknowledge(projectId: string, ptyId: number) {
    for (const [key, attachment] of this.pending) {
      if (attachment.projectId === projectId && attachment.ptyId === ptyId) {
        const consumer = this.offered.get(key);
        if (consumer) this.committed.set(key, { attachment, consumer });
        this.metrics.acknowledged += 1;
        this.pending.delete(key);
        this.offered.delete(key);
      }
    }
  }

  /** Reconcile the queue's ownership ledger with the tabs a ProjectView
   * actually committed. A vanished tab must not permanently consume a native
   * lifetime; reoffer it to the still-mounted consumer. */
  reconcile(projectId: string, ptyIds: readonly number[]) {
    const owned = new Set(ptyIds);
    for (const [key, entry] of this.committed) {
      if (entry.attachment.projectId !== projectId || owned.has(entry.attachment.ptyId)) {
        continue;
      }
      this.committed.delete(key);
      this.pending.set(key, entry.attachment);
      this.metrics.requeued += 1;
    }
    this.flush(projectId);
  }

  /** An intentional tab close is not a native exit for remote-owned PTYs, but
   * it is still a deliberate end to this renderer's attachment ownership. */
  forget(projectId: string, ptyId: number) {
    let forgotten = false;
    for (const [key, attachment] of this.pending) {
      if (attachment.projectId !== projectId || attachment.ptyId !== ptyId) continue;
      this.pending.delete(key);
      this.offered.delete(key);
      forgotten = true;
    }
    for (const [key, entry] of this.committed) {
      if (entry.attachment.projectId !== projectId || entry.attachment.ptyId !== ptyId) {
        continue;
      }
      this.committed.delete(key);
      this.offered.delete(key);
      forgotten = true;
    }
    if (forgotten) this.metrics.forgotten += 1;
  }

  /** A PTY can exit while its project is still mounting. Never turn that stale
   * pending delivery into a dead tab when the ProjectView eventually appears. */
  discard(ptyId: number, sessionGeneration: number) {
    const key = this.key({ ptyId, sessionGeneration });
    this.pending.delete(key);
    this.offered.delete(key);
    this.committed.delete(key);
    this.metrics.discarded += 1;
  }

  private flush(projectId: string) {
    const consumer = this.consumers.get(projectId)?.values().next().value as
      | Consumer
      | undefined;
    if (!consumer) return;
    for (const [key, attachment] of this.pending) {
      if (attachment.projectId !== projectId) continue;
      if (this.offered.has(key)) continue;
      // Record the offer before entering React. A synchronous commit may run
      // acknowledge() before the callback returns; setting this afterwards
      // would let that acknowledgement delete the pending lifetime without
      // transferring it to the committed ownership ledger.
      this.offered.set(key, consumer);
      try {
        consumer(attachment);
      } catch {
        // A consumer that could not request the tab leaves the pending item for
        // its next mount. The native PTY keeps running either way.
        if (this.offered.get(key) === consumer) this.offered.delete(key);
      }
    }
  }

  /** Test/diagnostic seam: identities only, never terminal output. */
  pendingIdentities(): string[] {
    return [...this.pending.keys()].sort();
  }

  diagnostics() {
    return {
      pending: [...this.pending.keys()].sort(),
      offered: [...this.offered.keys()].sort(),
      committed: [...this.committed.keys()].sort(),
      metrics: { ...this.metrics },
      consumerProjects: [...this.consumers.entries()]
        .filter(([, consumers]) => consumers.size > 0)
        .map(([projectId]) => projectId)
        .sort(),
    };
  }
}

export const terminalAttachmentQueue = new TerminalAttachmentQueue();

const normalize = (path: string) => {
  const normalized = path.replaceAll("\\", "/").replace(/\/+$/, "");
  return /^[A-Za-z]:\//.test(normalized)
    ? normalized.toLocaleLowerCase()
    : normalized;
};

/** Deepest component wins, so a nested project owns its terminals even when a
 * broader project root is also open. */
export function projectForTerminalCwd(
  projects: Pick<Project, "id" | "components">[],
  cwd: string,
): string | undefined {
  const match = (candidate: string) => {
    let bestId: string | undefined;
    let bestLength = -1;
    for (const project of projects) {
      for (const component of project.components) {
        const root = normalize(component.path);
        if (
          root &&
          (candidate === root || candidate.startsWith(root + "/")) &&
          root.length > bestLength
        ) {
          bestLength = root.length;
          bestId = project.id;
        }
      }
    }
    return bestId;
  };

  const candidate = normalize(cwd);
  const direct = match(candidate);
  if (direct) return direct;
  // Canopy-created sibling worktrees use `<repo>-wt-<name>`. Fold just that
  // checkout segment back onto the owning component while preserving any cwd
  // beneath it. Nested `.claude/worktrees/*` already matches directly.
  const folded = candidate.replace(/-wt-[^/]*/, "");
  return folded === candidate ? undefined : match(folded);
}

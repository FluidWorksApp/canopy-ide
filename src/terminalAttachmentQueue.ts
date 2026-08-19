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
  killOnClose: boolean;
}

type Consumer = (attachment: TerminalAttachment) => void;

export class TerminalAttachmentQueue {
  private readonly pending = new Map<string, TerminalAttachment>();
  private readonly consumers = new Map<string, Set<Consumer>>();
  /** Offered to this mounted consumer but not yet acknowledged by a commit. */
  private readonly offered = new Map<string, Consumer>();

  private key(attachment: Pick<TerminalAttachment, "ptyId" | "sessionGeneration">) {
    return `${attachment.ptyId}:${attachment.sessionGeneration}`;
  }

  /** Publish before or after ProjectView mounts. Repeated native snapshot/event
   * delivery replaces the same lifetime rather than manufacturing extra tabs. */
  enqueue(attachment: TerminalAttachment) {
    const key = this.key(attachment);
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
    };
  }

  /** Acknowledge only after React committed a tab with this attach id. Calling
   * setState is not enough: an interrupted/unmounted render must leave the PTY
   * pending for the next ProjectView mount. PTY ids are never reused in one
   * native process, while sessionGeneration keeps queue identity explicit. */
  acknowledge(projectId: string, ptyId: number) {
    for (const [key, attachment] of this.pending) {
      if (attachment.projectId === projectId && attachment.ptyId === ptyId) {
        this.pending.delete(key);
        this.offered.delete(key);
      }
    }
  }

  /** A PTY can exit while its project is still mounting. Never turn that stale
   * pending delivery into a dead tab when the ProjectView eventually appears. */
  discard(ptyId: number, sessionGeneration: number) {
    const key = this.key({ ptyId, sessionGeneration });
    this.pending.delete(key);
    this.offered.delete(key);
  }

  private flush(projectId: string) {
    const consumer = this.consumers.get(projectId)?.values().next().value as
      | Consumer
      | undefined;
    if (!consumer) return;
    for (const [key, attachment] of this.pending) {
      if (attachment.projectId !== projectId) continue;
      if (this.offered.has(key)) continue;
      try {
        consumer(attachment);
        this.offered.set(key, consumer);
      } catch {
        // A consumer that could not request the tab leaves the pending item for
        // its next mount. The native PTY keeps running either way.
      }
    }
  }

  /** Test/diagnostic seam: identities only, never terminal output. */
  pendingIdentities(): string[] {
    return [...this.pending.keys()].sort();
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

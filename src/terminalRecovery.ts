import { adoptSnapshotNames, isUserNamed, namePatch, tabName } from "./tabName";
import type {
  RememberedTerminal,
  RememberedTerminalState,
  TerminalResumeCard,
  TerminalResumeLeaf,
} from "./terminalMemory";
import { resumeSessionId } from "./projects";
import type { TerminalAttachment } from "./terminalAttachmentQueue";
import {
  leafIds,
  remapTerminalGroups,
  type TerminalGroup,
} from "./terminalGroups";

/** Never pair identical-cwd agents by position or command. The persisted PTY
 * lifetime belongs to one backend instance; old records may match only a
 * unique native label under the same cwd. */
export function rememberedLiveTerminal(
  memory: RememberedTerminalState,
  attachment: Pick<
    TerminalAttachment,
    "ptyId" | "sessionGeneration" | "cwd" | "name"
  >,
  instance: string,
): RememberedTerminal | undefined {
  const matches = memory.terminals.filter((t) => {
    if (t.ptyId != null)
      return (
        t.ptyId === attachment.ptyId &&
        t.sessionGeneration === attachment.sessionGeneration &&
        t.instance === instance
      );
    return (
      !!attachment.name &&
      t.cwd === attachment.cwd &&
      t.title === attachment.name
    );
  });
  return matches.length === 1 ? matches[0] : undefined;
}

/** Only restore a split once every surviving live member has attached. This
 * prevents an early one-pane render from overwriting the saved mux layout. */
export function recoverLiveGroups(
  memory: RememberedTerminalState,
  ids: ReadonlyMap<string, string>,
  expected: ReadonlySet<string>,
): Record<string, TerminalGroup> {
  const ready: Record<string, TerminalGroup> = {};
  for (const [key, group] of Object.entries(memory.terminalGroups)) {
    const surviving = leafIds(group.root).filter((id) => expected.has(id));
    if (surviving.every((id) => ids.has(id))) {
      ready[key] = rememberedGroupNames(group, memory.terminals);
    }
  }
  return remapTerminalGroups(ready, ids);
}

/** Older builds stored a mux caption on its strip representative. Keep that
 * user's choice even when the split tree or attachment order starts elsewhere. */
export function rememberedGroupNames(
  group: TerminalGroup,
  terminals: RememberedTerminal[],
): TerminalGroup {
  const members = new Set(leafIds(group.root));
  const original = terminals.find((t) => t.tabId && members.has(t.tabId));
  const names = original ? adoptSnapshotNames(original) : {};
  return !isUserNamed(group) && isUserNamed(names)
    ? { ...group, ...namePatch(group, "user", tabName(names)) }
    : group;
}

export interface LiveTerminal
  extends Pick<TerminalAttachment, "ptyId" | "sessionGeneration" | "cwd" | "name"> {
  title?: string;
}

/** What the host's session list says about a project's remembered terminals. */
export interface HostLiveTerminals {
  tabIds: Set<string>;
  sessionIds: Set<string>;
  surfaces: Set<string>;
  /** Live on the host, not yet a tab here; named from the cached snapshot. */
  reconnecting: { ptyId: number; name: string }[];
  /** Live and ended terminals can be told apart. Until then no restore offer. */
  decided: boolean;
}

export function hostLiveTerminals(
  memory: RememberedTerminalState,
  live: readonly LiveTerminal[],
  attached: ReadonlySet<number>,
  instance: string | null,
): HostLiveTerminals {
  const out: HostLiveTerminals = {
    tabIds: new Set(),
    sessionIds: new Set(),
    surfaces: new Set(),
    reconnecting: [],
    decided: instance != null || live.length === 0,
  };
  const seen = new Set<string>();
  for (const terminal of live) {
    const key = `${terminal.ptyId}:${terminal.sessionGeneration}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.surfaces.add(String(terminal.ptyId));
    const saved = instance ? rememberedLiveTerminal(memory, terminal, instance) : undefined;
    if (saved?.tabId) out.tabIds.add(saved.tabId);
    const sessionId = saved && (saved.sessionId ?? resumeSessionId(saved.command));
    if (sessionId) out.sessionIds.add(sessionId);
    if (attached.has(terminal.ptyId)) continue;
    out.reconnecting.push({
      ptyId: terminal.ptyId,
      name: saved
        ? tabName({ ...adoptSnapshotNames(saved), cwd: saved.cwd, run: saved.run })
        : terminal.name || terminal.title || tabName({ cwd: terminal.cwd }),
    });
  }
  return out;
}

/** The restore offer is for ended work only. A leaf whose terminal or
 *  conversation is still running on the host is dropped; a split that loses a
 *  member falls apart into single rows, since its live panes reattach on their
 *  own. */
export function withoutLiveSessions(
  cards: TerminalResumeCard[],
  live: HostLiveTerminals,
  instance: string | null,
): TerminalResumeCard[] {
  const isLive = (leaf: TerminalResumeLeaf) => {
    const t = leaf.remembered;
    if (t?.tabId && live.tabIds.has(t.tabId)) return true;
    const digest = leaf.restorable?.digest;
    const sessionId =
      digest?.session_id ?? t?.sessionId ?? resumeSessionId(t?.command) ?? undefined;
    if (sessionId && live.sessionIds.has(sessionId)) return true;
    return (
      !!instance &&
      !!digest?.surface &&
      digest.instance === instance &&
      live.surfaces.has(digest.surface)
    );
  };
  return cards.flatMap((card) => {
    const leaves = card.leaves.filter((leaf) => !isLive(leaf));
    if (leaves.length === card.leaves.length) return [card];
    return leaves.map((leaf) => ({ key: leaf.key, leaves: [leaf] }));
  });
}

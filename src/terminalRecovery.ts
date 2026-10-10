import { adoptSnapshotNames, isUserNamed, namePatch, tabName } from "./tabName";
import type {
  RememberedTerminal,
  RememberedTerminalState,
} from "./terminalMemory";
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
      const original = memory.terminals.find(
        (t) => t.tabId && leafIds(group.root).includes(t.tabId),
      );
      const names = original ? adoptSnapshotNames(original) : {};
      ready[key] =
        !isUserNamed(group) && isUserNamed(names)
          ? { ...group, ...namePatch(group, "user", tabName(names)) }
          : group;
    }
  }
  return remapTerminalGroups(ready, ids);
}

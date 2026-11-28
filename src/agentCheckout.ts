// Which checkout an agent is really changing, when it is not the one it was
// started in.
import { useEffect, useState } from "react";
import * as ipc from "./ipc";

/** The checkout an agent is really changing. An agent started in one checkout
 *  often works in a sibling worktree of the same repository by `cd`ing there in
 *  its shell; its process (and so `cwd`) never moves, and reading git from
 *  `cwd` showed the other checkout's branch and changes. The digest lists
 *  edited files outside `cwd` as absolute paths and those inside it as relative
 *  ones, in the order first touched: the newest that lies in one of this
 *  repository's worktrees decides. */
export function workingCheckout(
  cwd: string,
  files: readonly string[] | undefined,
  worktrees: readonly { path: string }[],
): string {
  const within = (path: string, root: string) => path === root || path.startsWith(`${root}/`);
  const home = worktrees
    .filter((w) => within(cwd, w.path))
    .sort((a, b) => b.path.length - a.path.length)[0]?.path;
  for (const file of [...(files ?? [])].reverse()) {
    if (!file.startsWith("/")) return cwd;
    const tree = worktrees
      .filter((w) => within(file, w.path))
      .sort((a, b) => b.path.length - a.path.length)[0]?.path;
    if (!tree) continue;
    return tree === home ? cwd : tree;
  }
  return cwd;
}

/** `workingCheckout` with this repository's worktrees read from git. `repo`
 *  null (no repository, or a terminal on another machine) keeps `cwd`. */
export function useWorkingCheckout(
  repo: string | null,
  cwd: string,
  files: readonly string[] | undefined,
): string {
  const [worktrees, setWorktrees] = useState<ipc.WorktreeInfo[]>([]);
  // A new worktree only matters once the agent edits a file in it.
  const count = files?.length ?? 0;
  useEffect(() => {
    setWorktrees([]);
    if (!repo) return;
    let stale = false;
    ipc
      .gitWorktrees(repo)
      .then((list) => {
        if (!stale) setWorktrees(list);
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [repo, count]);
  return workingCheckout(cwd, files, worktrees);
}

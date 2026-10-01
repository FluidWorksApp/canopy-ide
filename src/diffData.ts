/** Stable `data` props for `@git-diff-view/react`.
 *
 *  The library keys its internal `useMemo` on the identity of `data`, so a
 *  fresh object literal — the obvious thing to write inside a `files.map(...)`
 *  — makes it rebuild the DiffFile on every render: reparse the patch,
 *  re-highlight it, and remount the whole diff DOM, per file. The active tab's
 *  pane is rebuilt on every ProjectView render, and ProjectView re-renders
 *  around twice a second while an agent is working, so a thirty-file commit was
 *  re-parsing thirty patches twice a second for as long as it was open.
 *
 *  PrView solved this with a ref-keyed cache and the other three diff surfaces
 *  did not. This is that cache, in one place, so the next diff view inherits it
 *  instead of rediscovering the bug.
 *
 *  One rule if you write a richer variant — AgentWorkspaceView has one, keyed
 *  per pane and holding whole-file before/after for its edits view: **do not
 *  put a size cap on it.** That view capped at 128 entries evicted in insertion
 *  order, and a session touching more files than that turned the cache into a
 *  100% miss: one render inserts every file and evicts the earliest, the next
 *  render misses on exactly those. It was slower than no cache at all, and it
 *  presented as scroll jank rather than as anything cache-shaped. Bound the map
 *  by pruning to the keys currently rendered, never by a number that could be
 *  smaller than the number of files. */

import { useRef } from "react";

/** The exact shape DiffView's `data` prop wants. */
export interface DiffData {
  hunks: string[];
  oldFile: { fileName: string };
  newFile: { fileName: string };
}

/** A patch that knows which file it belongs to. */
interface Patched {
  path: string;
  patch: string;
}

/**
 * Returns a `dataFor(file)` that hands back the *same* object for the same
 * (path, patch) pair across renders, and a fresh one only when the patch text
 * actually changed.
 */
export function useDiffData(): (f: Patched) => DiffData {
  const cache = useRef(new Map<string, DiffData>());
  return (f: Patched): DiffData => {
    const hit = cache.current.get(f.path);
    // Compare the patch itself, not just the path: the same file at a different
    // commit is a different diff and must rebuild.
    if (hit && hit.hunks[0] === f.patch) return hit;
    const data: DiffData = {
      hunks: [f.patch],
      oldFile: { fileName: f.path },
      newFile: { fileName: f.path },
    };
    cache.current.set(f.path, data);
    return data;
  };
}

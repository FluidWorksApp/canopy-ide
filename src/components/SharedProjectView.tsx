import { useCallback, useMemo } from "react";
import type { DirEntry } from "../ipc";
import { FileTree } from "./FileTree";
import { FilesIcon } from "./icons";

interface SharedProjectViewProps {
  name: string;
  ownerName: string;
  /** Files in the shared project, as paths relative to its root. */
  paths: string[];
  /** Open one file live. The relative path is what the owner keyed the tree by. */
  onOpen: (relPath: string) => void;
}

// A synthetic root so the reused FileTree has a single string key to hang the
// tree off. It never reaches the user or the wire — paths are sliced back to
// the relative form the owner sent before they leave this component.
const ROOT = "shared-root";

const EMPTY = new Set<string>();

/** Immediate children of `dir` within the flat relative-path list, as the
 *  DirEntry rows FileTree renders. Folders sort before files. */
function childrenOf(dir: string, paths: string[]): DirEntry[] {
  const rel = dir === ROOT ? "" : dir.slice(ROOT.length + 1);
  const prefix = rel ? `${rel}/` : "";
  const kinds = new Map<string, boolean>(); // name -> is_dir
  for (const p of paths) {
    if (prefix && !p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    if (!rest) continue;
    const slash = rest.indexOf("/");
    if (slash === -1) kinds.set(rest, kinds.get(rest) ?? false);
    else kinds.set(rest.slice(0, slash), true);
  }
  return [...kinds]
    .sort((a, b) => {
      if (a[1] !== b[1]) return a[1] ? -1 : 1;
      return a[0].localeCompare(b[0], undefined, { sensitivity: "base" });
    })
    .map(([nm, is_dir]) => ({ name: nm, path: `${dir}/${nm}`, is_dir }));
}

export function SharedProjectView({ name, ownerName, paths, onOpen }: SharedProjectViewProps) {
  const readDir = useCallback(
    async (dir: string): Promise<DirEntry[]> => childrenOf(dir, paths),
    [paths],
  );
  const onOpenFile = useCallback(
    (path: string) => onOpen(path.slice(ROOT.length + 1)),
    [onOpen],
  );
  // Force FileTree to rebuild its cached dirs if the owner's tree changes.
  const treeKey = useMemo(() => `${paths.length}`, [paths]);

  return (
    <div className="shared-project">
      <div className="shared-project-head">
        <FilesIcon size={15} />
        <div>
          <div className="shared-project-title">{name}</div>
          <div className="shared-project-sub">
            Shared live by {ownerName} · {paths.length} files · click a file to edit it together
          </div>
        </div>
      </div>
      <div className="shared-tree">
        <FileTree
          key={treeKey}
          roots={[ROOT]}
          changedPaths={EMPTY}
          onOpenFile={onOpenFile}
          hideRootHeader
          readOnly
          readDir={readDir}
        />
      </div>
    </div>
  );
}

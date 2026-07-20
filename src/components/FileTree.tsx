// Multi-root lazy file tree. Directories load on expand via the Rust core;
// fs:change events refresh affected directories (debounced).
import { useCallback, useEffect, useRef, useState } from "react";
import * as ipc from "../ipc";
import type { Notify } from "../types";
import { ContextMenu, useContextMenu, type MenuItem } from "./ContextMenu";
import { useEscape } from "../useEscape";
import { fileIconUrl } from "./fileIcons";

interface FileTreeProps {
  roots: string[];
  changedPaths: Set<string>;
  onOpenFile: (path: string) => void;
  /** Only meaningful with the root header shown — that's the sole caller of it. */
  onRemoveRoot?: (root: string) => void;
  /** Surface an error/result message (rename clashes, delete failures, ...). */
  onNotice?: Notify;
  /** Render root contents directly (the caller already shows a labeled header). */
  hideRootHeader?: boolean;
}

interface DirState {
  entries: ipc.DirEntry[] | null;
  expanded: boolean;
}

// Standard IDE-style yellow folder (VS Code-like), inline SVG.
function FolderIcon({ open }: { open: boolean }) {
  return (
    <svg width="15" height="13" viewBox="0 0 16 14" className="folder-svg">
      {open ? (
        <>
          <path
            d="M1.5 2.5h4l1.5 1.5h6.5a1 1 0 0 1 1 1v1h-11l-2 6h-1v-8.5a1 1 0 0 1 1-1z"
            fill="#dcb67a"
          />
          <path d="M3.2 6.5h12.3l-1.8 6H1.5l1.7-6z" fill="#e8c88f" />
        </>
      ) : (
        <path
          d="M1.5 2.5h4l1.5 1.5h7.5a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1z"
          fill="#dcb67a"
        />
      )}
    </svg>
  );
}

/** Real file-type icon from the Material Icon Theme; falls back to its own
 *  generic file glyph when a type isn't recognised. */
function FileIcon({ name }: { name: string }) {
  const url = fileIconUrl(name);
  return url ? <img className="tree-icon-img" src={url} alt="" draggable={false} /> : null;
}

interface GitInfo {
  ignored: string[];
  untracked: string[];
  modified: Set<string>;
}

export function FileTree({
  roots,
  changedPaths,
  onOpenFile,
  onRemoveRoot,
  onNotice,
  hideRootHeader,
}: FileTreeProps) {
  const { menu, open, close } = useContextMenu();
  const [prompt, setPrompt] = useState<{
    kind: "new-file" | "new-dir" | "rename";
    dir: string;
    value: string;
    path?: string;
  } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{
    path: string;
    name: string;
    isDir: boolean;
  } | null>(null);
  useEscape(
    () => {
      setConfirmDelete(null);
      setPrompt(null);
    },
    confirmDelete != null || prompt != null,
  );
  // autoFocus loses the race when this dialog mounts while the context menu is
  // still unmounting, which left Enter going nowhere and no way to submit.
  const promptInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!prompt) return;
    const el = promptInput.current;
    if (!el) return;
    el.focus();
    // Select the basename, not the extension — renames usually keep the suffix.
    const dot = prompt.value.lastIndexOf(".");
    el.setSelectionRange(0, dot > 0 ? dot : prompt.value.length);
    // Re-focus only when a dialog opens, not on every keystroke.
  }, [prompt?.kind, prompt?.path, prompt?.dir]);

  const promptReady = (() => {
    if (!prompt) return false;
    const name = prompt.value.trim();
    if (!name || name.includes("/")) return false;
    if (prompt.kind === "rename" && `${prompt.dir}/${name}` === prompt.path) return false;
    return true;
  })();

  const submitPrompt = () => {
    if (!prompt || !promptReady) return;
    const name = prompt.value.trim();
    const target = `${prompt.dir}/${name}`;
    const { kind, path, dir } = prompt;
    setPrompt(null);
    if (kind === "new-file") {
      void run("Create file", async () => {
        await ipc.fsCreateFile(target);
        onOpenFile(target);
      }, dir);
    } else if (kind === "new-dir") {
      void run("Create folder", () => ipc.fsCreateDir(target), dir);
    } else if (path) {
      void run("Rename", () => ipc.fsRename(path, target), dir);
    }
  };
  // path -> load/expand state for every directory we've touched
  const [dirs, setDirs] = useState<Record<string, DirState>>({});
  const [git, setGit] = useState<Record<string, GitInfo>>({});
  const dirsRef = useRef(dirs);
  dirsRef.current = dirs;

  const loadGit = useCallback(async (root: string) => {
    try {
      const status = await ipc.gitStatus(root);
      if (!status.is_repo) return;
      const info: GitInfo = { ignored: [], untracked: [], modified: new Set() };
      for (const e of status.entries) {
        if (e.status === "!!") info.ignored.push(e.path);
        else if (e.status === "??") info.untracked.push(e.path);
        else info.modified.add(e.path);
      }
      setGit((prev) => ({ ...prev, [root]: info }));
    } catch {
      // git not available or not a repo — plain tree
    }
  }, []);

  // Priority: modified > new > ignored. Dir entries from git end with '/',
  // so prefix matches cover whole ignored/untracked directories.
  const gitClass = useCallback(
    (path: string, isDir: boolean): string => {
      for (const info of Object.values(git)) {
        const dirPath = path + "/";
        if (info.modified.has(path)) return "git-modified";
        if (isDir && [...info.modified].some((m) => m.startsWith(dirPath)))
          return "git-modified";
        if (info.untracked.some((u) => path === u || u === dirPath || path.startsWith(u)))
          return "git-new";
        if (info.ignored.some((i) => path === i || i === dirPath || path.startsWith(i)))
          return "git-ignored";
      }
      return "";
    },
    [git],
  );

  const loadDir = useCallback(async (path: string) => {
    try {
      const entries = await ipc.fsReadDir(path);
      setDirs((prev) => ({
        ...prev,
        [path]: { entries, expanded: prev[path]?.expanded ?? true },
      }));
    } catch {
      // directory vanished; drop it
      setDirs((prev) => {
        const next = { ...prev };
        delete next[path];
        return next;
      });
    }
  }, []);

  const toggleDir = useCallback(
    (path: string) => {
      const state = dirsRef.current[path];
      if (!state?.entries) {
        setDirs((prev) => ({ ...prev, [path]: { entries: null, expanded: true } }));
        void loadDir(path);
      } else {
        setDirs((prev) => ({
          ...prev,
          [path]: { ...state, expanded: !state.expanded },
        }));
      }
    },
    [loadDir],
  );

  // Auto-expand roots on first appearance + load their git status.
  useEffect(() => {
    for (const root of roots) {
      if (!dirsRef.current[root]) {
        toggleDir(root);
        void loadGit(root);
      }
    }
  }, [roots, toggleDir, loadGit]);

  // Refresh loaded directories touched by external changes (debounced).
  useEffect(() => {
    let pending = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unlisten = ipc.onFsChange((e) => {
      for (const p of e.paths) {
        const parent = p.slice(0, p.lastIndexOf("/"));
        if (dirsRef.current[parent]?.entries) pending.add(parent);
      }
      clearTimeout(timer);
      timer = setTimeout(() => {
        for (const dir of pending) void loadDir(dir);
        pending = new Set();
        // file changes shift git state too
        for (const root of roots) void loadGit(root);
      }, 300);
    });
    return () => {
      clearTimeout(timer);
      void unlisten.then((fn) => fn());
    };
  }, [loadDir]);

  // ---------- context menu ----------

  const parentOf = (p: string) => p.slice(0, p.lastIndexOf("/")) || "/";

  const run = async (label: string, fn: () => Promise<unknown>, refreshDir: string) => {
    try {
      await fn();
      await loadDir(refreshDir);
    } catch (err) {
      onNotice?.(`${label} failed: ${String(err)}`);
    }
  };

  const itemsFor = (path: string, isDir: boolean, name: string): MenuItem[] => {
    const dir = isDir ? path : parentOf(path);
    return [
      {
        label: "New File…",
        onClick: () => setPrompt({ kind: "new-file", dir, value: "" }),
      },
      {
        label: "New Folder…",
        onClick: () => setPrompt({ kind: "new-dir", dir, value: "" }),
      },
      { separator: true, label: "" },
      {
        label: "Rename…",
        onClick: () => setPrompt({ kind: "rename", dir: parentOf(path), value: name, path }),
      },
      {
        label: "Duplicate",
        onClick: () => void run("Duplicate", () => ipc.fsDuplicate(path), parentOf(path)),
      },
      { separator: true, label: "" },
      {
        label: "Copy Path",
        onClick: () => void navigator.clipboard.writeText(path).catch(() => {}),
      },
      {
        label: "Copy Relative Path",
        onClick: () => {
          const root = roots.find((r) => path.startsWith(r + "/"));
          void navigator.clipboard
            .writeText(root ? path.slice(root.length + 1) : path)
            .catch(() => {});
        },
      },
      {
        label: "Reveal in Finder",
        onClick: () => void ipc.fsReveal(path).catch((e) => onNotice?.(String(e))),
      },
      { separator: true, label: "" },
      {
        // Trash, not unlink: recoverable if it was a misclick, and uncommitted
        // work in that file isn't gone for good.
        label: "Move to Trash",
        danger: true,
        onClick: () => setConfirmDelete({ path, name, isDir }),
      },
    ];
  };

  /** Right-clicking blank space acts on the directory you are looking at. */
  const emptyItems = (dir: string): MenuItem[] => [
    { label: "New File…", onClick: () => setPrompt({ kind: "new-file", dir, value: "" }) },
    { label: "New Folder…", onClick: () => setPrompt({ kind: "new-dir", dir, value: "" }) },
    { separator: true, label: "" },
    { label: "Reveal in Finder", onClick: () => void ipc.fsReveal(dir).catch(() => {}) },
    { label: "Refresh", onClick: () => void loadDir(dir) },
  ];

  const renderDir = (path: string, depth: number) => {
    const state = dirs[path];
    if (!state?.expanded || !state.entries) return null;
    return state.entries.map((entry) => {
      const expanded = dirs[entry.path]?.expanded ?? false;
      return (
        <div key={entry.path} className={depth > 0 ? "tree-indent" : undefined}>
          <div
            className={`tree-row ${changedPaths.has(entry.path) ? "tree-changed" : ""} ${gitClass(entry.path, entry.is_dir)}`}
            onClick={() =>
              entry.is_dir ? toggleDir(entry.path) : onOpenFile(entry.path)
            }
            onContextMenu={(e) => open(e, itemsFor(entry.path, entry.is_dir, entry.name))}
          >
            <span className="tree-chevron">
              {entry.is_dir ? (expanded ? "▾" : "▸") : ""}
            </span>
            <span className="tree-file-icon">
              {entry.is_dir ? <FolderIcon open={expanded} /> : <FileIcon name={entry.name} />}
            </span>
            <span className={entry.is_dir ? "tree-dir" : "tree-file"}>{entry.name}</span>
          </div>
          {entry.is_dir && renderDir(entry.path, depth + 1)}
        </div>
      );
    });
  };

  return (
    <div
      className="file-tree"
      // Blank space below the tree still belongs to the first root.
      onContextMenu={(e) => roots[0] && open(e, emptyItems(roots[0]))}
    >
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={close} />}

      {prompt && (
        <div className="confirm-backdrop" onMouseDown={() => setPrompt(null)}>
          <form
            className="confirm"
            onMouseDown={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault();
              submitPrompt();
            }}
          >
            <p>
              {prompt.kind === "rename"
                ? "Rename"
                : prompt.kind === "new-dir"
                  ? "New folder in"
                  : "New file in"}{" "}
              <code>{prompt.kind === "rename" ? prompt.path : prompt.dir}</code>
            </p>
            <input
              className="git-branch-input"
              ref={promptInput}
              value={prompt.value}
              placeholder={prompt.kind === "new-dir" ? "folder name" : "name.ext"}
              onChange={(e) => setPrompt({ ...prompt, value: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Escape") setPrompt(null);
              }}
            />
            <div className="confirm-actions">
              <button type="button" className="btn" onClick={() => setPrompt(null)}>
                Cancel
              </button>
              <button type="submit" className="btn btn-accent" disabled={!promptReady}>
                {prompt.kind === "rename" ? "Rename" : "Create"}
              </button>
            </div>
          </form>
        </div>
      )}

      {confirmDelete && (
        <div className="confirm-backdrop" onMouseDown={() => setConfirmDelete(null)}>
          <div className="confirm" onMouseDown={(e) => e.stopPropagation()}>
            <p>
              Move <strong>{confirmDelete.name}</strong> to the Trash?
            </p>
            <p className="confirm-sub">
              {confirmDelete.isDir
                ? "The folder and everything in it goes to the Trash. You can restore it from there."
                : "It goes to the Trash — you can restore it from there."}
            </p>
            <div className="confirm-actions">
              <button className="btn" onClick={() => setConfirmDelete(null)}>
                Cancel
              </button>
              <button
                className="btn btn-danger-solid"
                onClick={() => {
                  const { path } = confirmDelete;
                  setConfirmDelete(null);
                  void run("Delete", () => ipc.fsTrash(path), path.slice(0, path.lastIndexOf("/")));
                }}
              >
                Move to Trash
              </button>
            </div>
          </div>
        </div>
      )}

      {roots.map((root) => (
        <div key={root} className="tree-root">
          {!hideRootHeader && (
            <div className="tree-root-header" onClick={() => toggleDir(root)}>
              <span className="tree-icon">{dirs[root]?.expanded ? "▾" : "▸"}</span>
              <span className="tree-root-name" title={root}>
                {root.split("/").pop()}
              </span>
              <button
                className="btn-icon"
                title="Remove from workspace"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemoveRoot?.(root);
                }}
              >
                ✕
              </button>
            </div>
          )}
          {renderDir(root, hideRootHeader ? 0 : 1)}
        </div>
      ))}
      {roots.length === 0 && !hideRootHeader && (
        <div className="tree-empty">No folder open. Use “Open Folder…”</div>
      )}
    </div>
  );
}

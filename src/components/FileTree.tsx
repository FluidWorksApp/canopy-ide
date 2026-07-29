// Multi-root lazy file tree. Directories load on expand via the Rust core;
// fs:change events refresh affected directories (debounced).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as ipc from "../ipc";
import type { Notify } from "../types";
import { ContextMenu, useContextMenu, type MenuItem } from "./ContextMenu";
import { Dialog } from "./Dialog";
import { fileIconUrl } from "./fileIcons";
import { ChevronIcon } from "./icons";
import { WindowedList } from "./WindowedList";

/** Must match .tree-row's CSS height — the windowing spacers are the scrollbar. */
const ROW_H = 26;

/** One paintable line of the tree, in visual order: a root header (when shown)
 *  or a file/dir row with its nesting depth. Flat rather than recursive so the
 *  list can be windowed — only rows near the viewport are mounted. */
type TreeItem =
  | { kind: "header"; root: string }
  | {
      kind: "entry";
      path: string;
      name: string;
      isDir: boolean;
      parent: string | null;
      depth: number;
    };

interface FileTreeProps {
  roots: string[];
  changedPaths: Set<string>;
  /** Path of the file currently open in the active tab — gets the accent-soft
   *  selected treatment. */
  selectedPath?: string | null;
  onOpenFile: (path: string) => void;
  /** Only meaningful with the root header shown — that's the sole caller of it. */
  onRemoveRoot?: (root: string) => void;
  /** Surface an error/result message (rename clashes, delete failures, ...). */
  onNotice?: Notify;
  /** Render root contents directly (the caller already shows a labeled header). */
  hideRootHeader?: boolean;
  /** Override how a directory's entries are fetched. Defaults to the local
   *  filesystem; a live-shared project passes a reader backed by the tree its
   *  owner sent over the relay. */
  readDir?: (path: string) => Promise<ipc.DirEntry[]>;
  /** No git overlay, no filesystem watch, no rename/delete/create — for a tree
   *  that isn't the local disk (a teammate's shared project). */
  readOnly?: boolean;
  /** The "Tasks ▸" submenu for a right-clicked path, built by the owner (it
   *  knows the task registry); omitted where tasks don't apply. */
  taskMenuFor?: (path: string) => MenuItem;
}

interface DirState {
  entries: ipc.DirEntry[] | null;
  expanded: boolean;
}

// Stable DOM id for a row, so the tree container can point
// aria-activedescendant at the cursor row. A path can hold any character, so
// encode it rather than interpolate it raw into an id.
const rowId = (path: string) => `tree-row-${encodeURIComponent(path)}`;

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
  return url ? (
    <img className="tree-icon-img" src={url} alt="" draggable={false} />
  ) : null;
}

interface GitInfo {
  ignored: string[];
  untracked: string[];
  modified: Set<string>;
}

export function FileTree({
  roots,
  changedPaths,
  selectedPath,
  onOpenFile,
  onRemoveRoot,
  onNotice,
  hideRootHeader,
  readDir,
  readOnly,
  taskMenuFor,
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
    if (prompt.kind === "rename" && `${prompt.dir}/${name}` === prompt.path)
      return false;
    return true;
  })();

  const submitPrompt = () => {
    if (!prompt || !promptReady) return;
    const name = prompt.value.trim();
    const target = `${prompt.dir}/${name}`;
    const { kind, path, dir } = prompt;
    setPrompt(null);
    if (kind === "new-file") {
      void run(
        "Create file",
        async () => {
          await ipc.fsCreateFile(target);
          onOpenFile(target);
        },
        dir,
      );
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

  // Keyboard cursor — the row arrow keys move through. Distinct from
  // `selectedPath` (the open file): the cursor can sit on a folder, and moving
  // it must not open anything. Null until the list is focused.
  const [cursor, setCursor] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Every visible line top-to-bottom, flattened from the same lazy `dirs`
  // state — a folder that hasn't been expanded contributes nothing (its
  // children aren't loaded, and aren't on screen). This is both what the
  // windowed list paints and what the arrow keys index into. `parent` is the
  // row a child hangs off — its containing directory, so ArrowLeft can jump
  // out to it; null for a root's direct entries.
  const items = useMemo(() => {
    const out: TreeItem[] = [];
    const walk = (dirPath: string, parent: string | null, depth: number) => {
      const state = dirs[dirPath];
      if (!state?.expanded || !state.entries) return;
      for (const entry of state.entries) {
        out.push({
          kind: "entry",
          path: entry.path,
          name: entry.name,
          isDir: entry.is_dir,
          parent,
          depth,
        });
        if (entry.is_dir) walk(entry.path, entry.path, depth + 1);
      }
    };
    for (const root of roots) {
      if (!hideRootHeader) out.push({ kind: "header", root });
      walk(root, null, hideRootHeader ? 0 : 1);
    }
    return out;
  }, [dirs, roots, hideRootHeader]);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  /** Navigable rows only — headers aren't part of the keyboard cursor cycle. */
  const flat = useMemo(
    () =>
      items.filter(
        (i): i is Extract<TreeItem, { kind: "entry" }> => i.kind === "entry",
      ),
    [items],
  );
  const rowsRef = useRef<HTMLDivElement | null>(null);

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
        if (
          info.untracked.some(
            (u) => path === u || u === dirPath || path.startsWith(u),
          )
        )
          return "git-new";
        if (
          info.ignored.some(
            (i) => path === i || i === dirPath || path.startsWith(i),
          )
        )
          return "git-ignored";
      }
      return "";
    },
    [git],
  );

  const loadDir = useCallback(
    async (path: string) => {
      try {
        const entries = await (readDir ?? ipc.fsReadDir)(path);
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
    },
    [readDir],
  );

  const toggleDir = useCallback(
    (path: string) => {
      const state = dirsRef.current[path];
      if (!state?.entries) {
        setDirs((prev) => ({
          ...prev,
          [path]: { entries: null, expanded: true },
        }));
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

  // Scroll a cursor row back into view by hand. NOT scrollIntoView: that walks
  // up to the nearest scrollable ancestor and can move the whole app window
  // (the bug that prompted keyboard nav). We adjust the scroll container's
  // scrollTop directly, with a small margin, and only when the row is clipped.
  //
  // Finding the container: .file-tree carries `overflow-y: auto` but is
  // `flex: 1` with no fixed height, so it grows to its content and never
  // scrolls — the element that actually scrolls is the outer .components-panel.
  // So we can't stop at the first `overflow: auto` ancestor; we must find one
  // that is genuinely scrollable (scrollHeight > clientHeight).
  const reveal = useCallback((path: string) => {
    const el = rowsRef.current;
    if (!el) return;
    // Arithmetic, not a DOM query: a row outside the window isn't mounted, but
    // its position is fully determined by its index and the fixed row height.
    const index = itemsRef.current.findIndex(
      (i) => i.kind === "entry" && i.path === path,
    );
    if (index < 0) return;
    let box: HTMLElement | null = el;
    while (box) {
      const oy = getComputedStyle(box).overflowY;
      const scrollable =
        (oy === "auto" || oy === "scroll") &&
        box.scrollHeight > box.clientHeight;
      if (scrollable) break;
      box = box.parentElement;
    }
    if (!box) return;
    const listTop =
      el.getBoundingClientRect().top -
      box.getBoundingClientRect().top +
      box.scrollTop;
    const rowTop = listTop + index * ROW_H;
    const rowBottom = rowTop + ROW_H;
    if (rowTop < box.scrollTop) box.scrollTop = rowTop - 4;
    else if (rowBottom > box.scrollTop + box.clientHeight)
      box.scrollTop = rowBottom - box.clientHeight + 4;
  }, []);

  const moveCursor = useCallback(
    (path: string) => {
      setCursor(path);
      reveal(path);
    },
    [reveal],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const keys = [
        "ArrowDown",
        "ArrowUp",
        "ArrowRight",
        "ArrowLeft",
        "Home",
        "End",
        "Enter",
        " ",
      ];
      if (!keys.includes(e.key)) return;
      // Both: preventDefault stops the panel scrolling, stopPropagation keeps
      // the app-level key handlers (tab cycling, etc.) out of it while the tree
      // has focus.
      e.preventDefault();
      e.stopPropagation();
      if (flat.length === 0) return;

      const i = flat.findIndex((r) => r.path === cursor);
      const cur = i >= 0 ? flat[i] : null;

      if (e.key === "ArrowDown")
        return moveCursor(flat[Math.min(flat.length - 1, i + 1)].path);
      if (e.key === "ArrowUp") return moveCursor(flat[i <= 0 ? 0 : i - 1].path);
      if (e.key === "Home") return moveCursor(flat[0].path);
      if (e.key === "End") return moveCursor(flat[flat.length - 1].path);
      if (!cur) return moveCursor(flat[0].path);

      const state = dirsRef.current[cur.path];
      const open = cur.isDir && Boolean(state?.expanded && state.entries);

      if (e.key === "ArrowRight") {
        if (cur.isDir && !open) toggleDir(cur.path);
        else if (open && state?.entries?.length)
          moveCursor(state.entries[0].path);
        return;
      }
      if (e.key === "ArrowLeft") {
        if (open) toggleDir(cur.path);
        else if (cur.parent) moveCursor(cur.parent);
        return;
      }
      // Enter / Space
      if (cur.isDir) toggleDir(cur.path);
      else onOpenFile(cur.path);
    },
    [flat, cursor, moveCursor, toggleDir, onOpenFile],
  );

  // Auto-expand roots on first appearance + load their git status.
  useEffect(() => {
    for (const root of roots) {
      if (!dirsRef.current[root]) {
        toggleDir(root);
        if (!readOnly) void loadGit(root);
      }
    }
  }, [roots, toggleDir, loadGit, readOnly]);

  // Refresh loaded directories touched by external changes (debounced). A
  // shared project isn't on this disk, so there is nothing local to watch.
  useEffect(() => {
    if (readOnly) return;
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
  }, [loadDir, readOnly]);

  // ---------- context menu ----------

  const parentOf = (p: string) => p.slice(0, p.lastIndexOf("/")) || "/";

  const run = async (
    label: string,
    fn: () => Promise<unknown>,
    refreshDir: string,
  ) => {
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
        onClick: () =>
          setPrompt({ kind: "rename", dir: parentOf(path), value: name, path }),
      },
      {
        label: "Duplicate",
        onClick: () =>
          void run("Duplicate", () => ipc.fsDuplicate(path), parentOf(path)),
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
        onClick: () =>
          void ipc.fsReveal(path).catch((e) => onNotice?.(String(e))),
      },
      ...(taskMenuFor
        ? [{ separator: true, label: "" }, taskMenuFor(path)]
        : []),
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
    {
      label: "New File…",
      onClick: () => setPrompt({ kind: "new-file", dir, value: "" }),
    },
    {
      label: "New Folder…",
      onClick: () => setPrompt({ kind: "new-dir", dir, value: "" }),
    },
    ...(taskMenuFor ? [taskMenuFor(dir)] : []),
    { separator: true, label: "" },
    {
      label: "Reveal in Finder",
      onClick: () => void ipc.fsReveal(dir).catch(() => {}),
    },
    { label: "Refresh", onClick: () => void loadDir(dir) },
  ];

  const renderItem = (item: TreeItem) => {
    if (item.kind === "header") {
      return (
        <div
          key={`header:${item.root}`}
          className="tree-root-header"
          onClick={() => toggleDir(item.root)}
        >
          <span className="tree-icon">
            {dirs[item.root]?.expanded ? "▾" : "▸"}
          </span>
          <span className="tree-root-name" title={item.root}>
            {item.root.split("/").pop()}
          </span>
          <button
            className="btn-icon"
            title="Remove from workspace"
            onClick={(e) => {
              e.stopPropagation();
              onRemoveRoot?.(item.root);
            }}
          >
            ✕
          </button>
        </div>
      );
    }
    const expanded = dirs[item.path]?.expanded ?? false;
    return (
      <div
        key={item.path}
        data-tree-path={item.path}
        id={rowId(item.path)}
        role="treeitem"
        aria-selected={item.path === cursor}
        aria-expanded={item.isDir ? expanded : undefined}
        className={`tree-row ${changedPaths.has(item.path) ? "tree-changed" : ""} ${
          !item.isDir && item.path === selectedPath ? "tree-row-selected" : ""
        } ${item.path === cursor ? "tree-row-cursor" : ""} ${gitClass(item.path, item.isDir)}`}
        onClick={() => {
          // Keep mouse and keyboard in agreement: a click parks the cursor
          // where you clicked, so arrowing continues from there.
          setCursor(item.path);
          if (item.isDir) toggleDir(item.path);
          else onOpenFile(item.path);
        }}
        onContextMenu={(e) => {
          if (!readOnly) open(e, itemsFor(item.path, item.isDir, item.name));
        }}
      >
        {/* Ancestor guides, one per level — rows are flat siblings now (the
            windowing needs that), so each row draws its own slice of the
            hairlines the nested wrappers used to provide. */}
        {Array.from({ length: item.depth }, (_, d) => (
          <span key={d} className="tree-guide" aria-hidden />
        ))}
        <span
          className={`tree-chevron ${item.isDir && expanded ? "tree-chevron-open" : ""}`}
        >
          {item.isDir ? <ChevronIcon /> : null}
        </span>
        <span className="tree-file-icon">
          {item.isDir ? (
            <FolderIcon open={expanded} />
          ) : (
            <FileIcon name={item.name} />
          )}
        </span>
        <span className={item.isDir ? "tree-dir" : "tree-file"}>
          {item.name}
        </span>
        {changedPaths.has(item.path) && !item.isDir && (
          <span className="tree-changed-dot" aria-hidden />
        )}
      </div>
    );
  };

  return (
    <div
      ref={listRef}
      className="file-tree"
      tabIndex={0}
      role="tree"
      aria-label={`${roots[0]?.split("/").pop() ?? "Project"} files`}
      // Focus stays on the container; this tells assistive tech which row the
      // cursor is on, so arrowing announces the row it lands on.
      aria-activedescendant={cursor ? rowId(cursor) : undefined}
      onKeyDown={onKeyDown}
      // First focus with no cursor yet lands on the top row, so arrow keys have
      // somewhere to start.
      onFocus={() => {
        if (cursor == null && flat.length > 0) setCursor(flat[0].path);
      }}
      // Drop the cursor when focus leaves this tree entirely. ProjectView mounts
      // one FileTree per component, each with its own cursor; without this,
      // every tree that had ever been focused kept showing a highlighted row, so
      // several "cursors" appeared at once. Ignore blurs into our own descendants
      // (the rename prompt input, the context menu) — those aren't leaving.
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null))
          setCursor(null);
      }}
      // Blank space below the tree still belongs to the first root.
      onContextMenu={(e) =>
        !readOnly && roots[0] && open(e, emptyItems(roots[0]))
      }
    >
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={close} />
      )}

      {prompt && (
        <Dialog
          variant="accent"
          title={
            prompt.kind === "rename"
              ? "Rename"
              : prompt.kind === "new-dir"
                ? "New folder"
                : "New file"
          }
          meta={prompt.kind === "rename" ? prompt.path : prompt.dir}
          dismissLabel="Cancel"
          onDismiss={() => setPrompt(null)}
          actions={[
            {
              label: prompt.kind === "rename" ? "Rename" : "Create",
              primary: true,
              disabled: !promptReady,
              onClick: submitPrompt,
            },
          ]}
        >
          <input
            className="git-branch-input"
            // Beats the primary button to focus: the name is what you came to
            // type, and Enter still commits from inside the field.
            data-autofocus
            ref={promptInput}
            value={prompt.value}
            placeholder={prompt.kind === "new-dir" ? "folder name" : "name.ext"}
            onChange={(e) => setPrompt({ ...prompt, value: e.target.value })}
          />
        </Dialog>
      )}

      {confirmDelete && (
        <Dialog
          variant="danger"
          title={`Move ${confirmDelete.name} to the Trash?`}
          body={
            confirmDelete.isDir
              ? "The folder and everything in it goes to the Trash. You can restore it from there."
              : "It goes to the Trash — you can restore it from there."
          }
          meta={confirmDelete.path}
          dismissLabel="Cancel"
          onDismiss={() => setConfirmDelete(null)}
          actions={[
            {
              label: "Move to Trash",
              primary: true,
              onClick: () => {
                const { path } = confirmDelete;
                setConfirmDelete(null);
                void run(
                  "Delete",
                  () => ipc.fsTrash(path),
                  path.slice(0, path.lastIndexOf("/")),
                );
              },
            },
          ]}
        />
      )}

      <WindowedList
        items={items}
        rowHeight={ROW_H}
        innerRef={rowsRef}
        renderRow={renderItem}
      />
      {roots.length === 0 && !hideRootHeader && (
        <div className="tree-empty">No folder open. Use “Open Folder…”</div>
      )}
    </div>
  );
}

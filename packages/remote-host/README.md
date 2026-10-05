import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FileTree } from "./FileTree";
import * as ipc from "../ipc";

// FileTree loads directories lazily through ipc. Mock the calls it makes:
// fsReadDir (directory contents), gitStatus (overlay — no repo here), and the
// two watchers, onFsChange and onGitChange (no-op unsubscribes).
vi.mock("../ipc", () => ({
  fsReadDir: vi.fn(),
  gitStatus: vi.fn(),
  onFsChange: vi.fn(),
  onGitChange: vi.fn(),
  fsReveal: vi.fn(),
}));

// The file-type icon fetches a URL; keep it out of the way.
vi.mock("./fileIcons", () => ({ fileIconUrl: () => null }));

const ROOT = "/proj";
const TREE: Record<string, ipc.DirEntry[]> = {
  "/proj": [
    { name: "src", path: "/proj/src", is_dir: true },
    { name: "README.md", path: "/proj/README.md", is_dir: false },
  ],
  "/proj/src": [
    { name: "app.ts", path: "/proj/src/app.ts", is_dir: false },
    { name: "util.ts", path: "/proj/src/util.ts", is_dir: false },
  ],
};

beforeEach(() => {
  vi.mocked(ipc.fsReadDir).mockImplementation(async (p: string) => TREE[p] ?? []);
  vi.mocked(ipc.gitStatus).mockResolvedValue({ is_repo: false, entries: [] } as never);
  vi.mocked(ipc.onFsChange).mockResolvedValue(() => {});
  vi.mocked(ipc.onGitChange).mockResolvedValue(() => {});
});

// The root auto-expands on mount (loadDir is async); wait for its entries.
async function renderTree(onOpenFile = vi.fn()) {
  render(
    <FileTree roots={[ROOT]} changedPaths={new Set()} onOpenFile={onOpenFile} hideRootHeader />,
  );
  await screen.findByText("src");
  await screen.findByText("README.md");
  return onOpenFile;
}

const tree = () => screen.getByRole("tree");
const rowOf = (name: string) => screen.getByText(name).closest(".tree-row") as HTMLElement;

describe("FileTree keyboard navigation", () => {
  it("exposes the list as a focusable tree", async () => {
    await renderTree();
    const list = tree();
    expect(list).toHaveAttribute("tabindex", "0");
    expect(list).toHaveAttribute("aria-label", "proj files");
  });

  it("seeds the cursor to the first row on focus", async () => {
    await renderTree();
    act(() => tree().focus());
    expect(rowOf("src")).toHaveClass("tree-row-cursor");
  });

  it("clears the cursor when focus leaves the tree", async () => {
    // ProjectView mounts one FileTree per component; each must drop its cursor
    // on blur so only the focused tree shows a highlighted row.
    await renderTree();
    act(() => tree().focus());
    expect(rowOf("src")).toHaveClass("tree-row-cursor");
    act(() => tree().blur());
    expect(rowOf("src")).not.toHaveClass("tree-row-cursor");
    expect(tree().getAttribute("aria-activedescendant")).toBeNull();
  });

  it("exposes rows as treeitems and points aria-activedescendant at the cursor", async () => {
    await renderTree();
    const srcRow = rowOf("src");
    expect(srcRow).toHaveAttribute("role", "treeitem");
    expect(srcRow).toHaveAttribute("aria-expanded", "false"); // collapsed folder
    expect(rowOf("README.md")).not.toHaveAttribute("aria-expanded"); // files have none
    act(() => tree().focus());
    // Container keeps focus; activedescendant tracks the cursor row's id.
    expect(tree().getAttribute("aria-activedescendant")).toBe(srcRow.id);
    expect(srcRow).toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{ArrowDown}");
    expect(tree().getAttribute("aria-activedescendant")).toBe(rowOf("README.md").id);
  });

  it("moves the cursor with ArrowDown / ArrowUp", async () => {
    await renderTree();
    act(() => tree().focus());
    await userEvent.keyboard("{ArrowDown}");
    expect(rowOf("README.md")).toHaveClass("tree-row-cursor");
    expect(rowOf("src")).not.toHaveClass("tree-row-cursor");
    await userEvent.keyboard("{ArrowUp}");
    expect(rowOf("src")).toHaveClass("tree-row-cursor");
  });

  it("ArrowRight expands a collapsed folder, then steps into it", async () => {
    await renderTree();
    act(() => tree().focus()); // cursor on "src" (collapsed)
    await userEvent.keyboard("{ArrowRight}"); // expand
    await screen.findByText("app.ts");
    expect(rowOf("src")).toHaveClass("tree-row-cursor"); // still on the folder
    await userEvent.keyboard("{ArrowRight}"); // step into first child
    expect(rowOf("app.ts")).toHaveClass("tree-row-cursor");
  });

  it("ArrowLeft collapses an open folder, and jumps to the parent from a child", async () => {
    const onOpenFile = await renderTree();
    act(() => tree().focus());
    await userEvent.keyboard("{ArrowRight}"); // expand src
    await screen.findByText("app.ts");
    await userEvent.keyboard("{ArrowRight}"); // into app.ts
    expect(rowOf("app.ts")).toHaveClass("tree-row-cursor");
    await userEvent.keyboard("{ArrowLeft}"); // child → parent
    expect(rowOf("src")).toHaveClass("tree-row-cursor");
    await userEvent.keyboard("{ArrowLeft}"); // open folder → collapse
    expect(screen.queryByText("app.ts")).not.toBeInTheDocument();
    expect(onOpenFile).not.toHaveBeenCalled(); // navigation never opens a file
  });

  it("Enter opens the file under the cursor", async () => {
    const onOpenFile = await renderTree();
    act(() => tree().focus());
    await userEvent.keyboard("{ArrowDown}"); // to README.md
    await userEvent.keyboard("{Enter}");
    expect(onOpenFile).toHaveBeenCalledWith("/proj/README.md");
  });

  it("Home / End jump to the first and last visible rows", async () => {
    await renderTree();
    act(() => tree().focus());
    await userEvent.keyboard("{End}");
    expect(rowOf("README.md")).toHaveClass("tree-row-cursor");
    await userEvent.keyboard("{Home}");
    expect(rowOf("src")).toHaveClass("tree-row-cursor");
  });

  it("consumes arrow keys so the panel behind does not scroll", async () => {
    await renderTree();
    act(() => tree().focus());
    // Dispatch a real, cancelable keydown and check the handler consumed it.
    // A bubbling window listener sees the event after React's handler has run,
    // so defaultPrevented reflects our preventDefault() call.
    const ev = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
    act(() => {
      tree().dispatchEvent(ev);
    });
    expect(ev.defaultPrevented).toBe(true);
  });
});

it("refreshes loaded folders on remote overflow events",async()=>{
 let change:((event:ipc.FsChange)=>void)|undefined;vi.mocked(ipc.onFsChange).mockImplementation(async cb=>{change=cb;return ()=>{};});await renderTree();vi.mocked(ipc.fsReadDir).mockClear();await act(async()=>{change?.({root:ROOT,kind:'other',paths:[],overflow:true});await new Promise(resolve=>setTimeout(resolve,350));});expect(ipc.fsReadDir).toHaveBeenCalledWith(ROOT);
});
it("refreshes without resetting the existing tree",async()=>{
 const {rerender}=render(<FileTree roots={[ROOT]} changedPaths={new Set()} onOpenFile={()=>{}} hideRootHeader refreshRevision={0}/>);await screen.findByText('README.md');vi.mocked(ipc.fsReadDir).mockClear();rerender(<FileTree roots={[ROOT]} changedPaths={new Set()} onOpenFile={()=>{}} hideRootHeader refreshRevision={1}/>);await act(async()=>{});expect(ipc.fsReadDir).toHaveBeenCalledWith(ROOT);
});

it('remote upload actions target the selected directory and refresh after completion',async()=>{
 const upload=vi.fn().mockResolvedValue(undefined);
 render(<FileTree roots={[ROOT]} changedPaths={new Set()} onOpenFile={()=>{}} onUpload={upload} hideRootHeader/>);
 const folder=await screen.findByText('src');fireEvent.contextMenu(folder,{clientX:30,clientY:30});
 await userEvent.click(await screen.findByText('Upload files…'));expect(upload).toHaveBeenCalledWith('/proj/src','files');
 await act(async()=>{});expect(ipc.fsReadDir).toHaveBeenCalledWith('/proj/src');
 fireEvent.contextMenu(folder,{clientX:30,clientY:30});await userEvent.click(await screen.findByText('Upload folder…'));expect(upload).toHaveBeenCalledWith('/proj/src','folder');
});
it('local trees retain their existing menus without remote upload actions',async()=>{
 await renderTree();fireEvent.contextMenu(screen.getByText('src'),{clientX:30,clientY:30});expect(screen.queryByText('Upload files…')).toBeNull();
});

### Upload files and folders from local disk

In a remote project's Components panel, use **Upload…**, or right-click a
component/folder and choose **Upload files…** or **Upload folder…**. Canopy opens
the native local disk chooser and uploads into the selected remote directory.
Files can be selected together; folder uploads retain the selected folder name,
nested directories, empty directories, dotfiles and ordinary Unix file permissions.
Uploaded folders appear in the file tree. Use the existing project editor's
**Add directory…** if that folder should also become a project component.

Transfers use 256 KiB chunks, one file at a time, with a SHA-256 integrity check
and atomic publication of each finished file. Existing files are never replaced;
rename or remove a conflicting file before uploading it again. Cancel removes
the current incomplete file while retaining already completed files. Disconnected
uploads expire after 15 idle minutes. Incomplete staging files are cleaned on the
next upload operation. File data is not loaded wholesale into the renderer.

The current limits are 16 GiB per file, 20,000 files/folders per local selection,
and four active receiving files per workspace. Symlinks and special local files
are skipped; the completion notice reports the count. Remote symlinks cannot be
used as upload destinations. The receiver is included in the portable Docker
build; uploads require a drive grant and remain inside the selected workspace.

### Inspect an interrupted sharing migration

With the gateway stopped, run on the trusted host:

```sh
node inspect-migration.mjs /path/to/host.json /var/lib/canopy-host/migrations/WORKSPACE.migration.jsonl
```

This command only reads configuration, the journal and Docker inspection results.
It reports whether replacement never began, the original is restored, rollback
is needed, or the replacement configuration was published. Conflicting identities
or configuration fail closed. It does not start, stop, rename or delete containers.
Keep journals outside developer mounts; retain the original container and volumes
until recovery and file preservation have been verified. Automated rollback and
migration orchestration are not yet exposed by this command.

Gateway startup checks journals in `$CANOPY_HOST_STATE/migrations` (default
`/var/lib/canopy-host/migrations`) before accepting connections. Migration operators
must create journals there. Interrupted or torn migrations quarantine that workspace;
corrupt evidence stops gateway startup. A complete commit is accepted only when
configuration and inspected container identities agree. Startup does not roll back,
restart, or delete owner containers. The offline recovery operator must verify and
archive recovered journals before reopening the workspace.


For an assessment of `rollback-needed`, the trusted Linux host now provides:

```sh
sudo node /opt/canopy-host/recover-migration.mjs /etc/canopy-host/host.json /var/lib/canopy-host/migrations/WORKSPACE.migration.jsonl /var/lib/canopy-host
```

Establish a maintenance window first: the gateway must be stopped and effectively
masked in systemd. The command checks loaded state, unit-file state and MainPID;
a merely disabled or stopped service is insufficient. It does not stop sessions
on your behalf. Recovery retains the failed replacement, restores the original
stopped container, and writes a separate recovery journal. It never deletes user
containers or volumes, changes host configuration, unmasks the service, or starts
the restored workspace. Inspect actual state and archive the original migration
journal only after verifying recovery; then the operator can end maintenance.

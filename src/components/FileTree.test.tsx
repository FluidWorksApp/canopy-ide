import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
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

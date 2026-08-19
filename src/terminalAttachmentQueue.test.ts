import { describe, expect, it, vi } from "vitest";
import {
  projectForTerminalCwd,
  TerminalAttachmentQueue,
  type TerminalAttachment,
} from "./terminalAttachmentQueue";

const attachment = (
  ptyId: number,
  projectId = "project-a",
): TerminalAttachment => ({
  projectId,
  ptyId,
  sessionGeneration: ptyId + 100,
  cwd: `/repo/${projectId}`,
  title: `terminal ${ptyId}`,
  run: false,
  activate: false,
  killOnClose: true,
});

describe("TerminalAttachmentQueue", () => {
  it("holds recovery until a slow ProjectView mounts, then delivers exactly once", () => {
    const queue = new TerminalAttachmentQueue();
    const consume = vi.fn();

    queue.enqueue(attachment(7));
    expect(queue.pendingIdentities()).toEqual(["7:107"]);

    const unsubscribe = queue.subscribe("project-a", consume);
    expect(consume).toHaveBeenCalledOnce();
    expect(consume).toHaveBeenCalledWith(attachment(7));
    expect(queue.pendingIdentities()).toEqual(["7:107"]);

    queue.acknowledge("project-a", 7);
    expect(queue.pendingIdentities()).toEqual([]);

    unsubscribe();
    queue.subscribe("project-a", consume);
    expect(consume).toHaveBeenCalledOnce();
  });

  it("routes concurrent projects independently and coalesces snapshot/event duplicates", () => {
    const queue = new TerminalAttachmentQueue();
    const projectA = vi.fn();
    const projectB = vi.fn();
    queue.subscribe("project-a", projectA);

    queue.enqueue(attachment(1, "project-a"));
    queue.enqueue({ ...attachment(1, "project-a"), title: "event duplicate" });
    queue.enqueue(attachment(3, "project-a"));
    queue.enqueue(attachment(2, "project-b"));
    queue.enqueue({ ...attachment(2, "project-b"), title: "newer title" });

    // The live snapshot can overlap the already-installed event listener. A
    // mounted view must not receive both copies before its commit acknowledges
    // the first one, or batched React state can manufacture duplicate tabs.
    expect(projectA).toHaveBeenCalledTimes(2);
    expect(projectA.mock.calls.map(([value]) => value.ptyId)).toEqual([1, 3]);
    queue.acknowledge("project-a", 1);
    queue.acknowledge("project-a", 3);
    expect(queue.pendingIdentities()).toEqual(["2:102"]);
    queue.subscribe("project-b", projectB);
    expect(projectB).toHaveBeenCalledTimes(1);
    expect(projectB.mock.calls[0][0].title).toBe("newer title");
    queue.acknowledge("project-b", 2);
    expect(queue.pendingIdentities()).toEqual([]);
  });

  it("retains an attachment when the mounted consumer fails", () => {
    const queue = new TerminalAttachmentQueue();
    queue.subscribe("project-a", () => {
      throw new Error("mount is tearing down");
    });
    queue.enqueue(attachment(9));
    expect(queue.pendingIdentities()).toEqual(["9:109"]);
  });

  it("reoffers an uncommitted lifetime after its consumer unmounts", () => {
    const queue = new TerminalAttachmentQueue();
    const interrupted = vi.fn();
    const unsubscribe = queue.subscribe("project-a", interrupted);
    queue.enqueue(attachment(10));
    expect(interrupted).toHaveBeenCalledOnce();
    unsubscribe();

    const replacement = vi.fn();
    queue.subscribe("project-a", replacement);
    expect(replacement).toHaveBeenCalledOnce();
    expect(replacement).toHaveBeenCalledWith(attachment(10));
  });

  it("discards a PTY that exits before its project commits the tab", () => {
    const queue = new TerminalAttachmentQueue();
    queue.enqueue(attachment(11));
    queue.discard(11, 111);
    const consume = vi.fn();
    queue.subscribe("project-a", consume);
    expect(consume).not.toHaveBeenCalled();
    expect(queue.pendingIdentities()).toEqual([]);
  });

  it("keeps run presentation metadata through a delayed reattach", () => {
    const queue = new TerminalAttachmentQueue();
    const run = {
      ...attachment(12),
      run: true,
      command: "npm run dev",
      componentId: "web",
      runCommandId: "dev",
    };
    const consume = vi.fn();

    queue.enqueue(run);
    queue.subscribe("project-a", consume);

    expect(consume).toHaveBeenCalledWith(run);
  });
});

describe("projectForTerminalCwd", () => {
  it("chooses the deepest component and respects path boundaries", () => {
    const projects = [
      { id: "broad", components: [{ id: "c1", label: "broad", path: "/repo" }] },
      { id: "nested", components: [{ id: "c2", label: "nested", path: "/repo/app" }] },
    ];
    expect(projectForTerminalCwd(projects, "/repo/app/src")).toBe("nested");
    expect(projectForTerminalCwd(projects, "/repository")).toBeUndefined();
  });

  it("matches Windows drive paths case-insensitively", () => {
    const projects = [
      { id: "win", components: [{ id: "c1", label: "win", path: "C:\\Repo\\App" }] },
    ];
    expect(projectForTerminalCwd(projects, "c:\\repo\\app\\src")).toBe("win");
  });

  it("returns sibling and nested agent worktrees to their owning project", () => {
    const projects = [
      { id: "canopy", components: [{ id: "c1", label: "canopy", path: "/gh/canopy" }] },
    ];
    expect(projectForTerminalCwd(projects, "/gh/canopy-wt-recovery/src")).toBe("canopy");
    expect(
      projectForTerminalCwd(projects, "/gh/canopy/.claude/worktrees/agent-a/src"),
    ).toBe("canopy");
  });

  it("does not claim an unrelated sibling that only shares a prefix", () => {
    const projects = [
      { id: "banana", components: [{ id: "c1", label: "banana", path: "/gh/banana" }] },
    ];
    expect(projectForTerminalCwd(projects, "/gh/banana-android")).toBeUndefined();
  });
});

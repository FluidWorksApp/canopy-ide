import { describe, expect, it } from "vitest";
import { statusContextRoot, type SubTab } from "./helpers";

const roots = ["/work/api", "/work/web", "/work/web/packages/admin"];

describe("statusContextRoot", () => {
  it("follows the focused file to its most specific component", () => {
    const tab = {
      id: "file",
      type: "file",
      file: { path: "/work/web/packages/admin/src/app.ts" },
    } as SubTab;
    expect(statusContextRoot(tab, roots)).toBe("/work/web/packages/admin");
  });

  it("follows a terminal into its agent worktree", () => {
    const tab = {
      id: "agent",
      type: "terminal",
      cwd: "/work/api-wt-agent-codex/src",
    } as SubTab;
    expect(statusContextRoot(tab, roots)).toBe("/work/api-wt-agent-codex/src");
  });

  it("uses the containing directory for a file in an agent worktree", () => {
    const tab = {
      id: "worktree-file",
      type: "file",
      file: { path: "/work/api-wt-agent-codex/src/app.ts" },
    } as SubTab;
    expect(statusContextRoot(tab, roots)).toBe(
      "/work/api-wt-agent-codex/src",
    );
  });

  it("uses the tab's repository for git-native views", () => {
    const tab = { id: "pr", type: "pr", repo: "/work/web" } as SubTab;
    expect(statusContextRoot(tab, roots)).toBe("/work/web");
  });

  it("falls back to the first component for project-level views", () => {
    const tab = { id: "agents", type: "agents" } as SubTab;
    expect(statusContextRoot(tab, roots)).toBe("/work/api");
  });
});

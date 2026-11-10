import { beforeEach, describe, expect, it } from "vitest";
import { isAllWorkspaces, resetAllWorkspacesForTest, setAllWorkspaces } from "./allMode";

beforeEach(() => {
  localStorage.clear();
  resetAllWorkspacesForTest();
});

describe("All workspaces mode", () => {
  it("is off by default, persists when set, and marks the document", () => {
    expect(isAllWorkspaces()).toBe(false);
    setAllWorkspaces(true);
    expect(isAllWorkspaces()).toBe(true);
    expect(localStorage.getItem("canopy:view-all-workspaces:v1")).toBe("1");
    expect(document.documentElement.getAttribute("data-all-workspaces")).toBe("on");
    resetAllWorkspacesForTest();
    expect(isAllWorkspaces()).toBe(true);
  });
  it("turns off cleanly", () => {
    setAllWorkspaces(true);
    setAllWorkspaces(false);
    expect(isAllWorkspaces()).toBe(false);
    expect(document.documentElement.hasAttribute("data-all-workspaces")).toBe(false);
    expect(localStorage.getItem("canopy:view-all-workspaces:v1")).toBeNull();
  });
});

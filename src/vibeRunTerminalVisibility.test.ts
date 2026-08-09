import { describe, expect, it } from "vitest";
import {
  tabsPresentedByMode,
  type SubTab,
  type TermSubTab,
} from "./components/ProjectView/helpers";

const terminal = (id: string, run: boolean): TermSubTab => ({
  id,
  type: "terminal",
  cwd: "/repo",
  title: id,
  ptyId: Number(id.slice(1)),
  run,
});

describe("Build run-terminal visibility", () => {
  it("removes only run terminals from Build navigation and preserves their state", () => {
    const run = terminal("t1", true);
    const shell = terminal("t2", false);
    const preview: SubTab = {
      id: "preview",
      type: "preview",
      url: "http://localhost:3000",
      annotations: [],
    };
    const tabs: SubTab[] = [run, shell, preview];

    expect(tabsPresentedByMode(tabs, true)).toEqual([shell, preview]);
    expect(tabs).toEqual([run, shell, preview]);
    expect(tabsPresentedByMode(tabs, false)).toBe(tabs);
  });
});

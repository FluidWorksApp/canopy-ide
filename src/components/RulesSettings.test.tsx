import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { RuleSet } from "../gates/rules";
import { RulesSettings } from "./RulesSettings";

const rule = (id: string, text: string, over: Record<string, unknown> = {}) => ({
  id,
  kind: "rule",
  ts: 1,
  root: "/r",
  author: { kind: "human", name: "you" },
  scope: "project",
  data: { type: "rule", text, tag: "enforced", gate: { type: "deny-path-write", globs: ["migrations/"] }, approved: true, ...over },
});

describe("Settings → Rules", () => {
  it("lists every project's rules with a way into that project's Rules panel", async () => {
    const sets: Record<string, RuleSet> = {
      "/a": {
        rules: [rule("1", "Never touch migrations"), rule("2", "Prefer small PRs", { tag: "guidance", gate: null })] as never,
        blocks: [],
        trifecta: "block",
      },
      "/b": { rules: [], blocks: [], trifecta: "warn" },
    };
    const onOpen = vi.fn();
    render(
      <RulesSettings
        projects={[
          { id: "pa", name: "Shop", roots: ["/a"] },
          { id: "pb", name: "Docs", roots: ["/b"] },
        ]}
        onOpen={onOpen}
        load={async (cwd) => sets[cwd]}
      />,
    );
    const shop = (await screen.findByText("Shop")).closest("li")!;
    expect(await within(shop).findByText(/1 enforced · 1 guidance · web-content guard: block/)).toBeInTheDocument();
    expect(within(shop).getByText("Never touch migrations")).toBeInTheDocument();
    const docs = screen.getByText("Docs").closest("li")!;
    expect(await within(docs).findByText("No rules yet")).toBeInTheDocument();
    await userEvent.click(within(shop).getByRole("button", { name: "Open Rules panel" }));
    expect(onOpen).toHaveBeenCalledWith("pa", "/a");
    // Which CLIs enforce them, per CLI.
    expect(screen.getByText(/agent CLIs, on this computer and in cloud workspaces/)).toBeInTheDocument();
  });
});

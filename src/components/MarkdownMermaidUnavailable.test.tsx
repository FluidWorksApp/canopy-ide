// Its own file because the mock is the point: vi.mock is per-module-graph,
// and this is the one case where import("mermaid") itself must fail — a dev
// server started before the dependency existed, a broken chunk in a packaged
// build. That rejection used to be unhandled: the fence stayed raw source
// with no hint anything was ever going to happen to it, which reads as "no
// mermaid support" and files the bug against the wrong layer.
import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Markdown } from "./Markdown";

vi.mock("mermaid", () => {
  throw new Error("chunk load failed");
});

describe("mermaid import failure", () => {
  it("marks the fence unavailable instead of silently leaving it raw", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { container } = render(
      <Markdown text={"```mermaid\nflowchart TB\n  a --> b\n```"} />,
    );
    await waitFor(() =>
      expect(container.querySelector("pre.mermaid-unavailable")).toBeTruthy(),
    );
    // The source is still there and still readable — degraded, not destroyed.
    expect(container.querySelector("code.language-mermaid")?.textContent).toContain(
      "flowchart",
    );
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

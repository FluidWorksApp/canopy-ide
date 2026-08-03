// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { mockCommands } from "../test/setup";
import { AgentBrowserPip } from "./AgentBrowserPip";

describe("AgentBrowserPip", () => {
  it("streams the linked browser as a passive image and can be minimized", async () => {
    mockCommands({
      browser_snapshot: { image: "cG5n", width: 1200, height: 800 },
    });
    render(
      <AgentBrowserPip
        tabId="preview-1"
        url="http://localhost:5173/form"
        agentId="opencode"
        agentTitle="Fix the form"
        supported
        onClose={() => {}}
      />,
    );

    const image = await screen.findByAltText("Live read-only view of localhost:5173");
    expect(image).toHaveAttribute("src", "data:image/png;base64,cG5n");
    expect(image.parentElement).toHaveStyle({ aspectRatio: "1.5" });

    fireEvent.click(screen.getByLabelText("Minimize browser picture in picture"));
    expect(screen.queryByAltText("Live read-only view of localhost:5173")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Restore browser picture in picture")).toBeInTheDocument();
  });

  it("closes without navigating to the browser", () => {
    let closed = false;
    render(
      <AgentBrowserPip
        tabId="preview-1"
        url="http://localhost:5173/form"
        agentId="opencode"
        agentTitle="Fix the form"
        supported={false}
        onClose={() => { closed = true; }}
      />,
    );
    fireEvent.click(screen.getByLabelText("Close browser picture in picture"));
    expect(closed).toBe(true);
  });
});

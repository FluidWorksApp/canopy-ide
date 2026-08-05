import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getSettings } from "../settings";
import { currentPlatform, format } from "../shortcuts";
import { Onboarding } from "./Onboarding";

describe("Onboarding", () => {
  beforeEach(() => localStorage.clear());

  it("describes projects as collections of application components", async () => {
    render(<Onboarding onClose={vi.fn()} onCreateProject={vi.fn()} />);

    await userEvent.click(screen.getByRole("tab", { name: /slide 3: sessions and projects/i }));

    expect(screen.getByText(/every frontend, backend, worker, and other component/i)).toBeInTheDocument();
  });

  it("persists the interactive onboarding choices", async () => {
    const user = userEvent.setup();
    render(<Onboarding onClose={vi.fn()} onCreateProject={vi.fn()} />);

    await user.selectOptions(screen.getByRole("combobox", { name: "Keyboard shortcut profile" }), "vscode");

    await user.click(screen.getByRole("tab", { name: /slide 2: agents are the hero/i }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Default agent" }), "codex");

    await user.click(screen.getByRole("tab", { name: /slide 5: dictate, don't type/i }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Dictation trigger" }), "doubleTap");

    await user.click(screen.getByRole("tab", { name: /slide 7: one search for everything/i }));
    await user.click(screen.getByRole("checkbox", { name: /search across every project/i }));

    await user.click(screen.getByRole("tab", { name: /slide 8: research and scratchpad/i }));
    await user.click(screen.getByRole("checkbox", { name: /automatically import project research/i }));

    expect(getSettings()).toMatchObject({
      keymapProfile: "vscode",
      defaultAgent: "codex",
      dictationTriggerMode: "doubleTap",
      spotSearchAllProjects: true,
      autoImportMarkdownResearch: false,
    });
  });

  it("previews the selected shortcut profile for the current platform", async () => {
    const user = userEvent.setup();
    render(<Onboarding onClose={vi.fn()} onCreateProject={vi.fn()} />);

    expect(screen.getByText(format("quick-open", currentPlatform(), "canopy"))).toBeInTheDocument();

    await user.selectOptions(screen.getByRole("combobox", { name: "Keyboard shortcut profile" }), "jetbrains");

    expect(screen.getByText(format("quick-open", currentPlatform(), "jetbrains"))).toBeInTheDocument();
    const platform = currentPlatform() === "macos" ? "macOS" : currentPlatform() === "windows" ? "Windows" : "Linux";
    expect(screen.getByText(`shortcuts shown for ${platform}`)).toHaveAttribute("data-shortcut-platform");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getSettings } from "../settings";
import { mockCommands } from "../test/setup";
import { currentPlatform, format } from "../shortcuts";
import { Onboarding } from "./Onboarding";

describe("Onboarding", () => {
  it("opens on connecting the brain", async () => {
    render(<Onboarding onClose={vi.fn()} onCreateProject={vi.fn()} />);
    expect(screen.getByText("Connect your brain")).toBeInTheDocument();
    // Nothing installed in this test: the step offers an install, not a dead end.
    expect((await screen.findAllByRole("button", { name: /^Install / })).length).toBeGreaterThan(0);
  });

  beforeEach(() => {
    localStorage.clear();
    // The first slide checks which agent CLIs are installed; none here.
    mockCommands({ which_check: () => ({}) });
  });

  it("describes projects as collections of application components", async () => {
    render(<Onboarding onClose={vi.fn()} onCreateProject={vi.fn()} />);

    await userEvent.click(screen.getByRole("tab", { name: /slide 3: sessions and projects/i }));

    expect(screen.getByText(/every frontend, backend, worker, and other component/i)).toBeInTheDocument();
  });

  it("persists the interactive onboarding choices", async () => {
    const user = userEvent.setup();
    render(<Onboarding onClose={vi.fn()} onCreateProject={vi.fn()} />);

    await user.click(screen.getByRole("tab", { name: /slide 2: keep your muscle memory/i }));
    await user.click(screen.getByRole("radio", { name: /i build with ai/i }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Keyboard shortcut profile" }), "vscode");

    await user.click(screen.getByRole("tab", { name: /slide 5: dictate, don't type/i }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Dictation trigger" }), "doubleTap");

    await user.click(screen.getByRole("tab", { name: /slide 7: one search for everything/i }));
    await user.click(screen.getByRole("checkbox", { name: /search across every project/i }));

    await user.click(screen.getByRole("tab", { name: /slide 8: research and scratchpad/i }));
    await user.click(screen.getByRole("checkbox", { name: /automatically import project research/i }));

    expect(getSettings()).toMatchObject({
      keymapProfile: "vscode",
      defaultProjectLens: "build",
      dictationTriggerMode: "doubleTap",
      spotSearchAllProjects: true,
      autoImportMarkdownResearch: false,
    });
  });

  it("asks for a persona and maps it to the default project lens", async () => {
    const user = userEvent.setup();
    render(<Onboarding onClose={vi.fn()} onCreateProject={vi.fn()} />);
    await user.click(screen.getByRole("tab", { name: /slide 2: keep your muscle memory/i }));

    expect(screen.getByRole("radio", { name: /i'm an engineer/i })).toHaveAttribute("aria-checked", "true");
    await user.click(screen.getByRole("radio", { name: /i build with ai/i }));

    expect(getSettings().defaultProjectLens).toBe("build");
    expect(screen.getByRole("radio", { name: /i build with ai/i })).toHaveAttribute("aria-checked", "true");
  });

  it("previews the selected shortcut profile for the current platform", async () => {
    const user = userEvent.setup();
    render(<Onboarding onClose={vi.fn()} onCreateProject={vi.fn()} />);
    await user.click(screen.getByRole("tab", { name: /slide 2: keep your muscle memory/i }));

    expect(screen.getByText(format("quick-open", currentPlatform(), "canopy"))).toBeInTheDocument();

    await user.selectOptions(screen.getByRole("combobox", { name: "Keyboard shortcut profile" }), "jetbrains");

    expect(screen.getByText(format("quick-open", currentPlatform(), "jetbrains"))).toBeInTheDocument();
    const platform = currentPlatform() === "macos" ? "macOS" : currentPlatform() === "windows" ? "Windows" : "Linux";
    expect(screen.getByText(`shortcuts shown for ${platform}`)).toHaveAttribute("data-shortcut-platform");
  });
});

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Project } from "../projects";
import { ProjectDialog } from "./ProjectDialog";
import { updateSettings } from "../settings";
import { getProjectPreference } from "../placement/preferences";
import { automaticPreference, inheritPreference } from "../placement/types";

vi.mock("../placement/gather", () => ({
  gatherUnified: vi.fn(() => new Promise(() => {})),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(async () => "/repo/new-app"),
}));

const existing = (configured = true): Project => ({
  id: "p1",
  name: "App",
  components: [
    {
      id: "cmp-web",
      label: "Web",
      path: "/repo/web",
      commands: [{ id: "run-dev", name: "Dev", command: "npm run dev" }],
    },
  ],
  vibe: {
    version: 1,
    enabled: true,
    componentId: configured ? "cmp-web" : undefined,
    runCommandId: configured ? "run-dev" : undefined,
  },
});

describe("ProjectDialog project structure identity", () => {
  it("persists Automatic separately from Use default when saved", () => {
    localStorage.clear();
    render(<ProjectDialog existing={existing()} onSave={vi.fn()} onCancel={() => {}} />);
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(
      expect.arrayContaining(["Use default", "Automatic", "This Mac"]),
    );
    fireEvent.change(screen.getByLabelText("Run agents on"), { target: { value: "automatic" } });
    expect(getProjectPreference("p1")).toEqual(inheritPreference());
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(getProjectPreference("p1")).toEqual(automaticPreference());
  });

  it("stamps the onboarding default lens onto a new project", async () => {
    localStorage.clear();
    updateSettings({ defaultProjectLens: "build" });
    const onSave = vi.fn();
    render(<ProjectDialog onSave={onSave} onCancel={() => {}} />);

    fireEvent.change(screen.getByLabelText("Project name"), {
      target: { value: "New app" },
    });
    fireEvent.click(screen.getByRole("button", { name: /add directory/i }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Create & open" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Create & open" }));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        vibe: { version: 1, enabled: true },
      }),
    );
  });
  it("preserves component, command, and vibe references across renames", () => {
    const onSave = vi.fn();
    render(
      <ProjectDialog existing={existing()} onSave={onSave} onCancel={() => {}} />,
    );

    fireEvent.change(screen.getByTitle("Display name for this directory"), {
      target: { value: "Frontend" },
    });
    fireEvent.change(screen.getByPlaceholderText("name — e.g. web"), {
      target: { value: "Preview" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        components: [
          expect.objectContaining({
            id: "cmp-web",
            label: "Frontend",
            commands: [expect.objectContaining({ id: "run-dev", name: "Preview" })],
          }),
        ],
        vibe: expect.objectContaining({
          componentId: "cmp-web",
          runCommandId: "run-dev",
        }),
      }),
    );
  });

  it("configures an explicit Build target and gives new commands an ID", () => {
    const onSave = vi.fn();
    render(
      <ProjectDialog existing={existing(false)} onSave={onSave} onCancel={() => {}} />,
    );

    fireEvent.change(screen.getByLabelText("Component"), {
      target: { value: "cmp-web" },
    });
    fireEvent.change(screen.getByLabelText("Run command"), {
      target: { value: "run-dev" },
    });
    fireEvent.click(screen.getByRole("button", { name: "＋ Add command" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    const saved = onSave.mock.calls[0][0] as Project;
    expect(saved.vibe).toMatchObject({
      componentId: "cmp-web",
      runCommandId: "run-dev",
    });
    expect(saved.components[0].commands?.[1].id).toMatch(/^run_/);
  });
});

describe("ProjectDialog icon", () => {
  it("saves the chosen tab icon with the project, and keeps auto as no field", async () => {
    localStorage.clear();
    const onSave = vi.fn();
    const { unmount } = render(<ProjectDialog existing={existing()} onSave={onSave} onCancel={() => {}} />);
    fireEvent.click(screen.getByRole("radio", { name: "🌲" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0].icon).toEqual({ kind: "emoji", emoji: "🌲" });
    unmount();

    const onSaveAgain = vi.fn();
    render(
      <ProjectDialog
        existing={{ ...existing(), icon: { kind: "none" } }}
        onSave={onSaveAgain}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByRole("radio", { name: "None" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("radio", { name: "Auto" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSaveAgain).toHaveBeenCalled());
    expect(JSON.parse(JSON.stringify(onSaveAgain.mock.calls[0][0]))).not.toHaveProperty("icon");
  });

  it("does not offer an icon for a project that doesn't exist yet", () => {
    render(<ProjectDialog onSave={vi.fn()} onCancel={() => {}} />);
    expect(screen.queryByRole("radiogroup", { name: "Project icon" })).toBeNull();
  });

  it("shows a detected command plainly and saves it untouched unless edited", () => {
    const quoted = (): Project => {
      const p = existing();
      p.components[0].commands = [
        { id: "run-dev", name: "Dev", command: '"npm" "run" "dev"' },
        { id: "run-odd", name: "Odd", command: '"npm" "run" "my script"' },
      ];
      return p;
    };
    const onSave = vi.fn();
    const view = render(<ProjectDialog existing={quoted()} onSave={onSave} onCancel={() => {}} />);
    const fields = screen.getAllByLabelText("Command") as HTMLInputElement[];
    expect(fields.map((f) => f.value)).toEqual(["npm run dev", '"npm" "run" "my script"']);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave.mock.calls[0][0].components[0].commands.map((c: { command: string }) => c.command)).toEqual([
      '"npm" "run" "dev"',
      '"npm" "run" "my script"',
    ]);
    view.unmount();

    render(<ProjectDialog existing={quoted()} onSave={onSave} onCancel={() => {}} />);
    fireEvent.change(screen.getAllByLabelText("Command")[0], { target: { value: "npm run dev -- --host" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave.mock.calls[1][0].components[0].commands[0].command).toBe("npm run dev -- --host");
  });
});

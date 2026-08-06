import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Project } from "../projects";
import { ProjectDialog } from "./ProjectDialog";

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

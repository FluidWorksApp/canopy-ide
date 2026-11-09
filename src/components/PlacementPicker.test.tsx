import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { automaticPreference, inheritPreference, targetPreference, type DisplayTarget } from "../placement/types";
import { PlacementPicker } from "./PlacementPicker";

const targets: DisplayTarget[] = [
  { target: { kind: "local" }, name: "This Mac", online: true },
  { target: { kind: "remote", workspaceId: "workspace-1" }, name: "Design Studio", online: true },
  { target: { kind: "t3", machineId: "machine-1" }, name: "Build Mini", online: true },
];

describe("PlacementPicker", () => {
  it("offers Automatic, This Mac, and concrete machine names globally", () => {
    const onChange = vi.fn();
    render(<PlacementPicker value={automaticPreference()} onChange={onChange} targets={targets} />);
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Automatic", "This Mac", "Design Studio", "Build Mini",
    ]);
    fireEvent.change(screen.getByLabelText("Run on"), { target: { value: "remote:workspace-1" } });
    expect(onChange).toHaveBeenCalledWith(targetPreference({ kind: "remote", workspaceId: "workspace-1" }));
  });

  it("offers Use default separately from Automatic for an override", () => {
    const onChange = vi.fn();
    render(<PlacementPicker value={inheritPreference()} onChange={onChange} targets={targets} allowInherit />);
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Use default", "Automatic", "This Mac", "Design Studio", "Build Mini",
    ]);
    fireEvent.change(screen.getByLabelText("Run on"), { target: { value: "automatic" } });
    expect(onChange).toHaveBeenCalledWith(automaticPreference());
  });

  it("keeps same-named concrete machines distinct by target kind and ID", () => {
    const onChange = vi.fn();
    const sameNames: DisplayTarget[] = [
      ...targets.slice(0, 1),
      { target: { kind: "remote", workspaceId: "same" }, name: "Studio", online: true },
      { target: { kind: "t3", machineId: "same" }, name: "Studio", online: true },
    ];
    render(<PlacementPicker value={automaticPreference()} onChange={onChange} targets={sameNames} />);
    fireEvent.change(screen.getByLabelText("Run on"), { target: { value: "t3:same" } });
    expect(onChange).toHaveBeenCalledWith(targetPreference({ kind: "t3", machineId: "same" }));
  });

  it("shows the decision, machine name, reason, and setup warning", () => {
    render(
      <PlacementPicker
        value={automaticPreference()}
        onChange={() => {}}
        targets={targets}
        decision={{
          target: { kind: "remote", workspaceId: "workspace-1" },
          targetName: "Design Studio",
          reason: "Least loaded.",
          alternatives: [],
          needsSetup: true,
        }}
      />,
    );
    expect(screen.getByRole("status").textContent).toBe(
      "Would run on Design Studio. Least loaded. The project needs setting up there first.",
    );
  });
});

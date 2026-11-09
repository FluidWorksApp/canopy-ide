import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PlacementPicker } from "./PlacementPicker";

describe("PlacementPicker", () => {
  it("offers local, remote, balance and auto and reports the choice", () => {
    const onChange = vi.fn();
    render(<PlacementPicker value="auto" onChange={onChange} />);
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Auto", "Local", "Remote", "Balance"]);
    fireEvent.change(screen.getByLabelText("Run on"), { target: { value: "balance" } });
    expect(onChange).toHaveBeenCalledWith("balance");
  });

  it("shows the decision, its reason and a setup warning", () => {
    render(
      <PlacementPicker
        value="auto"
        onChange={() => {}}
        names={{ w1: "Cloud" }}
        decision={{ target: { kind: "remote", workspaceId: "w1" }, reason: "Least loaded.", alternatives: [], needsSetup: true }}
      />,
    );
    expect(screen.getByRole("status").textContent).toBe("Would run on Cloud. Least loaded. The project needs setting up there first.");
  });
});

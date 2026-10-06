// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { FleetKind, FleetReason } from "../fleetState";
import type { FleetRouteSnapshot } from "../fleetSnapshot";
import { FleetReadinessPanel } from "./FleetReadinessPanel";

afterEach(cleanup);

function route(
  id: string,
  name: string,
  kind: FleetKind,
  reasons: FleetReason[] = [],
  profile = "default",
): FleetRouteSnapshot {
  return {
    cli: { id, name, bin: id },
    profile,
    state: { agent: id, profile, kind, reasons },
    plan: null,
  };
}

const rows = [
  route("claude", "Claude Code", "ready"),
  route("amp", "Amp", "degraded", ["auth-unknown"]),
];

function Harness({
  value = rows,
  profiles = [{ id: "default", label: "Default" }],
  loading = false,
  error = null,
}: {
  value?: FleetRouteSnapshot[];
  profiles?: { id: string; label: string }[];
  loading?: boolean;
  error?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <FleetReadinessPanel
      rows={value}
      profiles={profiles}
      loading={loading}
      error={error}
      open={open}
      trigger={trigger}
      onOpenChange={setOpen}
    />
  );
}

describe("FleetReadinessPanel", () => {
  it("folds the route ledger into an honest worst-state summary", () => {
    render(
      <Harness
        value={[...rows, route("aider", "Aider", "unusable", ["not-installed"])]}
        profiles={[]}
      />,
    );

    const trigger = screen.getByRole("button", { name: /1 of 3 routes ready/i });
    expect(trigger.querySelector(".fleet-disclosure-status")?.textContent).toContain(
      "unusable",
    );
  });

  it("keeps details folded and shows the fleet state on the trigger's right", () => {
    render(
      <Harness />,
    );

    const trigger = screen.getByRole("button", { name: /1 of 2 routes ready/i });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.querySelector(".fleet-disclosure-status")?.textContent).toContain(
      "degraded",
    );
    expect(screen.queryByRole("region", { name: /fleet route states/i })).toBeNull();
    expect(screen.queryByText("sign-in state unknown")).toBeNull();
  });

  it("opens every route, profile, state, and reason without lengthening the page", () => {
    render(
      <Harness />,
    );

    fireEvent.click(screen.getByRole("button", { name: /1 of 2 routes ready/i }));

    const panel = screen.getByRole("region", { name: /fleet route states/i });
    expect(within(panel).getByText("Claude Code")).toBeTruthy();
    expect(within(panel).getByText("Amp")).toBeTruthy();
    expect(within(panel).getAllByText("Default")).toHaveLength(2);
    expect(within(panel).getByText("all checks ready")).toBeTruthy();
    expect(within(panel).getByText("sign-in state unknown")).toBeTruthy();
    expect(within(panel).getByText("ready")).toBeTruthy();
    expect(within(panel).getByText("degraded")).toBeTruthy();
  });

  it("closes when the person clicks outside the floating panel", () => {
    render(
      <Harness profiles={[]} />,
    );
    const trigger = screen.getByRole("button", { name: /1 of 2 routes ready/i });
    fireEvent.click(trigger);

    fireEvent.mouseDown(document.body);

    expect(screen.queryByRole("region", { name: /fleet route states/i })).toBeNull();
  });
});

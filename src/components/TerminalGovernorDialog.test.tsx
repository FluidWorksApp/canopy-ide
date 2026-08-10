// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TerminalGovernorCard } from "./TerminalGovernorDialog";

const status = {
  id: 7,
  budget_generation: 3,
  state: "over_allowance" as const,
  base_allowance_bytes: 1024,
  granted_bytes: 0,
  remembered_default_bytes: 0,
  allowance_bytes: 1024,
  max_allowance_bytes: null,
  current_bytes: 1200,
  peak_bytes: 1250,
  ema_bytes: 900,
  growth_bytes_per_second: 12,
  samples: 4,
  grant_request: {
    request_id: "grant-7",
    budget_generation: 3,
    increments: [512 * 1024 * 1024, 1024 * 1024 * 1024],
  },
  stop_request_id: "pty-7-stop-3",
  cli_key: "pkg:npm:@example/agent",
};

const quota = {
  members: [status],
  state: "over_allowance" as const,
  current_bytes: status.current_bytes,
  allowance_bytes: status.allowance_bytes,
  peak_bytes: status.peak_bytes,
};

const member = (session?: { name: string; agent: boolean }) => [
  { status, session },
];

const capability = {
  platform: "macos",
  enforcement: "monitor_only" as const,
  measurement: "physical_footprint_sum",
  hard_limit: false,
  pause: false,
  soft_limit: false,
  dynamic_raise: false,
  mechanism: "none",
  detail: "no proven platform containment backend is active",
};

describe("TerminalGovernorCard", () => {
  it("requires an explicit grant and states monitor-only truthfully", () => {
    const onGrant = vi.fn();
    render(
      <TerminalGovernorCard
        status={status}
        quota={quota}
        members={member({ name: "Piper", agent: true })}
        capability={capability}
        headroomBytes={8 * 1024 * 1024 * 1024}
        onGrant={onGrant}
        onMaximumChange={() => {}}
        onStop={() => {}}
        onDismiss={() => {}}
      />,
    );
    expect(screen.getByText(/currently monitor-only/i)).toBeTruthy();
    expect(screen.getByText(/Piper is using/i)).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("region", { name: /Piper is using/i })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Allow \+512/ }));
    expect(onGrant).toHaveBeenCalledWith(512 * 1024 * 1024, false);
  });

  it("never offers an Allow the host has no reserve for", () => {
    // The governor refuses an increment above the grantable headroom. Offering
    // it anyway left the card with three buttons, none of which could grant,
    // and a red notice that read like a bug rather than a decision.
    const onGrant = vi.fn();
    render(
      <TerminalGovernorCard
        status={status}
        quota={quota}
        members={member()}
        capability={capability}
        headroomBytes={128 * 1024 * 1024}
        onGrant={onGrant}
        onMaximumChange={() => {}}
        onStop={() => {}}
        onDismiss={() => {}}
      />,
    );
    const allow = screen.getByRole("button", { name: /Allow \+512/ });
    expect(allow.hasAttribute("disabled")).toBe(true);
    fireEvent.click(allow);
    expect(onGrant).not.toHaveBeenCalled();
    expect(screen.getByText(/protected reserve leaves no room/i)).toBeTruthy();
    // The ways out stay live.
    expect(
      screen.getByRole("button", { name: /Stop terminal/i }).hasAttribute("disabled"),
    ).toBe(false);
  });

  it("never offers an Allow that would breach the agent's own maximum", () => {
    const onGrant = vi.fn();
    render(
      <TerminalGovernorCard
        status={{ ...status, max_allowance_bytes: 1024 + 256 * 1024 * 1024 }}
        quota={quota}
        members={member()}
        capability={capability}
        headroomBytes={8 * 1024 * 1024 * 1024}
        onGrant={onGrant}
        onMaximumChange={() => {}}
        onStop={() => {}}
        onDismiss={() => {}}
      />,
    );
    expect(
      screen.getByRole("button", { name: /Allow \+512/ }).hasAttribute("disabled"),
    ).toBe(true);
    expect(screen.getByText(/raise it first/i)).toBeTruthy();
  });

  it("requires a separate checkbox confirmation before remembering a CLI default", () => {
    const onGrant = vi.fn();
    render(
      <TerminalGovernorCard
        status={status}
        quota={quota}
        members={member()}
        capability={capability}
        headroomBytes={8 * 1024 * 1024 * 1024}
        onGrant={onGrant}
        onMaximumChange={() => {}}
        onStop={() => {}}
        onDismiss={() => {}}
      />,
    );
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /remember this increment for this CLI/i,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: /Allow \+512/ }));
    expect(onGrant).toHaveBeenCalledWith(512 * 1024 * 1024, true);
  });

  it("keeps the numbered fallback for a plain shell", () => {
    render(
      <TerminalGovernorCard
        status={status}
        quota={quota}
        members={member({ name: "Moss", agent: false })}
        capability={capability}
        headroomBytes={8 * 1024 * 1024 * 1024}
        onGrant={() => {}}
        onMaximumChange={() => {}}
        onStop={() => {}}
        onDismiss={() => {}}
      />,
    );
    expect(screen.getByText(/Terminal 7 is using/i)).toBeTruthy();
    expect(screen.queryByText(/Moss is using/i)).toBeNull();
  });

  it("offers an explicit terminal stop without calling it a throttle", () => {
    const onStop = vi.fn();
    render(
      <TerminalGovernorCard
        status={{ ...status, state: "over_allowance" }}
        quota={{ ...quota, state: "over_allowance" }}
        members={member()}
        capability={capability}
        headroomBytes={8 * 1024 * 1024 * 1024}
        onGrant={() => {}}
        onMaximumChange={() => {}}
        onStop={onStop}
        onDismiss={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Stop terminal" }));
    expect(onStop).toHaveBeenCalledOnce();
  });

  it("distinguishes a verified soft boundary from a hard memory limit", () => {
    render(
      <TerminalGovernorCard
        status={status}
        quota={quota}
        members={member()}
        capability={{
          ...capability,
          enforcement: "soft_limit",
          soft_limit: true,
          dynamic_raise: true,
          mechanism: "cgroup_v2_memory_high",
        }}
        headroomBytes={8 * 1024 * 1024 * 1024}
        onGrant={() => {}}
        onMaximumChange={() => {}}
        onStop={() => {}}
        onDismiss={() => {}}
      />,
    );
    expect(screen.getByText(/soft boundary applies reclaim and throttling/i)).toBeTruthy();
    expect(screen.getByText(/without a cgroup OOM kill/i)).toBeTruthy();
  });

  it("keeps the peak reading, maximum, and remember confirmation in separate rows", () => {
    const onMaximumChange = vi.fn();
    render(
      <TerminalGovernorCard
        status={{
          ...status,
          allowance_bytes: 2 * 1024 ** 3,
          max_allowance_bytes: 4 * 1024 ** 3,
        }}
        quota={quota}
        members={member({ name: "Piper", agent: true })}
        capability={capability}
        headroomBytes={8 * 1024 * 1024 * 1024}
        onGrant={() => {}}
        onMaximumChange={onMaximumChange}
        onStop={() => {}}
        onDismiss={() => {}}
      />,
    );
    const checkbox = screen.getByRole("checkbox", {
      name: /remember this increment/i,
    });
    expect(checkbox.closest(".terminal-governor-remember")).toBeTruthy();
    expect(checkbox.closest(".terminal-governor-meta")).toBeNull();
    expect(screen.getByText(/current allowance:/i)).toHaveTextContent("2.0 GB");
    expect(screen.getByText(/grant ceiling:/i)).toHaveTextContent("4.0 GB");
    expect(screen.getByText(/this is not the current allowance/i)).toBeTruthy();
    fireEvent.change(
      screen.getByRole("combobox", { name: /grant ceiling for piper/i }),
      { target: { value: 2 * 1024 ** 3 } },
    );
    expect(onMaximumChange).toHaveBeenCalledWith(2 * 1024 ** 3);
    const card = screen.getByRole("region");
    expect(
      screen.getByRole("button", { name: "Stop terminal" }).closest("[role=region]"),
    ).toBe(card);
  });

  it("shows a summed multiplex allowance with per-agent rows and a per-agent grant", () => {
    const second = {
      ...status,
      id: 8,
      current_bytes: 850,
      peak_bytes: 900,
      allowance_bytes: 1024,
      grant_request: null,
      stop_request_id: "stop-8",
    };
    const onGrant = vi.fn();
    render(
      <TerminalGovernorCard
        status={status}
        quota={{
          members: [status, second],
          state: "over_allowance",
          current_bytes: status.current_bytes + second.current_bytes,
          allowance_bytes: status.allowance_bytes + second.allowance_bytes,
          peak_bytes: status.peak_bytes + second.peak_bytes,
        }}
        members={[
          { status, session: { name: "Piper", agent: true } },
          { status: second, session: { name: "Quill", agent: true } },
        ]}
        capability={capability}
        headroomBytes={8 * 1024 * 1024 * 1024}
        onGrant={onGrant}
        onMaximumChange={() => {}}
        onStop={() => {}}
        onDismiss={() => {}}
      />,
    );
    expect(screen.getByText(/combined allowance is 2 KB across 2 agents/i)).toBeTruthy();
    expect(screen.getByLabelText("Per-agent memory allowances")).toHaveTextContent(
      "Piper",
    );
    expect(screen.getByLabelText("Per-agent memory allowances")).toHaveTextContent(
      "Quill",
    );
    expect(screen.queryByText(/one-agent allowance/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Allow Piper \+512/ }));
    expect(onGrant).toHaveBeenCalledWith(512 * 1024 * 1024, false);
  });
});

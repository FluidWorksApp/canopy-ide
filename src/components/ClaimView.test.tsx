// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ClaimView } from "./ClaimView";
import type * as ipcTypes from "../ipc";

const history: ipcTypes.AgentClaim[] = [];

vi.mock("../ipc", () => ({
  contextClaimHistory: () => Promise.resolve(history),
  onAgentClaims: () => Promise.resolve(() => {}),
  contextReleaseClaim: () => Promise.resolve(),
}));

const claim = (over: Partial<ipcTypes.AgentClaim> = {}): ipcTypes.AgentClaim => ({
  id: "c1",
  paths: ["/repo/src/auth.ts"],
  owner: "canopy (/repo)",
  note: "Rewriting the login redirect",
  at_ms: Date.parse("2026-08-01T10:00:00Z"),
  released_at_ms: null,
  released_by: null,
  refusals: [],
  ...over,
});

const view = (over: Partial<React.ComponentProps<typeof ClaimView>> = {}) => {
  const c = over.fallback ?? claim();
  return render(
    <ClaimView claimId={c.id} fallback={c} active {...over} />,
  );
};

describe("a claim's detail page", () => {
  it("says who took it, why, and that it is still held", async () => {
    history.length = 0;
    history.push(claim());
    view();
    expect(screen.getByText("canopy")).toBeTruthy();
    expect(screen.getAllByText("Rewriting the login redirect").length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.getByText("held")).toBeTruthy());
  });

  it("says when a released claim ended, which the list could never show", async () => {
    history.length = 0;
    const released = claim({
      released_at_ms: Date.parse("2026-08-01T11:30:00Z"),
      released_by: "agent",
    });
    history.push(released);
    view({ fallback: released });
    await waitFor(() => expect(screen.getByText("released")).toBeTruthy());
    expect(screen.getByText("The agent released it")).toBeTruthy();
    // How long it was held is the other half of "when was it released".
    expect(screen.getByText("held for 1h 30m")).toBeTruthy();
  });

  it("shows every agent the claim turned away", async () => {
    history.length = 0;
    const contested = claim({
      refusals: [
        {
          owner: "canopy-wt-auth (/repo-wt-auth)",
          paths: ["/repo/src/auth.ts"],
          note: "Same file, different job",
          at_ms: Date.parse("2026-08-01T10:20:00Z"),
        },
      ],
    });
    history.push(contested);
    view({ fallback: contested });
    await waitFor(() =>
      expect(screen.getByText("canopy-wt-auth was turned away")).toBeTruthy(),
    );
  });

  it("opens a claimed file rather than leaving the path dead", async () => {
    history.length = 0;
    const onOpenFile = vi.fn();
    view({ onOpenFile });
    await userEvent.click(screen.getByTitle("Open /repo/src/auth.ts"));
    expect(onOpenFile).toHaveBeenCalledWith("/repo/src/auth.ts");
  });

  it("admits when Canopy no longer has the claim, instead of showing it as live", async () => {
    history.length = 0;
    view();
    await waitFor(() => expect(screen.getByText(/no longer has a record/)).toBeTruthy());
    // Nothing to release: the claim we are drawing is a hibernated copy.
    expect(screen.queryByText("Release")).toBeNull();
  });
});

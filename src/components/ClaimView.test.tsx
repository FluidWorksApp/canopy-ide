// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ClaimView } from "./ClaimView";
import type * as ipcTypes from "../ipc";

const history: ipcTypes.AgentClaim[] = [];

// Mutable seams so single tests can delay the listener handshake or fail the
// release without their own module mock.
const seams = vi.hoisted(() => ({
  onAgentClaims: undefined as (() => Promise<() => void>) | undefined,
  releaseClaim: undefined as ((ownerKey: string) => Promise<void>) | undefined,
}));

vi.mock("../ipc", () => ({
  contextClaimHistory: () => Promise.resolve(history),
  onAgentClaims: () => seams.onAgentClaims?.() ?? Promise.resolve(() => {}),
  contextReleaseClaim: (ownerKey: string) =>
    seams.releaseClaim?.(ownerKey) ?? Promise.resolve(),
}));

const claim = (over: Partial<ipcTypes.AgentClaim> = {}): ipcTypes.AgentClaim => ({
  id: "c1",
  paths: ["/repo/src/auth.ts"],
  owner: "canopy (/repo)",
  owner_key: "pty:7@inst-1",
  pty_id: 7,
  instance: "inst-1",
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

beforeEach(() => {
  seams.onAgentClaims = undefined;
  seams.releaseClaim = undefined;
});

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

  it("opens the files a refused agent wanted, like the file list above", async () => {
    // The refusal used to be inert text — a contested path is the one thing on
    // this page you'd most want to go and look at.
    history.length = 0;
    const contested = claim({
      refusals: [
        {
          owner: "canopy-wt-auth (/repo-wt-auth)",
          paths: ["/repo/src/session.ts"],
          note: null,
          at_ms: Date.parse("2026-08-01T10:20:00Z"),
        },
      ],
    });
    history.push(contested);
    const onOpenFile = vi.fn();
    view({ fallback: contested, onOpenFile });
    await userEvent.click(await screen.findByTitle("Open /repo/src/session.ts"));
    expect(onOpenFile).toHaveBeenCalledWith("/repo/src/session.ts");
  });
});

describe("releasing a claim", () => {
  it("names the holder by owner_key, not the drifting owner string", async () => {
    history.length = 0;
    history.push(claim());
    const release = vi.fn(() => Promise.resolve());
    seams.releaseClaim = release;
    view();
    await userEvent.click(await screen.findByText("Release"));
    expect(release).toHaveBeenCalledWith("pty:7@inst-1");
  });

  it("says so when the release fails, instead of silently doing nothing", async () => {
    history.length = 0;
    history.push(claim());
    seams.releaseClaim = () => Promise.reject(new Error("no such claim"));
    const onNotice = vi.fn();
    view({ onNotice });
    await userEvent.click(await screen.findByText("Release"));
    await waitFor(() =>
      expect(onNotice).toHaveBeenCalledWith(
        expect.stringContaining("no such claim"),
      ),
    );
  });
});

describe("the claims listener", () => {
  it("unsubscribes even when listen() resolves after the tab flipped away", async () => {
    // The race: cleanup ran while the unlisten fn was still in flight, so
    // `un` was undefined and the listener leaked for the rest of the run.
    history.length = 0;
    const un = vi.fn();
    let hand!: (u: () => void) => void;
    seams.onAgentClaims = () => new Promise((res) => (hand = res));
    const { unmount } = view();
    unmount();
    hand(un);
    await waitFor(() => expect(un).toHaveBeenCalled());
  });
});

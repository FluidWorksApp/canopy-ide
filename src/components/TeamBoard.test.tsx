// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import type * as ipcTypes from "../ipc";

const now = Math.floor(Date.now() / 1000);

const seams = vi.hoisted(() => ({
  digests: [] as unknown[],
  stats: [] as unknown[],
  claims: [] as unknown[],
  entries: [] as unknown[],
}));

vi.mock("../ipc", () => ({
  instanceId: () => Promise.resolve("inst-1"),
  sessionDigests: () => Promise.resolve(seams.digests),
  contextClaims: () => Promise.resolve(seams.claims),
  onAgentClaims: () => Promise.resolve(() => {}),
  contextMessages: () => Promise.resolve([]),
  onAgentMessage: () => Promise.resolve(() => {}),
  onStoreChange: () => Promise.resolve(() => {}),
  ptyStats: () => Promise.resolve(seams.stats),
  onPtyStats: () => Promise.resolve(() => {}),
}));

vi.mock("../ledger", () => ({
  ledgerRoot: (p: string) => Promise.resolve(p.startsWith("/w/shop") ? "/w/shop" : p),
  queryLedger: () => Promise.resolve(seams.entries),
  subscribeLedger: () => () => {},
}));

vi.mock("../awareness/engine", () => ({
  awarenessStatus: () => ({ state: "on" }),
  subscribeAwarenessStatus: () => () => {},
  hotspotsForRepo: () =>
    Promise.resolve({
      overridden: false,
      list: [{ path: "src/routes.ts", reasons: ["a route table"], score: 4 }],
    }),
}));

import { TeamBoard } from "./TeamBoard";
import { statusLine } from "../awareness/statusLine";

const session = (over: Partial<ipcTypes.SessionStats>): ipcTypes.SessionStats => ({
  id: 7,
  title: "agent",
  cwd: "/w/shop",
  total_cpu: 0,
  total_mem_bytes: 1000,
  quiet_ms: 1000,
  since_input_ms: 1000,
  output_bytes: 10,
  procs: [],
  ports: [],
  agent_hint: { bin: "claude", pkg: null, path: null, interactive: true },
  ...over,
});

const NOTE = "Ana's agent renamed priceFor to quote in checkout.ts. Your cart.ts still calls priceFor.";

function seed() {
  seams.stats = [session({ id: 7, name: "Ana's agent" }), session({ id: 8, name: "Ben's agent", cwd: "/w/shop/.wt/ben" })];
  seams.digests = [
    {
      session_id: "s-ana",
      agent: "claude",
      instance: "inst-1",
      state: "working",
      state_via: "turn-start",
      surface: "7",
      cwd: "/w/shop",
      updated: now,
      working_on: "renaming the pricing API",
      files: ["src/checkout.ts"],
    },
    {
      session_id: "s-ben",
      agent: "claude",
      instance: "inst-1",
      state: "working",
      state_via: "turn-start",
      surface: "8",
      cwd: "/w/shop/.wt/ben",
      updated: now,
      working_on: "cart discounts",
      files: ["src/cart.ts"],
    },
  ];
  seams.claims = [
    {
      id: "c1",
      paths: ["/w/shop/src/routes.ts"],
      owner: "Ana's agent (/w/shop)",
      owner_key: "pty:inst-1:7",
      pty_id: 7,
      instance: "inst-1",
      note: null,
      at_ms: Date.now(),
      released_at_ms: null,
      released_by: null,
      refusals: [],
    },
  ];
  seams.entries = [
    {
      id: "l1",
      kind: "awareness",
      ts: Date.now() - 60_000,
      root: "/w/shop",
      author: { kind: "brain", name: "awareness" },
      scope: "project",
      subject: NOTE,
      ref: { kind: "session", id: "s-ben" },
      data: {
        kind: "note",
        to: { sessionId: "s-ben", ptyId: 8, name: "Ben's agent", task: "cart discounts" },
        from: { sessionId: "s-ana", ptyId: 7, name: "Ana's agent", cli: "claude" },
        note: NOTE,
        risk: "conflict",
        files: ["src/checkout.ts"],
        turnId: "t1",
        delivered: true,
      },
    },
    {
      id: "r1",
      kind: "receipt",
      ts: Date.now() - 30_000,
      root: "/w/shop",
      author: { kind: "brain", name: "receipt" },
      scope: "project",
      ref: { kind: "session", id: "s-ana" },
      status: "verified",
      data: {},
    },
  ];
}

describe("TeamBoard", () => {
  it("shows every agent in flight with its task, claims, receipt and the brain-written note", async () => {
    seed();
    render(<TeamBoard active allProjects={[{ name: "shop", roots: ["/w/shop"] }]} />);

    const table = await screen.findByRole("table");
    await waitFor(() => expect(within(table).getByText("renaming the pricing API")).toBeTruthy());
    expect(within(table).getByText("cart discounts")).toBeTruthy();
    expect(within(table).getByText("routes.ts")).toBeTruthy();
    await waitFor(() => expect(within(table).getByText("verified")).toBeTruthy());
    // The note sits on the row of the agent it was sent to.
    const benRow = within(table).getByText("cart discounts").closest("tr")!;
    expect(within(benRow).getByText(NOTE)).toBeTruthy();

    // And in the feed, attributed both ways, flagged as a possible conflict.
    const feed = screen.getByRole("heading", { name: "What agents were told" }).closest("section")!;
    expect(within(feed).getByText(NOTE)).toBeTruthy();
    expect(within(feed).getByText("Ben's agent")).toBeTruthy();
    expect(within(feed).getByText(/was told about Ana's agent's change to checkout\.ts/)).toBeTruthy();
    expect(within(feed).getByText("may conflict")).toBeTruthy();

    await waitFor(() => expect(screen.getByText("src/routes.ts")).toBeTruthy());
  });

  it("says plainly why agents are not being told", () => {
    expect(statusLine({ state: "off" })).toMatch(/aren't told/);
    expect(statusLine({ state: "paused", reason: "no-brain", at: 0 })).toMatch(/No brain is connected/);
    expect(statusLine({ state: "remote" })).toMatch(/cloud workspaces/);
  });
});

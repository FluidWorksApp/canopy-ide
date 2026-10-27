import { beforeEach, describe, expect, it, vi } from "vitest";

type Wire = import("./ipc").LedgerEntryWire;
let emit: ((e: Wire) => void) | null = null;

vi.mock("./ipc", () => ({
  ledgerAppend: vi.fn(async (root: string, entry: object) => ({ id: "1", ts: 1, ...entry, root: `${root}-canonical` })),
  ledgerQuery: vi.fn(async () => []),
  ledgerUpdateStatus: vi.fn(async (_root: string, id: string, status: string) => ({ id: `${id}-next`, status })),
  ledgerRoot: vi.fn(async (p: string) => p),
  onLedgerAppended: vi.fn(async (cb: (e: Wire) => void) => {
    emit = cb;
    return () => {};
  }),
}));

import * as ipc from "./ipc";
import {
  appendLedger,
  queryLedger,
  resetLedgerForTests,
  setLedgerStatus,
  subscribeLedger,
  type LedgerEntry,
} from "./ledger";

const entry = (root: string, kind = "receipt"): Wire => ({
  id: "x",
  kind,
  ts: 1,
  root,
  author: { kind: "brain", name: "receipt" },
  scope: "project",
  data: {},
});

beforeEach(() => {
  resetLedgerForTests();
  emit = null;
  vi.clearAllMocks();
});

describe("ledger wrapper", () => {
  it("passes drafts, queries and status changes through to the store", async () => {
    const stored = await appendLedger<{ verdict: string }>("/repo", {
      kind: "receipt",
      author: { kind: "brain", name: "receipt" },
      scope: "project",
      ref: { kind: "turn", id: "s:1" },
      data: { verdict: "pass" },
    });
    expect(stored.root).toBe("/repo-canonical");
    expect(stored.data.verdict).toBe("pass");
    expect(ipc.ledgerAppend).toHaveBeenCalledWith("/repo", expect.objectContaining({ kind: "receipt" }));

    await queryLedger("/repo", { kinds: ["plan"], refKind: "turn", limit: 5 });
    expect(ipc.ledgerQuery).toHaveBeenCalledWith("/repo", { kinds: ["plan"], refKind: "turn", limit: 5 });
    await queryLedger("/repo");
    expect(ipc.ledgerQuery).toHaveBeenLastCalledWith("/repo", {});

    const next = await setLedgerStatus("/repo", "abc", "done");
    expect(next).toMatchObject({ id: "abc-next", status: "done" });
  });

  it("delivers appended entries to subscribers of that repository only", async () => {
    const mine: LedgerEntry[] = [];
    const all: LedgerEntry[] = [];
    const offMine = subscribeLedger("/repo/sub", (e) => mine.push(e));
    subscribeLedger("*", (e) => all.push(e));
    await Promise.resolve();
    expect(ipc.onLedgerAppended).toHaveBeenCalledTimes(1);
    emit!(entry("/repo"));
    emit!(entry("/other"));
    expect(mine.map((e) => e.root)).toEqual(["/repo"]);
    expect(all).toHaveLength(2);
    offMine();
    emit!(entry("/repo"));
    expect(mine).toHaveLength(1);
  });

  it("keeps delivering when one subscriber throws", async () => {
    const seen = vi.fn();
    subscribeLedger("/repo", () => {
      throw new Error("bug");
    });
    subscribeLedger("/repo", seen);
    await Promise.resolve();
    emit!(entry("/repo"));
    expect(seen).toHaveBeenCalledTimes(1);
  });
});

import { describe, expect, it } from "vitest";
import { computeOverlaps, relOverlap, toRepoRel, type PeerAgent } from "./overlap";

const NOW = 1_000_000_000;
const peer = (over: Partial<PeerAgent>): PeerAgent => ({
  sessionId: "p1",
  ptyId: 2,
  cli: "cli-a",
  cwd: "/repo",
  name: "Ana's agent",
  task: "checkout totals",
  files: [],
  recent: [],
  claims: [],
  ...over,
});

describe("toRepoRel", () => {
  const checkouts = ["/repo", "/repo/.worktrees/feat", "/elsewhere/repo-wt"];
  it("strips the longest checkout, so worktrees compare with the main checkout", () => {
    expect(toRepoRel("/repo/src/a.ts", checkouts)).toBe("src/a.ts");
    expect(toRepoRel("/repo/.worktrees/feat/src/a.ts", checkouts)).toBe("src/a.ts");
    expect(toRepoRel("/elsewhere/repo-wt/src/a.ts", checkouts)).toBe("src/a.ts");
  });
  it("keeps relative paths and drops paths outside the repository", () => {
    expect(toRepoRel("./src/a.ts", checkouts)).toBe("src/a.ts");
    expect(toRepoRel("/other/src/a.ts", checkouts)).toBeNull();
    expect(toRepoRel("", checkouts)).toBeNull();
  });
});

describe("relOverlap", () => {
  it("matches a file and its containing directory, not siblings sharing a prefix", () => {
    expect(relOverlap("src/checkout", "src/checkout/total.ts")).toBe(true);
    expect(relOverlap("src/checkout.ts", "src/checkout.tsx")).toBe(false);
  });
});

describe("computeOverlaps", () => {
  it("finds same-file, claimed and recently-edited overlaps, strongest reason per file", () => {
    const out = computeOverlaps({
      touched: ["src/checkout.ts", "src/cart.ts", "README.md"],
      peers: [
        peer({
          files: ["src/checkout.ts", "src/cart.ts"],
          recent: [{ path: "src/cart.ts", ts: NOW - 60_000 }],
          claims: ["src/checkout.ts"],
        }),
        peer({ sessionId: "p2", ptyId: 3, files: ["docs/other.md"] }),
      ],
      now: NOW,
      recentMs: 30 * 60_000,
    });
    expect(out).toHaveLength(1);
    expect(out[0].peer.sessionId).toBe("p1");
    expect(out[0].files).toEqual([
      { path: "src/checkout.ts", why: "claimed" },
      { path: "src/cart.ts", why: "recent-edit" },
    ]);
  });

  it("does not count journal edits older than the recent window", () => {
    const out = computeOverlaps({
      touched: ["src/a.ts"],
      peers: [peer({ recent: [{ path: "src/a.ts", ts: NOW - 2 * 3600_000 }] })],
      now: NOW,
      recentMs: 30 * 60_000,
    });
    expect(out).toEqual([]);
  });

  it("adds symbol-level overlap when a peer works in a file referencing a changed symbol", () => {
    const out = computeOverlaps({
      touched: ["src/pricing.ts"],
      peers: [peer({ files: ["src/cart.ts"] })],
      references: [{ symbol: "quote", files: ["src/cart.ts", "src/pricing.ts"] }],
      now: NOW,
      recentMs: 30 * 60_000,
    });
    expect(out[0].files).toEqual([{ path: "src/cart.ts", why: "references", symbol: "quote" }]);
  });

  it("ranks the peer with more overlapping files first", () => {
    const out = computeOverlaps({
      touched: ["a.ts", "b.ts"],
      peers: [
        peer({ sessionId: "one", ptyId: 4, files: ["a.ts"] }),
        peer({ sessionId: "two", ptyId: 5, files: ["a.ts", "b.ts"] }),
      ],
      now: NOW,
      recentMs: 1,
    });
    expect(out.map((o) => o.peer.sessionId)).toEqual(["two", "one"]);
  });
});

import { describe, expect, it } from "vitest";
import type { AgentEdit, ProvenanceEdge, SessionDigest, TurnList } from "../ipc";
import type { LedgerEntry } from "../ledger";
import { aboutSession, assembleSessionDoc, receiptVerdict, transcriptTail, turnLines } from "./assemble";
import { loadSessionDoc, type SessionDocDeps } from "./load";

const SID = "5b1f0c2e-aaaa-bbbb-cccc-000000000001";
const T0 = 1_760_000_000_000; // ms
const sec = (ms: number) => Math.floor(ms / 1000);

const digest: SessionDigest = {
  session_id: SID,
  agent: "claude",
  cwd: "/repo/app",
  branch: "feat/login",
  first_prompt: "Add a login page with email magic links",
  prompts: ["Add a login page with email magic links", "Now add tests"],
  files: ["src/login.tsx", "README.md"],
  updated: sec(T0 + 600_000),
};

const turns: TurnList = {
  git: true,
  root: "/repo/app",
  shared: false,
  peers: [],
  restores: [],
  turns: [
    {
      n: 1,
      prompt: "Add a login page with email magic links",
      start: { ref: "r1s", commit: "c", tree: "t", ts_ms: T0 },
      end: { ref: "r1e", commit: "c", tree: "t", ts_ms: T0 + 200_000 },
      late: false,
      native_uuid: null,
    },
    {
      n: 2,
      prompt: "Now add tests",
      start: { ref: "r2s", commit: "c", tree: "t", ts_ms: T0 + 300_000 },
      end: { ref: "r2e", commit: "c", tree: "t", ts_ms: T0 + 500_000 },
      late: false,
      native_uuid: null,
    },
  ],
};

const edit = (ts: number, path: string, present: boolean): AgentEdit => ({
  ts: sec(ts),
  path,
  tool: "Edit",
  old: null,
  new: "x",
  present,
});
const edits: AgentEdit[] = [
  edit(T0 + 10_000, "src/login.tsx", true),
  edit(T0 + 20_000, "src/auth.ts", false),
  edit(T0 + 400_000, "src/login.test.tsx", true),
  edit(T0 + 410_000, "src/login.tsx", true),
];

const entry = (over: Partial<LedgerEntry>): LedgerEntry => ({
  id: Math.random().toString(36).slice(2),
  kind: "receipt",
  ts: T0,
  root: "/repo/app",
  author: { kind: "brain", name: "test" },
  scope: "project",
  data: {},
  ...over,
});

const ledger: LedgerEntry[] = [
  // Receipt naming its turn explicitly.
  entry({ kind: "receipt", ts: T0 + 210_000, ref: { kind: "turn", id: `${SID}:${T0}` }, data: { verdict: "pass", summary: "Login renders and sends a link" } }),
  // Receipt with only a session ref and a status word, filed as turn 2 ended.
  entry({ kind: "receipt", ts: T0 + 505_000, ref: { kind: "session", id: SID }, status: "failed", data: {} }),
  entry({ kind: "plan", ts: T0 - 1000, ref: { kind: "session", id: SID }, data: { goal: "Passwordless login", steps: ["Page", { title: "Tests" }, 42] } }),
  entry({ kind: "memory", ts: T0 + 1000, author: { kind: "agent", name: "x", sessionId: SID }, data: { text: "Auth uses Supabase" } }),
  entry({ kind: "awareness", ts: T0 + 2000, ref: { kind: "session", id: "someone-else" }, data: { text: "Not ours" } }),
  entry({ kind: "handoff", ts: T0 + 600_000, ref: { kind: "session", id: SID }, subject: "Earlier handoff", data: {} }),
];

const provenance: ProvenanceEdge[] = [
  { repo: "/repo/app", pr_number: 7, pr_url: "https://x/pull/7", branch: "feat/login", session_id: SID, cwd: "/repo/app", via: "job_done", at: 1, confidence: "declared" },
];

describe("assembleSessionDoc", () => {
  const doc = assembleSessionDoc({
    sessionId: SID,
    agent: "claude",
    cwd: "/repo/app",
    digest,
    turns,
    edits,
    ledger,
    provenance,
    transcript: [
      { role: "user", text: "Add a login page" },
      { role: "assistant", text: "I'll use Supabase because the project already has it." },
    ],
  });

  it("takes the goal from the session's plan, ignoring malformed steps", () => {
    expect(doc.goal).toEqual({ text: "Passwordless login", source: "plan", steps: ["Page", "Tests"] });
    expect(doc.title).toBe("Passwordless login");
  });

  it("puts each turn's journaled files on it", () => {
    expect(doc.turns.map((t) => t.files.sort())).toEqual([
      ["src/auth.ts", "src/login.tsx"],
      ["src/login.test.tsx", "src/login.tsx"],
    ]);
  });

  it("badges turns with receipts by turn id, else by when they were filed", () => {
    expect(doc.turns[0].receipt?.verdict).toBe("pass");
    expect(doc.turns[0].receipt?.label).toBe("Login renders and sends a link");
    expect(doc.turns[1].receipt?.verdict).toBe("fail");
    expect(doc.latestReceipt?.verdict).toBe("fail");
  });

  it("counts the session's surviving edits per file, plus files only the digest reported", () => {
    const login = doc.files.find((f) => f.path === "src/login.tsx");
    expect(login).toEqual({ path: "src/login.tsx", edits: 2, present: 2 });
    expect(doc.files.find((f) => f.path === "src/auth.ts")?.present).toBe(0);
    expect(doc.files.find((f) => f.path === "README.md")?.edits).toBe(0);
    expect(doc.survivingEdits).toBe(3);
  });

  it("keeps only notes about this session, and its PRs and handoffs", () => {
    expect(doc.notes.map((n) => n.text)).toEqual(["Auth uses Supabase"]);
    expect(doc.prs).toEqual([{ number: 7, url: "https://x/pull/7" }]);
    expect(doc.handoffs.map((h) => h.subject)).toEqual(["Earlier handoff"]);
  });

  it("keys the document to its last turn", () => {
    expect(doc.lastTurnKey).toBe(`t2:${T0 + 500_000}`);
  });

  it("falls back to the first prompt and digest prompts without a timeline", () => {
    const bare = assembleSessionDoc({ sessionId: SID, agent: "codex", cwd: "/r", digest });
    expect(bare.goal).toEqual({ text: "Add a login page with email magic links", source: "first-prompt", steps: [] });
    expect(bare.turns.map((t) => t.prompt)).toEqual(digest.prompts);
    expect(bare.turns.every((t) => t.startedAt === null && t.files.length === 0)).toBe(true);
  });

  it("has an honest empty state with nothing at all", () => {
    const empty = assembleSessionDoc({ sessionId: SID, agent: "x", cwd: "/r" });
    expect(empty.goal.source).toBe("none");
    expect(empty.turns).toEqual([]);
    expect(empty.title).toBe("Agent session");
  });

  it("renders bounded prompt material", () => {
    expect(turnLines(doc)).toContain("1. Add a login page with email magic links — changed");
    expect(turnLines(doc)).toContain("receipt: fail");
    const tail = transcriptTail([{ role: "user", text: "a".repeat(100) }, { role: "assistant", text: "keep me" }], 40);
    expect(tail).toBe("[AGENT]\nkeep me");
  });
});

describe("ledger reads are defensive", () => {
  it("reads verdicts under any reasonable field name", () => {
    expect(receiptVerdict(entry({ data: { passed: true } }))).toBe("pass");
    expect(receiptVerdict(entry({ data: { outcome: "Partial" } }))).toBe("partial");
    expect(receiptVerdict(entry({ data: "garbage" as unknown as object }))).toBe("unknown");
  });
  it("matches entries by session ref, turn ref, author or data", () => {
    expect(aboutSession(entry({ data: { turnId: `${SID}:1` } }), SID)).toBe(true);
    expect(aboutSession(entry({ ref: { kind: "pr", id: SID } }), SID)).toBe(false);
  });
});

describe("loadSessionDoc", () => {
  it("assembles from every source and says which ones it could not read", async () => {
    const deps: SessionDocDeps = {
      digests: async () => [digest],
      turns: async () => {
        throw new Error("not in a git checkout");
      },
      edits: async () => edits,
      ledger: async (_root, q) => (q?.refKind === "session" ? ledger.filter((e) => e.ref?.kind === "session") : ledger),
      provenance: async () => provenance,
      transcript: async () => [{ role: "user", text: "hi" }],
    };
    const loaded = await loadSessionDoc({ sessionId: SID, agent: "claude", cwd: "/repo/app" }, deps);
    expect(loaded.digest?.branch).toBe("feat/login");
    expect(loaded.missing).toEqual(["turn timeline"]);
    // Entries reached by both queries are counted once.
    expect(loaded.doc.handoffs).toHaveLength(1);
    expect(loaded.doc.transcript).toEqual([{ role: "user", text: "hi" }]);
    expect(loaded.doc.turns.map((t) => t.prompt)).toEqual(digest.prompts);
  });
});

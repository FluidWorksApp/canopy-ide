# The brain spine

The shared foundation every intelligent feature builds on. The person connects
one agent CLI they are already signed into; that CLI is the **brain** and powers
every judgment Canopy makes. Features never pick a CLI, build argv, parse a
vendor stream, or invent their own store.

**Two rules:**

1. Every intelligent feature calls `askBrain` with its own feature tag.
2. Every durable artifact (plan, receipt, memory, awareness note, handoff,
   rule, review, outcome, spend record) goes in the ledger.

| Piece | File | What it gives you |
| --- | --- | --- |
| Which CLI | `src/brain.ts` | `installedBrain(installed)` — already existed |
| Ask it | `src/brainCall.ts` | `askBrain(req)` — headless, read-only, metered |
| Meter | `src/brainMeter.ts` | per-feature spend, daily budgets |
| Status | `src/brainStatus.ts` | connected / signed-out / rate-limited / … |
| Ledger | `src/ledger.ts`, `src-tauri/src/ledger.rs` | durable append-only store per repo |
| Turn events | `src/agentTurns.ts` | `onAgentTurnStart`, `onAgentTurnEnd` |

## askBrain

```ts
import { askBrain } from "./brainCall";

const answer = await askBrain<{ verdict: "pass" | "fail"; why: string }>({
  feature: "receipt",          // the meter and budgets key on this
  tier: "background",          // nobody is waiting: cheaper model, shared queue
  cwd: turn.cwd,               // the CLI runs (and may read files) here
  prompt: `Did this turn do what was asked?\n\n${summary}`,
  json: true,                  // asks for one JSON object and parses it
  validate: (v) => isVerdict(v) ? v : null,
});
if (!answer.ok) return;        // most features should skip quietly
use(answer.value!, answer.costUsd);
```

- **Never throws.** Failures are a `reason`: `no-brain`, `over-budget`,
  `rate-limited`, `signed-out`, `failed` (incl. aborted), `timeout`,
  `invalid-output` (the raw reply is in `message`).
- **Read-only, one-shot.** Runs the brain's verified runner
  (`structuredRunners.ts`) with read-only authority: on Claude Code that is
  `--permission-mode plan` plus a writer-tool denylist, `--no-session-persistence`
  (nothing in the person's resume list) and `--strict-mcp-config` (no MCP
  servers). On Codex, the read-only OS sandbox. The CLI may *read* files in `cwd`.
- **Not a Canopy agent.** `brain.rs` strips every `CANOPY*` variable, so hooks do
  not fire, no turn snapshot is taken, no turn event is published, and the call
  has no context-bridge (no `canopy_*` tools). Put what the brain needs in the prompt.
- **Tiers.** `main` uses the `brainModel` setting (empty = CLI default).
  `background` uses `brainBackgroundModel`, else the runner's `backgroundModel`
  (`"haiku"` on Claude Code), else the CLI default; at most
  `BRAIN_BACKGROUND_CONCURRENCY` (2) background calls run at once, the rest queue.
- **Timeouts.** Default 120 s (`timeoutMs`); `signal` aborts and kills the process.
- **Which CLIs can be the brain.** Any installed CLI with a verified structured
  runner that can take one prompt and end with its answer (`brainArgs` returns
  non-null). Today: Claude Code, Codex, Cursor. Others answer `no-brain`.
- **`cwd`** must be an existing directory (empty = home). A bad one is
  `failed` ("brain call cwd does not exist"), not `no-brain`.
- **`validate` without `json`** receives the reply text.
- **Session traces.** Claude Code calls leave no session; Codex has no verified
  ephemeral flag, so each Codex brain call persists a `codex exec` session.
- **Module cycle.** `brainCall` ↔ `brainStatus` import each other; safe because
  every cross-call is inside a function. Keep it that way.
- **Tokens.** `inputTokens` counts fresh + cache-write + cache-read prompt
  tokens. `costUsd` is null when the CLI reports no price (Codex); such calls
  meter as $0.

## brainMeter

```ts
import { brainSpend, brainSpendByFeature, startOfToday, subscribeBrainMeter } from "./brainMeter";

const today = brainSpend({ feature: "review", sinceMs: startOfToday() });
// { calls, failures, costUsd, inputTokens, outputTokens }
const off = subscribeBrainMeter(() => rerender());
```

`askBrain` records every call that reached the CLI; features do not call
`recordBrainCall` themselves. Budgets are settings — `brainDailyBudgetUsd`
(`null` = no cap) and `brainFeatureBudgetsUsd` (`{ [feature]: usd }`) — counted
over the local day; `connect-probe` is never gated. Kept in localStorage, last
5000 calls / 30 days.

## brainStatus

```ts
import { brainConnection, checkBrainConnection, subscribeBrainConnection } from "./brainStatus";

await checkBrainConnection();          // one-word probe on the background tier
brainConnection().state;               // "connected" | "signed-out" | "rate-limited" | …
```

Every `askBrain` outcome also updates the state: rate-limited / signed-out /
no-brain move it, any success restores `connected`. A plain failure or timeout
only moves it to `error` when it was the probe.

## Ledger

```ts
import { appendLedger, queryLedger, setLedgerStatus, subscribeLedger } from "./ledger";

const plan = await appendLedger(cwd, {
  kind: "plan",
  author: { kind: "brain", name: "plan" },
  scope: "project",
  ref: { kind: "session", id: sessionId },
  data: { steps: ["…"] },
});
const plans = await queryLedger<PlanData>(cwd, { kinds: ["plan"], refKind: "session", refId: sessionId });
const approved = await setLedgerStatus(cwd, plan.id, "approved");  // returns the new head
const off = subscribeLedger(cwd, (entry) => …);
```

- One JSONL file per repository at `~/.canopy/ledger/<sha256(root)[:32]>.jsonl`.
  `root` is canonicalized to the repo's **main checkout** (via `git
  --git-common-dir`), so every worktree of a repo shares one ledger; pass any
  directory of it. `ledgerRoot(path)` tells you the canonical key.
- Append-only. `setLedgerStatus` appends a copy with `supersedes: <old id>`;
  queries return chain heads only, so **ids change on status updates** — keep
  the returned entry, though any id in a chain still reaches its head.
- Queries are newest-first, skip expired entries (`expiresAt` in ms), default
  limit 200 (max 5000). Each entry is capped at 256 KiB — put big bodies in
  notes/research and `ref` them.
- `kind` is a closed set (see `LedgerKind`); add a kind in both `ledger.ts` and
  `ledger.rs` `KINDS`.
- Rust callers (e.g. a future MCP tool in `context.rs`) use `ledger::query`,
  `ledger::append_and_emit` and `ledger::update_status`.
- Every append emits the Tauri event `ledger-appended`.

## Agent turns

```ts
import { onAgentTurnEnd } from "./agentTurns";

const off = onAgentTurnEnd((turn) => {
  // { turnId, ptyId, sessionId, cli, cwd, root, prompt?, filesTouched, startedAt, endedAt, partial? }
});
```

Sourced from the hook pipeline that already powers turn rollback:
canopy-hook's `UserPromptSubmit` / `Stop` → `agent:events` → App.tsx, which
calls `observeAgentTurns` beside `observeTurnEvents`. `filesTouched` comes from
the agent's change journal (edit tools only — Bash edits are not journaled),
`root` is the ledger's canonical root. `ptyId` is null for CLIs whose hooks
cannot carry it. `partial: true` means the start was not observed (the app
opened mid-turn). Only CLIs with Canopy hooks installed produce turns.

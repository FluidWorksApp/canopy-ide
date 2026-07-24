// Which agent, if any, is a terminal running?
//
// The Rust side (agentid.rs) answers "what binary is this, really" from the
// process the pty has in the foreground. This turns that evidence into a
// registry id, through rungs ordered by how much they can be trusted:
//
//   1. the package that ships the executable — survives a renamed binary
//   2. the executable's own name, matched exactly
//   3. a binary we have *learned* about, from a hook event that named it
//   4. the hook stream's own claim, for a binary nothing else identifies
//   5. nothing identifies it, but the tty is in raw mode — an interactive
//      program, shown as itself
//
// The rule the whole thing exists to enforce: a near-miss produces no brand.
// Rungs 1-4 are exact, and only they set an `id`; rung 5 gets a row and its own
// name, never someone else's logo. Nothing here asks the user anything — rung 3
// is derived by watching the hook stream, so an in-house CLI Canopy has never
// heard of names itself the first time it reports a single event.

import type { AgentHint, SessionDigest } from "./ipc";
import { AGENT_CLIS, BIN_TO_AGENT, PKG_TO_AGENT } from "./projects";

export interface AgentIdentity {
  /** Registry id, or null when the terminal is running something we can see
   *  but cannot name. Null means: no brand mark, no workspace chip. */
  id: string | null;
  /** What to call the row. */
  label: string;
  /** Which rung answered — shown in the row tooltip, and what the tests pin. */
  via: "package" | "binary" | "learned" | "hook" | "interactive";
}

/** Full-screen programs that are emphatically not agents. Only consulted on the
 *  last rung, where all we know is "something interactive holds the tty" — a
 *  short, stable list is a safer thing to maintain than a list of every agent
 *  that will ever exist. */
const KNOWN_TUIS = new Set([
  "vim", "nvim", "vi", "emacs", "nano", "pico", "helix", "hx",
  "less", "more", "man", "watch", "top", "htop", "btop", "ncdu",
  "tig", "lazygit", "lazydocker", "gitui", "k9s", "ranger", "mc",
  "fzf", "tmux", "screen", "ssh", "mosh", "psql", "sqlite3", "irb", "node",
]);

const CLI_BY_ID = new Map(AGENT_CLIS.map((c) => [c.id, c]));

/** Learned binary -> agent id, keyed by canonical executable path.
 *
 *  Written only from evidence: a session whose hook reported an agent id while
 *  an otherwise-unidentifiable binary held its terminal. That pairing is the
 *  whole mechanism — it replaces asking the user what their binary is, and it
 *  makes the *next* launch of that binary identifiable before it emits
 *  anything at all. */
const LEARNED_KEY = "canopy.learnedAgentBins";
let learnedCache: Record<string, string> | null = null;

export function learnedBins(): Record<string, string> {
  if (learnedCache) return learnedCache;
  let next: Record<string, string> = {};
  try {
    const raw = localStorage.getItem(LEARNED_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) next = parsed;
  } catch {
    // Unreadable storage just means we start over: the map is an optimisation
    // over the hook stream, which will teach us again.
  }
  learnedCache = next;
  return next;
}

/** Record that `path` is `agentId`. Returns whether anything changed, so a
 *  caller can re-render exactly once rather than on every observation. */
export function learnBin(path: string, agentId: string): boolean {
  const learned = learnedBins();
  if (learned[path] === agentId) return false;
  learned[path] = agentId;
  try {
    localStorage.setItem(LEARNED_KEY, JSON.stringify(learned));
  } catch {
    // A full or disabled localStorage costs us the memory of this binary
    // across restarts, nothing more — the in-memory map still works.
  }
  return true;
}

/** Test seam: drop the process-local cache. */
export function resetLearned() {
  learnedCache = null;
}

/** A hook digest is only evidence about what is running *now*. A terminal keeps
 *  its digest after the agent exits, so a stale one must not name whatever the
 *  user ran next. */
const LEARN_WINDOW_MS = 10 * 60 * 1000;
function digestIsLive(digest: SessionDigest | undefined, now: number): boolean {
  if (!digest?.agent || digest.state === "ended") return false;
  return digest.updated == null || now - digest.updated < LEARN_WINDOW_MS;
}

const stripExe = (bin: string) => bin.replace(/\.exe$/i, "").toLowerCase();

/**
 * Identify what a terminal is running. Null means an idle shell, a batch
 * command, or anything else that isn't worth a row of its own.
 *
 * `hint` being absent is the definitive "nothing is running here" — it comes
 * from the pty's foreground process group, so it is not a heuristic, and it is
 * why a stale digest can never resurrect an agent that has exited.
 */
export function identifyAgent(
  hint: AgentHint | null | undefined,
  digest?: SessionDigest,
  now: number = Date.now(),
): AgentIdentity | null {
  if (!hint) return null;
  const named = (id: string, via: AgentIdentity["via"]): AgentIdentity => ({
    id,
    label: CLI_BY_ID.get(id)?.bin ?? id,
    via,
  });

  if (hint.pkg && PKG_TO_AGENT[hint.pkg]) {
    return named(PKG_TO_AGENT[hint.pkg], "package");
  }
  const bin = stripExe(hint.bin);
  if (BIN_TO_AGENT[bin]) return named(BIN_TO_AGENT[bin], "binary");
  const learned = hint.path ? learnedBins()[hint.path] : undefined;
  if (learned) return named(learned, "learned");
  // Nothing on disk identifies it, but the CLI itself has spoken.
  if (digestIsLive(digest, now)) {
    const agent = digest!.agent!;
    return { id: CLI_BY_ID.has(agent) ? agent : null, label: hint.bin, via: "hook" };
  }
  // Last rung: an interactive program we cannot name. It gets a row under its
  // own name because a terminal held by a full-screen app is not an idle
  // shell — and no brand, because we do not know whose it is.
  if (hint.interactive && !KNOWN_TUIS.has(bin)) {
    return { id: null, label: hint.bin, via: "interactive" };
  }
  return null;
}

/**
 * The agent a command *string* would start, or null.
 *
 * For the places with no live process to inspect — a remembered terminal, a
 * tab's launch command. Exact on the first token's basename, so `claude-utils`
 * or a script that merely mentions an agent's name is not one.
 */
export function agentIdForCommand(command?: string | null): string | null {
  const first = (command ?? "").trim().split(/\s+/)[0] ?? "";
  const bin = stripExe(first.split("/").pop() ?? "");
  return BIN_TO_AGENT[bin] ?? null;
}

/**
 * Learn from what the hook stream says about terminals whose binary we could
 * not otherwise name — the enterprise wrapper case, resolved without a prompt.
 *
 * Returns true if anything was learned, so the caller can re-render.
 */
export function observeForLearning(
  sessions: { hint: AgentHint | null | undefined; digest?: SessionDigest }[],
  now: number = Date.now(),
): boolean {
  let learned = false;
  for (const { hint, digest } of sessions) {
    if (!hint?.path || !digestIsLive(digest, now)) continue;
    // Only when the binary is a mystery: a CLI we can already identify must
    // never have its identity overwritten by whatever hook last fired.
    if (identifyAgent(hint, undefined, now)?.id) continue;
    learned = learnBin(hint.path, digest!.agent!) || learned;
  }
  return learned;
}

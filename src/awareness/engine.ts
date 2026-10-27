// "Every agent knows what every other agent just did."
//
// On every agent turn that changed files, this works out which OTHER live
// agents on the same repository (any checkout of it — main or a linked
// worktree) the change may affect, and tells them, before they write into it:
//
//  1. Overlap (overlap.ts): files the other agent has claimed, edited in the
//     last 30 minutes (its edit journal) or touched this session, and files
//     that reference an exported symbol the turn changed (symbols.ts, via a
//     language server already running — skipped when none is).
//  2. Judgment: ONE background-tier brain call per turn, covering every
//     overlapping agent (notes.ts). It decides whether the change matters to
//     each and writes the note. Cached by diff hash per target, so the same
//     change is never judged twice.
//  3. Delivery: each relevant note is typed into that agent's terminal as a
//     mesh message from the Canopy workspace (context_mesh_job_update, kind
//     "awareness" — the same store and two-write delivery canopy_message_agent
//     uses), recorded as an `awareness` ledger entry, and posted to the
//     person's attention feed ("Told <agent>: …").
//  4. Hotspots (hotspots.ts): when the turn touched a hotspot another live
//     agent also touched or claimed in the last 30 minutes, Canopy takes a
//     claim on it for the finishing agent through the existing claim store and
//     warns both. Deterministic, so it works without a brain.
//
// Cloud workspaces: when the IDE runs against one, the same steps reach the
// VM's agents through the workspace — digests, journals, churn and checkouts
// from its host, claims and note delivery through its Canopy service
// (harnessCommands.ts) — while the brain and the ledger stay on this computer.
// Agents in OTHER cloud workspaces on the same repository (this account's or a
// teammate's, matched by origin remote) are peers too: their files come from
// the workspace service's roster and their notes go through the cross-
// workspace mesh (cloudPeers.ts, meshJobs.message).
//
// Off switch: Settings → "Tell agents about each other's changes"
// (`awarenessEnabled`).

import * as ipc from "../ipc";
import { askBrain, type BrainAnswer, type BrainRequest } from "../brainCall";
import { appendLedger, type LedgerDraft, type LedgerEntry } from "../ledger";
import { postAttention, type AttentionInput } from "../attention";
import { getSettings } from "../settings";
import { isRemoteHost } from "../host";
import { basename } from "../paths";
import { onAgentTurnEnd, type AgentTurnEnd } from "../agentTurns";
import { computeOverlaps, relOverlap, toRepoRel, type FileOverlap, type Overlap, type PeerAgent } from "./overlap";
import { CHURN_DAYS, hotspotReason, inferHotspots, type Hotspot } from "./hotspots";
import { changedIdentifiers, referenceFiles } from "./symbols";
import {
  buildDiff,
  buildNotePrompt,
  hashText,
  validateNotes,
  type AwarenessRisk,
  type AwarenessVerdict,
} from "./notes";
import { cloudRosters, rosterEntry, sendCloudNote, type CloudRoster } from "./roster";
import { cloudPeersFor, repoKey } from "./cloudPeers";

/** A journal edit this old no longer counts as "recently edited". */
export const RECENT_MS = 30 * 60_000;
/** Two agents on one hotspot within this window get a claim. */
export const HOTSPOT_WINDOW_MS = 30 * 60_000;
/** Hotspot lists are recomputed at most this often per repository. */
const HOTSPOT_TTL_MS = 10 * 60_000;
const CACHE_MAX = 500;

/** The `data` of an `awareness` ledger entry. */
export interface AwarenessData {
  kind: "note" | "hotspot";
  to: { sessionId: string; ptyId: number; name: string; task: string | null; workspace?: string };
  from: { sessionId: string; ptyId: number | null; name: string; cli: string };
  note: string;
  risk: AwarenessRisk;
  /** Repo-relative. */
  files: string[];
  symbols?: string[];
  diffHash?: string;
  turnId: string;
  delivered: boolean;
  messageId?: string;
  error?: string;
}

/** The board's one line about whether this is working. */
export type AwarenessState =
  | { state: "on" }
  | { state: "off" }
  | { state: "paused"; reason: string; at: number };

export interface AwarenessDeps {
  enabled(): boolean;
  /** The IDE runs against a cloud workspace: the brain, which runs here,
   *  gets no workspace path to read. */
  remote(): boolean;
  roots(): string[];
  instance(): Promise<string>;
  digests(roots: string[]): Promise<ipc.SessionDigest[]>;
  livePtys(): Promise<number[]>;
  /** The journal for a session, relativised to its checkout when possible. */
  edits(cwd: string, sessionId: string): Promise<ipc.AgentEdit[]>;
  claims(): Promise<ipc.AgentClaim[]>;
  claimHistory(): Promise<ipc.AgentClaim[]>;
  /** Every checkout (main + worktrees) of the repo at `root`. */
  checkouts(root: string): Promise<string[]>;
  churn(repo: string): Promise<ipc.ChurnRow[]>;
  references(root: string, symbols: string[]): Promise<{ symbol: string; files: string[] }[]>;
  ask<T>(req: BrainRequest<T>): Promise<BrainAnswer<T>>;
  deliver(ptyId: number, instance: string, noteId: string, text: string): Promise<string>;
  /** The repository's origin remote, for finding cloud agents on it. */
  origin(repo: string): Promise<string | null>;
  /** Cloud workspaces' rosters; null when no team session can ask. */
  cloud(): Promise<CloudRoster[] | null>;
  /** The cloud workspace this IDE runs against, if any (its agents are
   *  already local peers). */
  currentWorkspace(): string | null;
  /** A note to an agent in a cloud workspace, through its service. */
  deliverCloud(workspace: string, ptyId: number, text: string): Promise<string>;
  claim(ptyId: number, paths: string[], owner: string, note: string): Promise<string>;
  append<D>(root: string, draft: LedgerDraft<D>): Promise<LedgerEntry<D>>;
  post(input: AttentionInput): string;
  now(): number;
}

const defaultDeps: AwarenessDeps = {
  enabled: () => getSettings().awarenessEnabled,
  remote: () => isRemoteHost(),
  roots: () => [],
  instance: () => ipc.instanceId(),
  digests: (roots) => ipc.sessionDigests(roots),
  livePtys: async () => (await ipc.ptyStats()).map((s) => s.id),
  edits: (cwd, sessionId) =>
    ipc.agentEdits(cwd, sessionId).catch(() => ipc.agentEdits(null, sessionId)),
  claims: () => ipc.contextClaims(),
  claimHistory: () => ipc.contextClaimHistory(),
  checkouts: async (root) => (await ipc.gitWorktrees(root)).filter((w) => !w.bare).map((w) => w.path),
  churn: (repo) => ipc.gitChurn(repo, CHURN_DAYS),
  references: (root, symbols) => referenceFiles(root, symbols),
  ask: (req) => askBrain(req),
  deliver: (ptyId, instance, noteId, text) => ipc.meshAwareness(ptyId, instance, noteId, text),
  origin: (repo) => ipc.gitRemoteUrl(repo).then((u) => u || null),
  cloud: () => cloudRosters(),
  currentWorkspace: () => null,
  deliverCloud: (workspace, ptyId, text) => sendCloudNote(workspace, ptyId, text),
  claim: (ptyId, paths, owner, note) => ipc.contextHotspotClaim(ptyId, paths, owner, note),
  append: (root, draft) => appendLedger(root, draft),
  post: (input) => postAttention(input),
  now: Date.now,
};

let deps: AwarenessDeps = defaultDeps;

// ------------------------------------------------------------------ state

let status: AwarenessState = { state: "on" };
const statusListeners = new Set<() => void>();

function setStatus(next: AwarenessState): void {
  if (JSON.stringify(next) === JSON.stringify(status)) return;
  status = next;
  for (const cb of statusListeners) cb();
}

/** Whether awareness is running, and if not, why — as of the last turn. */
export function awarenessStatus(): AwarenessState {
  if (!deps.enabled()) return { state: "off" };
  return status;
}

export function subscribeAwarenessStatus(cb: () => void): () => void {
  statusListeners.add(cb);
  return () => {
    statusListeners.delete(cb);
  };
}

/** Verdicts by `${diffHash}|${sessionId}` — the dedupe. */
const verdicts = new Map<string, AwarenessVerdict | null>();
/** Hotspot warnings already given, by `${a}|${b}|${path}`, with when. */
const hotspotSeen = new Map<string, number>();
const hotspotCache = new Map<string, { at: number; list: Hotspot[]; overridden: boolean }>();
const checkoutCache = new Map<string, { at: number; list: string[] }>();

function remember<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > CACHE_MAX) map.delete(map.keys().next().value as K);
}

// --------------------------------------------------------------- gathering

async function checkoutsOf(root: string, cwd: string): Promise<string[]> {
  const hit = checkoutCache.get(root);
  if (hit && deps.now() - hit.at < 60_000) return hit.list;
  const list = await deps.checkouts(root).catch(() => [] as string[]);
  const all = [...new Set([...list, root, ...(list.length ? [] : [cwd])])];
  remember(checkoutCache, root, { at: deps.now(), list: all });
  return all;
}

/** The checkout `cwd` lives in: the longest checkout containing it. */
function topOf(cwd: string, checkouts: readonly string[]): string {
  let best = "";
  for (const c of checkouts) {
    if ((cwd === c || cwd.startsWith(`${c}/`)) && c.length > best.length) best = c;
  }
  return best || cwd;
}

/** The hotspot list for a repo: the person's override, else inferred from
 *  churn and claim refusals. Cached; a failed churn read is just no churn. */
export async function hotspotsFor(
  root: string,
  repo: string,
  checkouts: readonly string[],
): Promise<{ list: Hotspot[]; overridden: boolean }> {
  const override = getSettings().awarenessHotspots[root];
  if (override) return { list: inferHotspots({ churn: [] }, override), overridden: true };
  const hit = hotspotCache.get(root);
  if (hit && deps.now() - hit.at < HOTSPOT_TTL_MS) return hit;
  const [churn, history] = await Promise.all([
    deps.churn(repo).catch(() => [] as ipc.ChurnRow[]),
    deps.claimHistory().catch(() => [] as ipc.AgentClaim[]),
  ]);
  const refusals = history.flatMap((c) =>
    c.refusals.length ? c.paths.map((p) => toRepoRel(p, checkouts)).filter((p): p is string => !!p) : [],
  );
  const result = { at: deps.now(), list: inferHotspots({ churn, refusals }), overridden: false };
  remember(hotspotCache, root, result);
  return result;
}

/** The board's view: a repo's hotspot list by its canonical root. */
export async function hotspotsForRepo(root: string): Promise<{ list: Hotspot[]; overridden: boolean }> {
  const checkouts = await checkoutsOf(root, root);
  return hotspotsFor(root, root, checkouts);
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function nameFor(ptyId: number | null, cli: string, cwd: string): { name: string; task: string | null } {
  const hit = ptyId != null ? rosterEntry(ptyId) : null;
  const task = hit ? [hit.title, hit.description].filter(Boolean).join(" — ") || null : null;
  return { name: hit?.name || `${cli || "agent"} in ${basename(cwd) || cwd}`, task };
}

/** Every other live agent in this repository, with what it is working on. */
async function gatherPeers(turn: AgentTurnEnd, checkouts: string[]): Promise<PeerAgent[]> {
  const [instance, digests, live, claims] = await Promise.all([
    deps.instance().catch(() => ""),
    deps.digests([...new Set([...deps.roots(), ...checkouts])]).catch(() => [] as ipc.SessionDigest[]),
    deps.livePtys().catch(() => [] as number[]),
    deps.claims().catch(() => [] as ipc.AgentClaim[]),
  ]);
  const peers: PeerAgent[] = [];
  const seenPty = new Set<number>();
  for (const d of digests) {
    // Live means its terminal is still open in this launch — the one fact
    // that cannot drift; what the digest says about its lifecycle is the
    // agentLife module's call, and not needed here.
    if (d.session_id === turn.sessionId || !d.cwd || !d.surface) continue;
    if (d.instance && instance && d.instance !== instance) continue;
    const ptyId = Number(d.surface);
    if (!Number.isInteger(ptyId) || !live.includes(ptyId) || seenPty.has(ptyId)) continue;
    if (turn.ptyId != null && ptyId === turn.ptyId) continue;
    const cwd = d.cwd;
    if (!checkouts.some((c) => cwd === c || cwd.startsWith(`${c}/`))) continue;
    seenPty.add(ptyId);
    const edits = await deps.edits(cwd, d.session_id).catch(() => [] as ipc.AgentEdit[]);
    const recent = edits
      .map((e) => ({ path: toRepoRel(e.path, checkouts), ts: e.ts * 1000 }))
      .filter((e): e is { path: string; ts: number } => !!e.path);
    const files = (d.files ?? [])
      .map((f) => toRepoRel(f.startsWith("/") ? f : `${cwd}/${f}`, checkouts))
      .filter((p): p is string => !!p);
    const held = claims
      .filter((c) => c.released_at_ms == null && c.pty_id === ptyId && (!c.instance || !instance || c.instance === instance))
      .flatMap((c) => c.paths.map((p) => toRepoRel(p, checkouts)).filter((p): p is string => !!p));
    const { name, task } = nameFor(ptyId, d.agent ?? "", cwd);
    peers.push({
      sessionId: d.session_id,
      ptyId,
      cli: d.agent ?? "",
      cwd,
      name,
      task: task ?? d.working_on ?? (d.first_prompt ? clip(d.first_prompt, 200) : null),
      files,
      recent,
      claims: held,
    });
  }
  return [...peers, ...(await cloudPeers(turn))];
}

/** Agents in other cloud workspaces on this repository. Asked only when the
 *  repository has an origin remote to match them by. */
async function cloudPeers(turn: AgentTurnEnd): Promise<PeerAgent[]> {
  try {
    const repo = repoKey(await deps.origin(turn.cwd));
    if (!repo) return [];
    const rosters = await deps.cloud();
    return rosters ? cloudPeersFor(rosters, repo, deps.currentWorkspace()) : [];
  } catch {
    // No remote, no team session, a roster that didn't answer: local only.
    return [];
  }
}

// ---------------------------------------------------------------- delivery

interface Origin {
  turn: AgentTurnEnd;
  name: string;
  checkouts: string[];
}

async function tell(
  origin: Origin,
  to: { sessionId: string; ptyId: number; name: string; task: string | null; cwd: string; cloud?: PeerAgent["cloud"] },
  body: {
    kind: AwarenessData["kind"];
    note: string;
    text: string;
    risk: AwarenessRisk;
    files: string[];
    symbols?: string[];
    diffHash?: string;
    noteId: string;
    title: string;
  },
): Promise<void> {
  const { turn } = origin;
  const instance = await deps.instance().catch(() => "");
  // The receiving agent resolves files in its own checkout.
  const top = to.cloud ? to.cloud.root : topOf(to.cwd, origin.checkouts);
  const refs = body.files.slice(0, 6).map((f) => `${top}/${f}`);
  const text = `${body.text}${refs.length ? ` Files: ${refs.join(", ")}` : ""}`;
  let messageId: string | undefined;
  let error: string | undefined;
  try {
    messageId = to.cloud
      ? await deps.deliverCloud(to.cloud.workspace, to.ptyId, text)
      : await deps.deliver(to.ptyId, instance, body.noteId.slice(0, 64), text);
  } catch (e) {
    error = String(e instanceof Error ? e.message : e);
  }
  const data: AwarenessData = {
    kind: body.kind,
    to: { sessionId: to.sessionId, ptyId: to.ptyId, name: to.name, task: to.task, ...(to.cloud ? { workspace: to.cloud.workspace } : {}) },
    from: { sessionId: turn.sessionId, ptyId: turn.ptyId, name: origin.name, cli: turn.cli },
    note: body.note,
    risk: body.risk,
    files: body.files,
    ...(body.symbols?.length ? { symbols: body.symbols } : {}),
    ...(body.diffHash ? { diffHash: body.diffHash } : {}),
    turnId: turn.turnId,
    delivered: !!messageId,
    ...(messageId ? { messageId } : {}),
    ...(error ? { error } : {}),
  };
  await deps
    .append(turn.root, {
      kind: "awareness",
      author: body.kind === "note" ? { kind: "brain", name: "awareness" } : { kind: "workspace", name: "Canopy workspace" },
      scope: "project",
      subject: body.note,
      ref: { kind: "session", id: to.sessionId },
      data,
    })
    .catch(() => {});
  deps.post({
    kind: "fyi",
    tone: body.risk === "conflict" ? "warn" : "info",
    title: messageId ? body.title : `Couldn't tell ${to.name}: ${body.title}`,
    body: body.note,
    source: "agent",
    dedupeKey: `awareness:${body.noteId}`,
  });
}

// -------------------------------------------------------------- hotspots

async function hotspotPass(origin: Origin, touched: string[], peers: PeerAgent[]): Promise<void> {
  const { turn, checkouts } = origin;
  const now = deps.now();
  const { list, overridden } = await hotspotsFor(turn.root, turn.cwd, checkouts);
  for (const path of touched) {
    const reason = hotspotReason(path, list, overridden);
    if (!reason) continue;
    const contenders = peers.filter(
      (p) =>
        p.claims.some((c) => relOverlap(c, path)) ||
        p.recent.some((e) => e.path === path && now - e.ts <= HOTSPOT_WINDOW_MS),
    );
    if (!contenders.length) continue;
    const key = `${turn.sessionId}|${contenders.map((p) => p.sessionId).sort().join(",")}|${path}`;
    const last = hotspotSeen.get(key);
    if (last != null && now - last < HOTSPOT_WINDOW_MS) continue;
    remember(hotspotSeen, key, now);
    const names = contenders.map((p) => p.name).join(", ");
    let claimed = false;
    let refusal = "";
    if (turn.ptyId != null) {
      const abs = `${topOf(turn.cwd, checkouts)}/${path}`;
      try {
        await deps.claim(turn.ptyId, [abs], `${origin.name} (${turn.cwd})`, `Canopy: ${path} is a hotspot ${names} also worked on`);
        claimed = true;
      } catch (e) {
        refusal = String(e instanceof Error ? e.message : e);
      }
    }
    const me = { sessionId: turn.sessionId, ptyId: turn.ptyId ?? -1, name: origin.name, task: null, cwd: turn.cwd };
    const base = { kind: "hotspot" as const, risk: "conflict" as AwarenessRisk, files: [path] };
    const youNote = claimed
      ? `${path} is a hotspot (${reason}) that ${names} also worked on in the last 30 minutes. Canopy claimed it for you so your writes don't collide; tell them when you're done (canopy_claim release frees it).`
      : refusal
        ? `${path} is a hotspot (${reason}) and another agent holds a claim on it: ${clip(refusal, 240)} Coordinate before editing it again.`
        : `${path} is a hotspot (${reason}) that ${names} also worked on in the last 30 minutes. Coordinate with them before editing it again.`;
    if (turn.ptyId != null) {
      await tell(origin, me, {
        ...base,
        note: youNote,
        text: youNote,
        noteId: `aw-hs-${hashText(key)}-${turn.ptyId}`,
        title: `Hotspot ${basename(path)}: ${origin.name} and ${names} both on it`,
      });
    }
    for (const p of contenders) {
      const theirNote = claimed
        ? `${path} is a hotspot (${reason}). ${origin.name} just edited it and now holds a claim on it. Don't edit it until they release it; ask them with canopy_message_agent if you need to.`
        : `${origin.name} just edited ${path}, a hotspot (${reason}) you are also working on. Check your changes to it still stand before you continue.`;
      await tell(origin, p, {
        ...base,
        note: theirNote,
        text: theirNote,
        noteId: `aw-hs-${hashText(key)}-${p.ptyId}`,
        title: `Told ${p.name}: ${origin.name} ${claimed ? "claimed" : "edited"} hotspot ${basename(path)}`,
      });
    }
  }
}

// ----------------------------------------------------------------- notes

function summarizeOverlap(files: FileOverlap[]): string {
  const names = files.slice(0, 3).map((f) => basename(f.path));
  return files.length > 3 ? `${names.join(", ")} +${files.length - 3}` : names.join(", ");
}

async function notePass(
  origin: Origin,
  overlaps: Overlap[],
  diff: string,
  symbols: string[],
): Promise<void> {
  const { turn } = origin;
  if (!overlaps.length) return;
  const diffHash = hashText(`${turn.sessionId}\n${diff}`);
  const pending = overlaps.filter((o) => !verdicts.has(`${diffHash}|${o.peer.sessionId}`));
  if (pending.length) {
    const answer = await deps.ask<(AwarenessVerdict | null)[]>({
      feature: "awareness",
      tier: "background",
      json: true,
      // The brain runs on this computer; a workspace path means nothing here,
      // and the prompt carries the diff.
      cwd: deps.remote() ? "" : turn.cwd,
      prompt: buildNotePrompt({
        from: { name: origin.name, cli: turn.cli },
        prompt: turn.prompt,
        diff,
        targets: pending.map((o) => ({
          name: o.peer.name,
          task: o.peer.task,
          files: o.peer.files,
          overlap: o.files,
        })),
      }),
      validate: (v) => validateNotes(v, pending.length),
    });
    if (!answer.ok) {
      setStatus({ state: "paused", reason: answer.reason, at: deps.now() });
      return;
    }
    setStatus({ state: "on" });
    pending.forEach((o, i) => remember(verdicts, `${diffHash}|${o.peer.sessionId}`, answer.value?.[i] ?? null));
  }
  for (const o of overlaps) {
    const v = verdicts.get(`${diffHash}|${o.peer.sessionId}`);
    if (!v?.relevant) continue;
    // Delivered once per (diff, target): a later identical turn hits the cache
    // above and must not re-type the note either.
    const deliveredKey = `${diffHash}|${o.peer.sessionId}|sent`;
    if (verdicts.has(deliveredKey)) continue;
    remember(verdicts, deliveredKey, null);
    const files = o.files.map((f) => f.path);
    const lead = `Heads-up from the Canopy workspace: ${origin.name} just changed ${summarizeOverlap(o.files)}.`;
    const tail = v.risk === "conflict" ? " Check before you continue editing these files." : "";
    await tell(origin, o.peer, {
      kind: "note",
      note: v.note,
      text: `${lead} ${v.note}${tail}`,
      risk: v.risk,
      files,
      symbols: o.files.flatMap((f) => (f.symbol ? [f.symbol] : [])).filter((s) => symbols.includes(s)),
      diffHash,
      noteId: `aw-${diffHash}-${o.peer.ptyId}`,
      title: `Told ${o.peer.name}: ${origin.name} changed ${summarizeOverlap(o.files)}`,
    });
  }
}

// ------------------------------------------------------------------- turn

/** Run awareness for one finished turn. Exported for tests; the engine
 *  serialises calls so dedupe never races. Never throws. */
export async function handleTurn(turn: AgentTurnEnd): Promise<void> {
  try {
    if (!deps.enabled()) {
      setStatus({ state: "off" });
      return;
    }
    if (!turn.filesTouched.length) return;
    const checkouts = await checkoutsOf(turn.root, turn.cwd);
    const touched = [
      ...new Set(turn.filesTouched.map((f) => toRepoRel(f, checkouts)).filter((p): p is string => !!p)),
    ];
    if (!touched.length) return;
    const peers = await gatherPeers(turn, checkouts);
    if (!peers.length) return;
    const origin: Origin = { turn, checkouts, name: nameFor(turn.ptyId, turn.cli, turn.cwd).name };

    // The turn's own edits: the diff the brain reads, and the symbols whose
    // references make symbol-level overlap.
    const from = Math.floor(turn.startedAt / 1000) - 1;
    const to = Math.ceil(turn.endedAt / 1000) + 1;
    const edits = (await deps.edits(turn.cwd, turn.sessionId).catch(() => [] as ipc.AgentEdit[])).filter(
      (e) => e.ts >= from && e.ts <= to,
    );
    const relEdits = edits.map((e) => ({ ...e, path: toRepoRel(e.path, checkouts) ?? e.path }));
    const diff = buildDiff(relEdits);
    const symbols = changedIdentifiers(relEdits).map((s) => s.symbol);
    const references = symbols.length
      ? (await deps.references(turn.cwd, symbols).catch(() => [])).map((r) => ({
          symbol: r.symbol,
          files: r.files.map((f) => toRepoRel(f, checkouts)).filter((p): p is string => !!p),
        }))
      : [];

    await hotspotPass(origin, touched, peers);
    const overlaps = computeOverlaps({ touched, peers, references, now: deps.now(), recentMs: RECENT_MS });
    await notePass(origin, overlaps, diff, symbols);
  } catch {
    // Awareness is a courtesy; a bug here must never reach the turn pipeline.
  }
}

let chain: Promise<void> = Promise.resolve();

/** Start listening for turn ends. `roots` lists the open projects'
 *  directories (where session digests are looked for); `currentWorkspace`
 *  names the cloud workspace this IDE runs against. Returns a stop. */
export function startAwareness(opts: { roots: () => string[]; currentWorkspace?: () => string | null }): () => void {
  deps = { ...deps, roots: opts.roots, ...(opts.currentWorkspace ? { currentWorkspace: opts.currentWorkspace } : {}) };
  return onAgentTurnEnd((turn) => {
    chain = chain.then(() => handleTurn(turn));
  });
}

/** Tests only: swap dependencies (merged over the real ones); null resets. */
export function setAwarenessDepsForTests(next: Partial<AwarenessDeps> | null): void {
  deps = next ? { ...defaultDeps, ...next } : defaultDeps;
  verdicts.clear();
  hotspotSeen.clear();
  hotspotCache.clear();
  checkoutCache.clear();
  status = { state: "on" };
}

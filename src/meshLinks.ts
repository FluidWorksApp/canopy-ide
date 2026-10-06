// The control panel's read of the mesh: which live agents have spoken to each
// other, in which direction the briefs flow, and which pairs the user has cut.
//
// Everything here is derived from the recorded messages (mesh.rs) — an edge
// exists because traffic was observed, never because two agents look related —
// and the derivations are pure so a fixture log tests them synchronously.
// Change notice arrives over the store-change channel: mesh.rs pulses at its
// write boundary, and this module is the frontend handler the guard test
// (storeChangeGuard.test.ts) requires for the `Mesh` variant.

import { createChannel } from "./channel";
import { registerStore } from "./stores";
import type { MeshMessage, SeveredPair } from "./ipc";

const board = createChannel(0);

registerStore("mesh", () => board.set(board.get() + 1));

/** Hear that the mesh moved — a message recorded or submitted, a pair severed
 *  or reconnected. The payload is deliberately not which: readers refetch. */
export const subscribeMesh = board.subscribe;

/** Test seam: what a store:change for "mesh" does, without the wire. */
export const __pulseMesh = () => board.set(board.get() + 1);

/** One observed link between two live terminals. `a` < `b` always; direction
 *  lives in `lead`, and only when the record actually shows one. */
export interface MeshEdge {
  a: number;
  b: number;
  /** Messages observed between the pair this app run. Zero only for a severed
   *  pair whose traffic has aged out of the log — the edge still renders, or
   *  there would be nothing left to reconnect. */
  count: number;
  /** The newest message on this edge, for the transmission pulse. */
  lastId: string | null;
  lastAtMs: number;
  /** Which end sent the newest message. */
  lastFrom: number | null;
  /** The recorded spawn parent, else the pty that originated every brief
   *  (non-reply message) on this edge. Null when neither signal exists. */
  lead: number | null;
  /** Why this edge is directional. Spawn openings are the recorded lineage;
   *  one-sided briefs are the deliberately weaker fallback; ordinary traffic
   *  carries no hierarchy. */
  relation: "spawn" | "inferred" | "traffic";
}

const pairKey = (a: number, b: number) => `${Math.min(a, b)}:${Math.max(a, b)}`;

/**
 * Edges from observed traffic: this launch's messages only (pty ids mean
 * nothing outside the launch that minted them), both ends live agent
 * terminals. Companion sends (no from pty) are not agent-to-agent links.
 */
export function deriveEdges(
  messages: MeshMessage[],
  instance: string | null,
  livePtyIds: ReadonlySet<number>,
): MeshEdge[] {
  const byPair = new Map<
    string,
    MeshEdge & {
      briefFrom: Set<number>;
      spawn: { from: number; atMs: number; id: string } | null;
    }
  >();
  for (const m of messages) {
    if (m.from_pty_id == null) continue;
    if (!instance || m.instance !== instance) continue;
    if (!livePtyIds.has(m.from_pty_id) || !livePtyIds.has(m.to_pty_id)) continue;
    if (m.from_pty_id === m.to_pty_id) continue;
    const key = pairKey(m.from_pty_id, m.to_pty_id);
    let edge = byPair.get(key);
    if (!edge) {
      edge = {
        a: Math.min(m.from_pty_id, m.to_pty_id),
        b: Math.max(m.from_pty_id, m.to_pty_id),
        count: 0,
        lastId: null,
        lastAtMs: 0,
        lastFrom: null,
        lead: null,
        relation: "traffic",
        briefFrom: new Set(),
        spawn: null,
      };
      byPair.set(key, edge);
    }
    edge.count += 1;
    if (m.at_ms >= edge.lastAtMs) {
      edge.lastAtMs = m.at_ms;
      edge.lastId = m.id;
      edge.lastFrom = m.from_pty_id;
    }
    if (!m.reply_to) edge.briefFrom.add(m.from_pty_id);
    if (isSpawnOpening(m)) {
      const candidate = { from: m.from_pty_id, atMs: m.at_ms, id: m.id };
      if (
        !edge.spawn ||
        candidate.atMs < edge.spawn.atMs ||
        (candidate.atMs === edge.spawn.atMs && candidate.id.localeCompare(edge.spawn.id) < 0)
      ) {
        edge.spawn = candidate;
      }
    }
  }
  return [...byPair.values()].map(({ briefFrom, spawn, ...edge }) => {
    if (spawn) return { ...edge, lead: spawn.from, relation: "spawn" as const };
    // One side originating every brief is the only fallback hierarchy the
    // record can show; anything else renders as secondary, undirected traffic.
    const lead = briefFrom.size === 1 ? [...briefFrom][0] : null;
    return {
      ...edge,
      lead,
      relation: lead == null ? ("traffic" as const) : ("inferred" as const),
    };
  });
}

/** A spawn opening is the one mesh write whose delivered terminal line ends
 *  in the complete recorded body. Rich mesh sends deliver only an id notice;
 *  direct sends keep the sanitised delivered text in `text` and no separate
 *  `delivered` field. This distinction is made at the existing Rust write
 *  doors, so lineage is evidence from the spawn record, not graph guesswork. */
function isSpawnOpening(message: MeshMessage): boolean {
  return (
    !message.reply_to &&
    !!message.delivered &&
    message.delivered.endsWith(`] ${message.text}`)
  );
}

/** Deterministic family-tree bands for one checkout. Recorded spawn lineage
 *  wins parent selection; one-sided briefing inference is the fallback. A
 *  malformed cycle is ignored at the edge that would close it, leaving every
 *  node in exactly one finite layer. */
export function lineageLayers(
  nodeIds: readonly number[],
  edges: readonly MeshEdge[],
): number[][] {
  const ids = [...new Set(nodeIds)].sort((a, b) => a - b);
  const known = new Set(ids);
  const candidates = edges
    .filter(
      (edge) =>
        edge.lead != null &&
        edge.relation !== "traffic" &&
        known.has(edge.a) &&
        known.has(edge.b),
    )
    .map((edge) => ({
      parent: edge.lead!,
      child: edge.lead === edge.a ? edge.b : edge.a,
      relation: edge.relation,
    }))
    .sort(
      (a, b) =>
        Number(a.relation !== "spawn") - Number(b.relation !== "spawn") ||
        a.child - b.child ||
        a.parent - b.parent,
    );

  const parentOf = new Map<number, number>();
  for (const candidate of candidates) {
    if (parentOf.has(candidate.child)) continue;
    let ancestor: number | undefined = candidate.parent;
    let cyclic = ancestor === candidate.child;
    while (!cyclic && ancestor != null) {
      ancestor = parentOf.get(ancestor);
      cyclic = ancestor === candidate.child;
    }
    if (!cyclic) parentOf.set(candidate.child, candidate.parent);
  }

  const depth = new Map<number, number>();
  const depthOf = (id: number): number => {
    const knownDepth = depth.get(id);
    if (knownDepth != null) return knownDepth;
    const parent = parentOf.get(id);
    const value = parent == null ? 0 : depthOf(parent) + 1;
    depth.set(id, value);
    return value;
  };
  for (const id of ids) depthOf(id);

  const layers: number[][] = [];
  for (const id of ids) {
    const d = depth.get(id) ?? 0;
    (layers[d] ??= []).push(id);
  }
  return layers;
}

/**
 * The severed edges the panel must still show: pairs cut by the user whose
 * message traffic has aged out. Between live terminals only — a severed pair
 * with a dead end has nothing to render or reconnect.
 */
export function severedOnlyEdges(
  severed: SeveredPair[],
  instance: string | null,
  livePtyIds: ReadonlySet<number>,
  edges: MeshEdge[],
): MeshEdge[] {
  const seen = new Set(edges.map((e) => pairKey(e.a, e.b)));
  return severed
    .filter(
      (s) =>
        !!instance &&
        s.instance === instance &&
        livePtyIds.has(s.a) &&
        livePtyIds.has(s.b) &&
        !seen.has(pairKey(s.a, s.b)),
    )
    .map((s) => ({
      a: Math.min(s.a, s.b),
      b: Math.max(s.a, s.b),
      count: 0,
      lastId: null,
      lastAtMs: 0,
      lastFrom: null,
      lead: null,
      relation: "traffic" as const,
    }));
}

/** Whether the user has severed this pair, in this launch. */
export function isSevered(
  severed: SeveredPair[],
  instance: string | null,
  a: number,
  b: number,
): boolean {
  return severed.some(
    (s) => !!instance && s.instance === instance && pairKey(s.a, s.b) === pairKey(a, b),
  );
}

// `checkoutKey` moved to paths.ts, beside the other pure path readings, once a
// third surface needed it and could not import this module without dragging a
// store registration along with it. Re-exported so existing callers still
// resolve.
export { checkoutKey } from "./paths";

/** What the panel knows an agent session as. `name` is reserved for the
 *  normalized human-friendly name the agents substrate will grow (research
 *  0119); until a snapshot carries one, the label is the strongest identity
 *  the record has today, composed — never invented. */
export interface NodeIdentity {
  /** The substrate's own name for this agent, once it has one. */
  name?: string | null;
  /** CLI kind — "Claude Code", "codex", … */
  agentLabel?: string | null;
  ptyId: number;
  /** What the session's tab is called. */
  tabTitle?: string | null;
  branch?: string | null;
}

/** The two lines a node (or a table's leading cell) shows. `primary` is the
 *  handle a human can say out loud; `detail` is what tells two of the same
 *  CLI apart. A `name` in the record replaces the composite primary whole. */
export function nodeLabel(id: NodeIdentity): { primary: string; detail: string } {
  const primary = id.name?.trim() || `${id.agentLabel?.trim() || "terminal"} #${id.ptyId}`;
  const detail = [
    id.tabTitle?.trim() && id.tabTitle.trim() !== primary ? id.tabTitle.trim() : null,
    id.branch?.trim() ? `⎇ ${id.branch.trim()}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return { primary, detail };
}

/** The prompt that started a session: the retained `first_prompt` when the
 *  digest has one, else the oldest human prompt still in the rotating window.
 *  Injected payloads open with a tag and identify nothing — skipped, same rule
 *  as `lastHumanPrompt`. */
export function initialPrompt(digest?: {
  first_prompt?: string;
  prompts?: string[];
}): string | undefined {
  if (digest?.first_prompt) return digest.first_prompt;
  return digest?.prompts?.find(
    (p) => p.trim().length > 0 && !p.trimStart().startsWith("<"),
  );
}

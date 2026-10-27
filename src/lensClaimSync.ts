// Layer ownership across the team. A claim used to live only in the ledger of
// the computer it was made on, so only that computer (and a cloud workspace it
// wrote the policy for) enforced it. Now:
//
//  * Claiming or letting go of a layer tells the team: a `layer` chat event
//    (teamMessaging/layerEvents.ts) to every team this account is in, naming
//    the repository by its origin (host + owner/name). The owner is the
//    message's authenticated sender.
//  * Every teammate's Canopy applies it to each open checkout of that
//    repository: the claim goes into that machine's ledger under the
//    claimant's team identity (only if the directory lists them as a member of
//    the team it came through), and the policy is republished, so the layer's
//    gate exists there too — with the owner's own sessions exempt.
//  * A layer someone else already owns on that machine isn't taken over, and a
//    release is only honoured from the owner.
//  * Claims are re-announced when the app starts and every few hours, so a
//    teammate who joined later, or whose device was away past the transport's
//    queue, catches up. The claim id makes a repeat a no-op.

import * as ipc from "./ipc";
import { repoRefFromRemote } from "./gitLinks";
import { appendLedger } from "./ledger";
import { republishPolicy } from "./gates/rules";
import { liveTeamSessions, subscribeLayerEvents, type TeamLayerEvent } from "./teamMessaging/session";
import type { RepoRef } from "./teamMessaging/cardSchema";
import { teamIdentity, type TeamIdentity } from "./teamIdentity";
import {
  LAYER_LABEL,
  OWNABLE_LAYERS,
  layerOwners,
  releaseLayer,
  type LayerOwnerRule,
  type OwnedLayer,
} from "./lensLayers";
import type { LedgerEntry } from "./ledger";

export interface ClaimSyncDeps {
  /** Every open checkout (project components). */
  roots(): string[];
  remoteUrl(root: string): Promise<string>;
  me(): Promise<TeamIdentity | null>;
  /** Team sessions to announce on: the ones this account holds. */
  sessions(): { user: string; sendLayer: (e: Parameters<SendLayer>[0]) => Promise<number> }[];
  republish(root: string): Promise<void>;
  now(): number;
}
type SendLayer = (e: { target: string; op: "claim" | "release"; layer: OwnedLayer; repo: RepoRef; owner: string; at: number }) => Promise<number>;

let deps: ClaimSyncDeps = {
  roots: () => [],
  remoteUrl: (root) => ipc.gitRemoteUrl(root),
  me: () => teamIdentity(),
  sessions: () => liveTeamSessions(),
  republish: (root) => republishPolicy(root),
  now: () => Date.now(),
};

const sameRepo = (a: RepoRef, b: RepoRef) =>
  a.host.toLowerCase() === b.host.toLowerCase() && a.slug.toLowerCase() === b.slug.toLowerCase();

const repoCache = new Map<string, { at: number; ref: Promise<RepoRef | null> }>();
/** The repository a checkout's origin names (cached for a few minutes). */
function repoOf(root: string): Promise<RepoRef | null> {
  const hit = repoCache.get(root);
  if (hit && deps.now() - hit.at < 5 * 60_000) return hit.ref;
  const ref = deps.remoteUrl(root).then((url) => repoRefFromRemote(url || ""), () => null);
  repoCache.set(root, { at: deps.now(), ref });
  return ref;
}

// ----------------------------------------------------------------- sending

/** Tell the team about a claim or release made here. Resolves to how many
 *  devices it reached; 0 when signed out, not in a team, or the checkout has
 *  no origin to name it by. Never throws. */
export async function shareLayerClaim(
  root: string,
  op: "claim" | "release",
  claim: LedgerEntry<LayerOwnerRule>,
): Promise<number> {
  try {
    const me = await deps.me();
    const repo = await repoOf(root);
    if (!me || !repo || !claim.data.claimId || claim.data.ownerId !== me.id) return 0;
    let n = 0;
    for (const s of deps.sessions().filter((x) => x.user === me.id)) {
      n += await s
        .sendLayer({ target: claim.data.claimId, op, layer: claim.data.layer, repo, owner: claim.data.owner, at: deps.now() })
        .catch(() => 0);
    }
    return n;
  } catch {
    return 0;
  }
}

/** Re-announce every layer this account owns in the open checkouts. */
export async function announceOwnClaims(): Promise<number> {
  const me = await deps.me().catch(() => null);
  if (!me) return 0;
  let n = 0;
  for (const root of deps.roots()) {
    const owners = await layerOwners(root).catch(() => ({}) as Awaited<ReturnType<typeof layerOwners>>);
    for (const layer of OWNABLE_LAYERS) {
      const c = owners[layer];
      if (c?.data.ownerId === me.id && c.data.claimId) n += await shareLayerClaim(root, "claim", c);
    }
  }
  return n;
}

// --------------------------------------------------------------- receiving

/** Apply a teammate's claim or release to every open checkout of its
 *  repository. Resolves to the roots that changed. */
export async function applyLayerEvent(e: TeamLayerEvent): Promise<string[]> {
  // The sender must be someone the team's directory lists.
  if (!e.member || e.sender === e.user) return [];
  const { event } = e;
  const name = (e.senderName || event.owner).trim().slice(0, 80);
  const changed: string[] = [];
  for (const root of [...new Set(deps.roots())]) {
    const repo = await repoOf(root);
    if (!repo || !sameRepo(repo, event.repo)) continue;
    const current = (await layerOwners(root).catch(() => ({}) as Awaited<ReturnType<typeof layerOwners>>))[event.layer];
    if (event.op === "claim") {
      if (current?.data.claimId === event.target) continue;
      // First owner holds it until they let go; nobody takes it over remotely.
      if (current && current.data.ownerId !== e.sender) continue;
      if (current) await releaseLayer(root, current).catch(() => undefined);
      await appendLedger<LayerOwnerRule>(root, {
        kind: "rule",
        author: { kind: "human", name },
        scope: "team",
        subject: `${name} owns ${LAYER_LABEL[event.layer]}`,
        ref: { kind: "lens-layer", id: event.layer },
        data: { type: "layer-owner", layer: event.layer, owner: name, ownerId: e.sender, claimId: event.target },
        status: "active",
      });
    } else {
      if (!current || current.data.ownerId !== e.sender) continue;
      if (current.data.claimId && current.data.claimId !== event.target) continue;
      await releaseLayer(root, current);
    }
    await deps.republish(root).catch(() => undefined);
    changed.push(root);
  }
  if (changed.length) for (const cb of listeners) cb();
  return changed;
}

const listeners = new Set<() => void>();
/** Hear about claims a teammate's event changed here (the lens re-reads). */
export function subscribeClaimSync(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

const ANNOUNCE_DELAY_MS = 20_000;
const ANNOUNCE_EVERY_MS = 6 * 60 * 60 * 1000;

/** Start listening for teammates' claims and announcing our own. App-wide. */
export function startLensClaimSync(opts: { roots: () => string[] }): () => void {
  deps = { ...deps, roots: opts.roots };
  let chain: Promise<unknown> = Promise.resolve();
  const off = subscribeLayerEvents((e) => {
    chain = chain.then(() => applyLayerEvent(e)).catch(() => undefined);
  });
  const first = setTimeout(() => void announceOwnClaims().catch(() => 0), ANNOUNCE_DELAY_MS);
  const every = setInterval(() => void announceOwnClaims().catch(() => 0), ANNOUNCE_EVERY_MS);
  return () => {
    off();
    clearTimeout(first);
    clearInterval(every);
  };
}

/** Tests only: swap dependencies (merged over the current ones); null resets the cache. */
export function setClaimSyncDepsForTests(next: Partial<ClaimSyncDeps>): void {
  deps = { ...deps, ...next };
  repoCache.clear();
  listeners.clear();
}

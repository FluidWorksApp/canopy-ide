// Layer ownership, enforced. An owned layer (lensLayers.ts) compiles into a
// `deny-path-write` gate over that layer's file patterns, published beside the
// team's written rules (gates/rules.ts publishPolicy), so the hook stops an
// agent's write into it — in either lens — until the owner approves.
//
// Three things decide the gate:
//  * the owner. Every terminal carries the signed-in team member who started
//    it (`CANOPY_MEMBER`, ipc.ts), and the gate lists the owner in
//    `exceptMembers`, so the hook lets the owner's own sessions through and
//    stops everyone else's — on one computer or in a cloud workspace several
//    people share. (A claim made before ownership carried an account id is
//    matched by name and simply not published on its owner's computer.)
//  * the patterns: the layer map's globs (the person can edit them).
//  * approvals. When the owner approves a `layer-approval` card in team chat
//    (lensApprovals.ts), its files become the gate's `exceptFiles` for a day,
//    so the agent can make exactly the change that was approved.
//
// Approvals are `review` ledger entries (ref lens-approval/<id>): a decision
// someone made about a change, which is what that kind holds.
import { appendLedger, queryLedger, type LedgerEntry } from "./ledger";
import { normalizeGate } from "./gates/dsl";
import { isMe, teamIdentity, type TeamIdentity } from "./teamIdentity";
import {
  LAYER_LABEL,
  OWNABLE_LAYERS,
  cachedLayerMap,
  layerOwners,
  type LayerMap,
  type LayerOwners,
  type OwnedLayer,
} from "./lensLayers";

/** How long an approval lets its files through. */
export const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;
/** The policy gate id of a layer's ownership gate. */
export const LAYER_GATE_PREFIX = "lens-layer:";
export const layerGateId = (layer: OwnedLayer) => `${LAYER_GATE_PREFIX}${layer}`;
export const layerOfGateId = (id: string | null | undefined): OwnedLayer | null => {
  if (!id?.startsWith(LAYER_GATE_PREFIX)) return null;
  const layer = id.slice(LAYER_GATE_PREFIX.length);
  return (OWNABLE_LAYERS as readonly string[]).includes(layer) ? (layer as OwnedLayer) : null;
};

export type ApprovalStatus = "pending" | "approved" | "rejected";

export interface LayerApprovalData {
  type: "layer-approval";
  approvalId: string;
  layer: OwnedLayer;
  owner: string;
  ownerId: string | null;
  /** Repo-relative files the change touches. */
  files: string[];
  summary: string;
  status: ApprovalStatus;
  requestedAt: number;
  decidedAt?: number;
  /** Who decided, as team chat named them. */
  decidedBy?: string;
  note?: string;
}

export const APPROVAL_REF_KIND = "lens-approval";

export interface PolicyGateWire {
  id: string;
  rule: string;
  scope: "project" | "team";
  gate: unknown;
  /** Team members whose own sessions the gate doesn't stop (gates.rs). */
  exceptMembers?: string[];
}

/** The rule text an agent is quoted when the gate stops it. */
export function layerRuleText(layer: OwnedLayer, owner: string): string {
  return `${LAYER_LABEL[layer]} is owned by ${owner}: changes to it need ${owner}'s approval. Stop and tell the person; they can send it for approval from the builder tools (What changed → Send for approval).`;
}

/** Files approved for `layer` and still inside their window. Only the owner's
 *  own decision counts: an approval decided by anyone else lets nothing by. */
export function approvedFiles(
  layer: OwnedLayer,
  ownerId: string | null,
  approvals: readonly LayerApprovalData[],
  now: number,
): string[] {
  const out = new Set<string>();
  for (const a of approvals) {
    if (a.layer !== layer || a.status !== "approved" || !a.decidedAt) continue;
    if (now - a.decidedAt > APPROVAL_TTL_MS) continue;
    if ((a.ownerId ?? null) !== (ownerId ?? null)) continue;
    for (const f of a.files) out.add(f);
  }
  return [...out];
}

/** The gates this computer publishes for owned layers. Pure. */
export function layerGates(
  map: Pick<LayerMap, "globs"> | null,
  owners: LayerOwners,
  approvals: readonly LayerApprovalData[],
  me: TeamIdentity | null,
  now: number = Date.now(),
): PolicyGateWire[] {
  if (!map) return [];
  const out: PolicyGateWire[] = [];
  for (const layer of OWNABLE_LAYERS) {
    const claim = owners[layer];
    const globs = map.globs[layer] ?? [];
    if (!claim || globs.length === 0) continue;
    const ownerId = claim.data.ownerId ?? null;
    // The owner's own sessions are the exception: by account id when the
    // claim has one; an older name-only claim isn't published on its owner's
    // computer at all.
    if (!ownerId && isMe(me, { name: claim.data.owner })) continue;
    const gate = normalizeGate({
      type: "deny-path-write",
      globs,
      exceptFiles: approvedFiles(layer, ownerId, approvals, now),
    });
    if (!gate) continue;
    out.push({
      id: layerGateId(layer),
      rule: layerRuleText(layer, claim.data.owner),
      scope: "team",
      gate,
      ...(ownerId ? { exceptMembers: [ownerId] } : {}),
    });
  }
  return out;
}

const isApproval = (d: unknown): d is LayerApprovalData =>
  !!d && typeof d === "object" && (d as { type?: unknown }).type === "layer-approval" &&
  typeof (d as { approvalId?: unknown }).approvalId === "string";

/** Every approval request for this repository, newest first. */
export async function layerApprovals(root: string): Promise<LedgerEntry<LayerApprovalData>[]> {
  const rows: LedgerEntry[] = await queryLedger(root, { kinds: ["review"], refKind: APPROVAL_REF_KIND, limit: 500 }).catch(() => []);
  return rows.filter((r) => isApproval(r.data)) as LedgerEntry<LayerApprovalData>[];
}

/** Record a new request, or a decision on one (as a successor entry). */
export async function writeApproval(
  root: string,
  data: LayerApprovalData,
  prev: LedgerEntry<LayerApprovalData> | null,
): Promise<LedgerEntry<LayerApprovalData>> {
  return appendLedger<LayerApprovalData>(root, {
    kind: "review",
    author: data.status === "pending" ? { kind: "human", name: "builder" } : { kind: "human", name: data.decidedBy ?? data.owner },
    scope: "team",
    subject: `${LAYER_LABEL[data.layer]} change: ${data.status}`,
    ref: { kind: APPROVAL_REF_KIND, id: data.approvalId },
    data,
    status: data.status,
    ...(prev ? { supersedes: prev.id } : {}),
  });
}

/** What the policy for `root` should carry for owned layers right now. */
export async function currentLayerGates(root: string, now: number = Date.now()): Promise<PolicyGateWire[]> {
  const [map, owners, approvals, me] = await Promise.all([
    cachedLayerMap(root),
    layerOwners(root),
    layerApprovals(root),
    teamIdentity(),
  ]);
  return layerGates(map, owners, approvals.map((a) => a.data), me, now);
}

// Layers for the builder lens: what part of the project a change touched, the
// Data / Logic / View map that teaches those layers, and who owns which layer.
//
// The map and the layer → file-pattern table are the brain's judgment, asked
// once per project on the background tier and cached in the ledger (`memory`
// kind) so reopening a project costs nothing. Ownership claims are `rule`
// entries: they are team constraints, and the gates feature (which *enforces*
// rules in the hook) reads the same kind. Ownership is enforced through that
// feature: lensGates.ts compiles each owned layer into a gate. An owner is a
// team identity (teamIdentity.ts), never a name typed on this computer.
import { askBrain, type BrainAnswer } from "./brainCall";
import { appendLedger, queryLedger, setLedgerStatus, type LedgerEntry } from "./ledger";
import { rulesEditorFor } from "./gates/events";
import { isMe, type TeamIdentity } from "./teamIdentity";

/** Every layer a change can be filed under. */
export type LensLayer = "data" | "logic" | "view" | "auth" | "deploy" | "integration";
export const LENS_LAYERS: readonly LensLayer[] = ["data", "logic", "view", "auth", "deploy", "integration"];

/** The layers an engineer can take over. Logic and view stay with whoever is
 *  building; the report's list is data, auth, deployment and integrations. */
export type OwnedLayer = "data" | "auth" | "deploy" | "integration";
export const OWNABLE_LAYERS: readonly OwnedLayer[] = ["data", "auth", "deploy", "integration"];

export const LAYER_LABEL: Record<LensLayer, string> = {
  data: "Data",
  logic: "Logic",
  view: "View",
  auth: "Sign-in & accounts",
  deploy: "Going live",
  integration: "Connected services",
};

/** One sentence each, shown under the map so the words mean something. */
export const LAYER_EXPLAINER: Record<"data" | "logic" | "view", string> = {
  data: "What your app remembers: saved records, tables, files.",
  logic: "The rules: what happens when someone clicks, signs up or pays.",
  view: "What people see: pages, buttons, colours, text.",
};

export const isLensLayer = (v: unknown): v is LensLayer =>
  typeof v === "string" && (LENS_LAYERS as readonly string[]).includes(v);

export interface LayerArea {
  /** One plain sentence about what this part of the project does. */
  summary: string;
  files: string[];
}

export interface LayerMap {
  areas: Record<"data" | "logic" | "view", LayerArea>;
  /** File patterns per ownable layer, editable by the person. */
  globs: Record<OwnedLayer, string[]>;
}

const MAX_FILES_PER_AREA = 40;
const MAX_GLOBS_PER_LAYER = 20;

const cleanLine = (v: unknown, max: number): string =>
  typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "";

const stringList = (v: unknown, max: number): string[] =>
  Array.isArray(v)
    ? [...new Set(v.map((s) => cleanLine(s, 300)).filter(Boolean))].slice(0, max)
    : [];

export function layerMapPrompt(projectName: string): string {
  return [
    `You are teaching a non-engineer how their project "${projectName}" is put together.`,
    "Look at the files in the current directory (read-only). Group the project into three layers:",
    "- data: what the app stores (database schema, models, migrations, seed data, storage)",
    "- logic: the rules (API routes, server functions, business logic, state)",
    "- view: what people see (pages, components, styles, templates)",
    "For each, write one plain-language sentence a non-engineer understands (no jargon, no file names in the sentence) and list up to 40 of its most important files as paths relative to the current directory.",
    "Also give glob patterns (relative, like \"src/auth/**\" or \"**/*.sql\") for four layers an engineer might take ownership of: data, auth (sign-in, sessions, permissions), deploy (hosting, CI, Docker, infrastructure config), integration (third-party APIs, webhooks, payment or email providers). Use an empty list when the project has none.",
    'Reply with one JSON object: {"data":{"summary":"…","files":["…"]},"logic":{…},"view":{…},"globs":{"data":["…"],"auth":["…"],"deploy":["…"],"integration":["…"]}}',
  ].join("\n");
}

export function validateLayerMap(v: unknown): LayerMap | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const area = (x: unknown): LayerArea | null => {
    if (!x || typeof x !== "object") return null;
    const a = x as Record<string, unknown>;
    const summary = cleanLine(a.summary, 300);
    if (!summary) return null;
    return { summary, files: stringList(a.files, MAX_FILES_PER_AREA) };
  };
  const data = area(o.data);
  const logic = area(o.logic);
  const view = area(o.view);
  if (!data || !logic || !view) return null;
  const g = (o.globs && typeof o.globs === "object" ? o.globs : {}) as Record<string, unknown>;
  const globs = Object.fromEntries(
    OWNABLE_LAYERS.map((layer) => [layer, stringList(g[layer], MAX_GLOBS_PER_LAYER)]),
  ) as Record<OwnedLayer, string[]>;
  return { areas: { data, logic, view }, globs };
}

// ---------------------------------------------------------------- map cache

const LAYERS_REF = { kind: "lens-layers", id: "project" } as const;

interface LayerMapRecord {
  map: LayerMap;
  /** True once a person edited the patterns: a refresh keeps their globs. */
  editedGlobs?: boolean;
}

const mapCache = new Map<string, LayerMap>();
const inflight = new Map<string, Promise<LayerMapResult>>();

export type LayerMapResult =
  | { ok: true; map: LayerMap; cached: boolean }
  | { ok: false; message: string };

/** The cached map, from memory or the ledger; null when none was ever made. */
export async function cachedLayerMap(root: string): Promise<LayerMap | null> {
  const hit = mapCache.get(root);
  if (hit) return hit;
  const rows = await queryLedger<LayerMapRecord>(root, {
    kinds: ["memory"],
    refKind: LAYERS_REF.kind,
    refId: LAYERS_REF.id,
    limit: 1,
  }).catch(() => []);
  const stored = rows[0]?.data?.map ? validateLayerMap(flatten(rows[0].data.map)) : null;
  if (stored) mapCache.set(root, stored);
  return stored;
}

// The stored shape is the validated one; re-validate through the brain shape
// so a hand-edited ledger line can't smuggle in junk.
const flatten = (m: LayerMap) => ({ ...m.areas, globs: m.globs });

async function storeLayerMap(root: string, map: LayerMap, editedGlobs: boolean, author: "brain" | "human") {
  mapCache.set(root, map);
  await appendLedger<LayerMapRecord>(root, {
    kind: "memory",
    author: { kind: author, name: "lens" },
    scope: "project",
    subject: "Project layers",
    ref: { ...LAYERS_REF },
    data: { map, editedGlobs },
  }).catch(() => undefined);
}

export interface LayerMapDeps {
  ask?: typeof askBrain;
}

/** The map, generating it once (background tier) when there is none or when
 *  `refresh` is asked. Concurrent callers share one brain call. */
export function ensureLayerMap(
  root: string,
  projectName: string,
  opts: { refresh?: boolean; tier?: "main" | "background" } = {},
  deps: LayerMapDeps = {},
): Promise<LayerMapResult> {
  const key = `${root}\0${opts.refresh ? "refresh" : "ensure"}`;
  const running = inflight.get(key);
  if (running) return running;
  const job = (async (): Promise<LayerMapResult> => {
    const prior = await cachedLayerMap(root);
    if (prior && !opts.refresh) return { ok: true, map: prior, cached: true };
    const answer: BrainAnswer<LayerMap> = await (deps.ask ?? askBrain)<LayerMap>({
      feature: "lens",
      tier: opts.tier ?? "background",
      cwd: root,
      json: true,
      prompt: layerMapPrompt(projectName),
      validate: validateLayerMap,
    });
    if (!answer.ok || !answer.value) {
      return { ok: false, message: answer.ok ? "The answer could not be read." : answer.message };
    }
    // A refresh re-reads the project, but patterns a person corrected are
    // theirs: keep them rather than reverting to the brain's guess.
    const rows = await queryLedger<LayerMapRecord>(root, {
      kinds: ["memory"], refKind: LAYERS_REF.kind, refId: LAYERS_REF.id, limit: 1,
    }).catch(() => []);
    const keepGlobs = rows[0]?.data?.editedGlobs && prior;
    const map = keepGlobs ? { ...answer.value, globs: prior.globs } : answer.value;
    await storeLayerMap(root, map, Boolean(keepGlobs), "brain");
    return { ok: true, map, cached: false };
  })().finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

/** Save the person's corrected patterns for one layer. */
export async function saveLayerGlobs(root: string, layer: OwnedLayer, globs: string[]): Promise<LayerMap | null> {
  const prior = await cachedLayerMap(root);
  if (!prior) return null;
  const map: LayerMap = {
    ...prior,
    globs: { ...prior.globs, [layer]: stringList(globs, MAX_GLOBS_PER_LAYER) },
  };
  await storeLayerMap(root, map, true, "human");
  return map;
}

// ------------------------------------------------------------- glob matching

/** A glob as the hook reads it (gates.rs `expand_glob`, kept in step): a bare
 *  name ("migrations") is that file or folder anywhere, a name ending in `/`
 *  its contents, a pattern with no slash the file name at any depth, and a
 *  plain path also covers what is under it. What the lens shows as owned is
 *  then exactly what the hook stops. */
export function expandGlob(glob: string): string[] {
  const g = glob.trim().replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/^\/+/, "");
  if (!g) return [];
  const meta = /[*?[{]/.test(g);
  if (g.endsWith("/")) {
    const dir = g.slice(0, -1);
    return [`${dir.includes("/") || dir.startsWith("**") ? dir : `**/${dir}`}/**`];
  }
  if (!g.includes("/")) return meta ? [`**/${g}`] : [`**/${g}`, `**/${g}/**`];
  return meta ? [g] : [g, `${g}/**`];
}

/** A small, predictable glob: `**` any depth, `*` within one segment, `?` one
 *  character. A pattern with no slash matches the file name at any depth
 *  (".env" catches "config/.env"), which is how people write them. */
export function globToRegExp(glob: string): RegExp {
  let g = glob.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (g.endsWith("/")) g += "**";
  const anyDepth = !g.includes("/");
  let out = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        // "**/" matches zero or more directories; a trailing "**" anything.
        if (g[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else out += "[^/]*";
    } else if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${anyDepth ? "(?:.*/)?" : ""}${out}$`);
}

export function matchesAnyGlob(path: string, globs: readonly string[]): boolean {
  const p = path.replace(/\\/g, "/").replace(/^\.\//, "");
  return globs.some((g) => expandGlob(g).some((x) => globToRegExp(x).test(p)));
}

/** Paths relative to `root` when they sit under it; untouched otherwise. */
export function relativeTo(root: string, path: string): string {
  const r = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const p = path.replace(/\\/g, "/");
  return p.startsWith(`${r}/`) ? p.slice(r.length + 1) : p;
}

// ---------------------------------------------------------------- ownership

export interface LayerOwnerRule {
  type: "layer-owner";
  layer: OwnedLayer;
  /** The owner's name, for display. */
  owner: string;
  /** The owner's team identity. Absent on claims made before ownership was
   *  tied to the signed-in account; those match by name. */
  ownerId?: string;
}

export type LayerOwners = Partial<Record<OwnedLayer, LedgerEntry<LayerOwnerRule>>>;

const OWNER_REF_KIND = "lens-layer";
const RELEASED = "released";

const isOwnerRule = (d: unknown): d is LayerOwnerRule => {
  if (!d || typeof d !== "object") return false;
  const o = d as Record<string, unknown>;
  return o.type === "layer-owner" && typeof o.owner === "string" && o.owner.trim() !== "" &&
    (OWNABLE_LAYERS as readonly string[]).includes(o.layer as string);
};

/** Current owners: the newest live claim per layer. Released claims and rule
 *  entries other features wrote (gates, reviews) are ignored. */
export async function layerOwners(root: string): Promise<LayerOwners> {
  const rows = await queryLedger(root, { kinds: ["rule"], refKind: OWNER_REF_KIND, limit: 200 }).catch(() => []);
  const owners: LayerOwners = {};
  for (const row of rows) {
    if (row.status === RELEASED || !isOwnerRule(row.data)) continue;
    const layer = row.data.layer;
    if (!owners[layer]) owners[layer] = row as LedgerEntry<LayerOwnerRule>;
  }
  return owners;
}

/** Claim a layer as the signed-in person. */
export async function claimLayer(root: string, layer: OwnedLayer, me: TeamIdentity): Promise<LedgerEntry<LayerOwnerRule>> {
  const name = me.name.trim().slice(0, 80) || me.email;
  return appendLedger<LayerOwnerRule>(root, {
    kind: "rule",
    author: { kind: "human", name },
    scope: "team",
    subject: `${name} owns ${LAYER_LABEL[layer]}`,
    ref: { kind: OWNER_REF_KIND, id: layer },
    data: { type: "layer-owner", layer, owner: name, ownerId: me.id },
    status: "active",
  });
}

/** Whether a layer's claim is the signed-in person's. */
export const ownsLayer = (me: TeamIdentity | null, claim: LedgerEntry<LayerOwnerRule> | undefined): boolean =>
  !!claim && isMe(me, { id: claim.data.ownerId, name: claim.data.owner });

export async function releaseLayer(root: string, claim: LedgerEntry<LayerOwnerRule>): Promise<void> {
  await setLedgerStatus(root, claim.id, RELEASED);
}

export interface OwnedLayerHit {
  layer: OwnedLayer;
  owner: string;
  ownerId: string | null;
  files: string[];
}

/** Which of `files` (absolute or relative to `root`) fall in a layer someone
 *  else owns. The owner's own changes are not theirs to approve. */
export function ownedLayerHits(
  root: string,
  files: readonly string[],
  globs: Partial<Record<OwnedLayer, readonly string[]>>,
  owners: LayerOwners,
  me: TeamIdentity | null,
): OwnedLayerHit[] {
  const hits: OwnedLayerHit[] = [];
  for (const layer of OWNABLE_LAYERS) {
    const claim = owners[layer];
    const patterns = globs[layer] ?? [];
    if (!claim || patterns.length === 0) continue;
    if (ownsLayer(me, claim)) continue;
    const matched = files.map((f) => relativeTo(root, f)).filter((f) => matchesAnyGlob(f, patterns));
    if (matched.length) {
      hits.push({ layer, owner: claim.data.owner, ownerId: claim.data.ownerId ?? null, files: [...new Set(matched)] });
    }
  }
  return hits;
}

/** The one sentence the builder lens shows. */
export function ownershipNotice(hit: OwnedLayerHit): string {
  return `${LAYER_LABEL[hit.layer]} is owned by ${hit.owner} — changes to it wait for their approval.`;
}

// ------------------------------------------------------------- team rules

/** Is there a Rules panel to send people to for this project? A real check: a
 *  project view holding `root` has its Rules editor mounted (gates/events.ts
 *  `registerRulesEditor`), so pressing the button opens something. */
export function teamRulesAvailable(root: string): boolean {
  return rulesEditorFor(root);
}

export function resetLensLayersForTests(): void {
  mapCache.clear();
  inflight.clear();
}

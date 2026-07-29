// The remote spine: the four primitives every remotely-visible feature reduces
// to, and nothing else. The shell — server, portal, publisher — is written
// against this file alone and never learns what a terminal or a research entry
// is. Features arrive as manifests (see ./modules) that declare which of these
// primitives they use; adding one must not require editing anything here.
//
//   Node       an addressable piece of state
//   Stream     live bytes attached to a node
//   Action     a verb on a node
//   Capability what works remotely, and when it doesn't, why
//
// The rule that keeps this from rotting: if the Rust core already knows a fact,
// a module may not publish it (see registry.ts, `publish`). The mirror carries
// only state the desktop frontend owns, so it shrinks as state moves down.

/** What a bearer token is allowed to do. Rust grants; manifests only declare. */
export type TokenScope = 'view' | 'drive' | 'admin'

export const SCOPE_RANK: Record<TokenScope, number> = {
  view: 0,
  drive: 1,
  admin: 2,
}

export function scopeAllows(granted: TokenScope, required: TokenScope): boolean {
  return SCOPE_RANK[granted] >= SCOPE_RANK[required]
}

/** Live channels the server knows how to attach. A new kind is a new provider
 *  registered in Rust — never a new message on the wire. */
export type StreamKind = 'pty'

export const STREAM_KINDS: StreamKind[] = ['pty']

/**
 * How much of a feature survives the trip to a browser.
 *
 * `none` carries a reason because the portal renders it verbatim: a surface
 * that is simply missing reads as a bug, and the honest answer ("this is a
 * native webview") is short enough to say.
 */
export type Capability =
  | { level: 'full' }
  | { level: 'view' }
  | { level: 'none'; reason: string }

export type Json =
  | string
  | number
  | boolean
  | null
  | Json[]
  | { [key: string]: Json }

/**
 * One addressable thing. The portal can render any node — title, subtitle,
 * status, badge, the actions that are live on it, and an attach affordance if
 * it streams — without knowing which module produced it. That is what makes a
 * new feature visible remotely for free; a bespoke view is an upgrade, never a
 * prerequisite.
 */
export interface Node {
  /** `module/kind/id`. Stable across republishes — actions address this. */
  ref: string
  module: string
  kind: string
  /** Ref of the containing node, usually `core/project/<id>`. */
  parent?: string
  title: string
  subtitle?: string
  status?: NodeStatus
  badge?: { count?: number; dot?: boolean; text?: string }
  /** Action names valid on this node *right now*, so the portal renders the
   *  affordance without re-deriving each module's rules. */
  actions?: string[]
  stream?: { kind: StreamKind; id: string | number }
  /** Module-private payload. Bounded by the module's byte budget. */
  data?: Json
}

export type NodeStatus = 'live' | 'idle' | 'done' | 'failed' | 'asleep'

export const NODE_STATUSES: NodeStatus[] = [
  'live',
  'idle',
  'done',
  'failed',
  'asleep',
]

// ---------- refs ----------

const SEGMENT = /^[a-z][a-z0-9-]*$/

export function makeRef(module: string, kind: string, id: string): string {
  return `${module}/${kind}/${id}`
}

/** Ids may themselves contain slashes (a file path, a branch name), so only the
 *  first two separators are structural. */
export function parseRef(
  ref: string,
): { module: string; kind: string; id: string } | null {
  const first = ref.indexOf('/')
  if (first <= 0) return null
  const second = ref.indexOf('/', first + 1)
  if (second <= first + 1) return null
  const module = ref.slice(0, first)
  const kind = ref.slice(first + 1, second)
  const id = ref.slice(second + 1)
  if (!SEGMENT.test(module) || !SEGMENT.test(kind) || id.length === 0) {
    return null
  }
  return { module, kind, id }
}

export function isValidSegment(s: string): boolean {
  return SEGMENT.test(s)
}

// ---------- the wire ----------
//
// Additive over the protocol portal.rs already speaks. Every message below is
// generic: none of them names a feature, and a new module adds no new message.

export interface SubMsg {
  t: 'sub'
  /** Refs (or `module/kind/*` prefixes) the client is actually looking at.
   *  Anything not subscribed is not sent — this is the whole chattiness
   *  budget, expressed once rather than per feature. */
  refs: string[]
}

export interface NodesMsg {
  t: 'nodes'
  add?: Node[]
  update?: Node[]
  remove?: string[]
}

export interface ActMsg {
  t: 'act'
  /** Client-supplied, echoed in the ack. Also the dedupe key: a reconnecting
   *  phone retries, and a replayed action must not run twice. */
  id: string
  action: string
  ref: string
  args?: Json
}

export interface ActAckMsg {
  t: 'act-ack'
  id: string
  ok: boolean
  error?: string
}

export interface AttachMsg {
  t: 'attach'
  ref: string
}

export interface DetachMsg {
  t: 'detach'
  ref: string
}

export interface FrameMsg {
  t: 'frame'
  ref: string
  b64: string
}

export interface CapsMsg {
  t: 'caps'
  modules: { id: string; title: string; capability: Capability }[]
  /** Build id of the server. A phone holding a cached SPA compares it and
   *  reloads rather than speaking a protocol the server has moved past. */
  build: string
}

export type ClientMsg = SubMsg | ActMsg | AttachMsg | DetachMsg
export type ServerMsg = NodesMsg | ActAckMsg | FrameMsg | CapsMsg

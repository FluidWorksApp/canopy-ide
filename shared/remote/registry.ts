// The registry: what a feature must declare to exist remotely, and the checks
// that hold it to it.
//
// A module is three files at most, and two of them are optional:
//
//   shared/remote/modules/<id>.ts   the manifest — pure data. No React, no
//                                   imports from src/. Rust reads the generated
//                                   JSON of these files and nothing else.
//   src/remote/<id>.ts              desktop binding: projections + verb
//                                   handlers. Only for frontend-owned state.
//   portal/src/remote/<id>.tsx      portal binding: a detail view. Only when
//                                   the generic node renderer isn't enough.
//
// Everything below is enforced by registry.test.ts. If one of those goes red,
// the fix is in the module, not in the assertion.

import {
  isValidSegment,
  STREAM_KINDS,
  type Capability,
  type Json,
  type Node,
  type StreamKind,
  type TokenScope,
} from './spine'

/** A Rust command the module needs exposed, and the least scope that may call
 *  it. Rust owns the grant; this only declares the need. */
export interface CommandNeed {
  name: string
  scope: TokenScope
}

/** A verb the *desktop* executes, because it needs frontend state or native
 *  work. Named `<module>.<verb>` so routing never has to guess an owner. */
export interface VerbNeed {
  name: string
  scope: TokenScope
  /** Refuse a second run while one is in flight. Required for anything that
   *  moves a ref, wakes a project, or spawns a process. */
  guard?: 'single-flight'
}

export interface PublishPolicy {
  /** One line naming the frontend-owned state this projects. A module whose
   *  state the Rust core already knows has nothing to say here and must set
   *  `publish: null` instead — see the Rust-first rule in spine.ts. */
  owns: string
  trigger: { on: 'change'; debounceMs: number } | { on: 'poll'; ms: number }
  /** Hard cap on one publish. Recent-N plus counts, never a blob. */
  budgetBytes: number
}

export interface RemoteManifest {
  id: string
  title: string
  /** `project` modules emit nodes parented to a project; `global` ones don't. */
  scope: 'global' | 'project'
  capability: Capability
  /** Node kinds this module emits. Used to route a ref to its owner. */
  kinds: string[]
  commands?: CommandNeed[]
  verbs?: VerbNeed[]
  streams?: StreamKind[]
  publish?: PublishPolicy | null
  /** Held back from remote by default (credentials, keys). The server refuses
   *  to expose these without an explicit opt-in. */
  sensitive?: boolean
}

/** The largest a single module's publish may be. A phone on a mobile radio pays
 *  for every byte of this on every change. */
export const MAX_BUDGET_BYTES = 64 * 1024
export const MIN_DEBOUNCE_MS = 100
export const MIN_POLL_MS = 1000

// ---------- validation ----------

export function validateManifest(m: RemoteManifest): string[] {
  const errs: string[] = []
  const at = (msg: string) => errs.push(`${m.id || '<unnamed>'}: ${msg}`)

  if (!isValidSegment(m.id)) at(`id must match /^[a-z][a-z0-9-]*$/`)
  if (!m.title.trim()) at('title is required')
  if (m.scope !== 'global' && m.scope !== 'project') at('scope must be global or project')

  if (m.capability.level === 'none' && !m.capability.reason.trim()) {
    at('capability none must carry a user-facing reason')
  }

  if (!m.kinds.length) at('must declare at least one node kind')
  for (const k of m.kinds) {
    if (!isValidSegment(k)) at(`kind '${k}' must match /^[a-z][a-z0-9-]*$/`)
  }

  for (const c of m.commands ?? []) {
    if (!/^[a-z][a-z0-9_]*$/.test(c.name)) at(`command '${c.name}' is not a Rust command name`)
  }

  for (const v of m.verbs ?? []) {
    if (!v.name.startsWith(`${m.id}.`)) at(`verb '${v.name}' must be namespaced '${m.id}.'`)
    if (!/^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/.test(v.name)) at(`verb '${v.name}' must be <module>.<verb>`)
  }

  for (const s of m.streams ?? []) {
    if (!STREAM_KINDS.includes(s)) at(`stream kind '${s}' has no provider`)
  }

  const p = m.publish
  if (p) {
    if (!p.owns.trim()) at('publish.owns must name the frontend-owned state it projects')
    if (p.budgetBytes <= 0 || p.budgetBytes > MAX_BUDGET_BYTES) {
      at(`publish.budgetBytes must be 1..${MAX_BUDGET_BYTES}`)
    }
    if (p.trigger.on === 'change' && p.trigger.debounceMs < MIN_DEBOUNCE_MS) {
      at(`publish debounce must be >= ${MIN_DEBOUNCE_MS}ms`)
    }
    if (p.trigger.on === 'poll' && p.trigger.ms < MIN_POLL_MS) {
      at(`publish poll must be >= ${MIN_POLL_MS}ms`)
    }
  }

  if (m.capability.level === 'none' && (m.commands?.length || m.verbs?.length || p)) {
    at('capability none must not also claim commands, verbs or a publish')
  }

  return errs
}

// ---------- the registry ----------

export class Registry {
  private byId = new Map<string, RemoteManifest>()
  private kindOwner = new Map<string, string>()

  constructor(manifests: RemoteManifest[] = []) {
    for (const m of manifests) this.add(m)
  }

  add(m: RemoteManifest): void {
    const errs = validateManifest(m)
    if (errs.length) throw new Error(`invalid remote manifest — ${errs.join('; ')}`)
    if (this.byId.has(m.id)) throw new Error(`duplicate remote module '${m.id}'`)
    for (const k of m.kinds) {
      const key = `${m.id}/${k}`
      const owner = this.kindOwner.get(key)
      if (owner) throw new Error(`kind '${key}' already owned by '${owner}'`)
      this.kindOwner.set(key, m.id)
    }
    this.byId.set(m.id, m)
  }

  all(): RemoteManifest[] {
    return [...this.byId.values()].sort((a, b) => a.id.localeCompare(b.id))
  }

  get(id: string): RemoteManifest | undefined {
    return this.byId.get(id)
  }

  /** Every command any module needs, deduped, at the *lowest* scope declared —
   *  the server grants once and the strictest caller still gets in. */
  commandNeeds(): CommandNeed[] {
    const out = new Map<string, TokenScope>()
    for (const m of this.all()) {
      if (m.sensitive) continue
      for (const c of m.commands ?? []) {
        const prev = out.get(c.name)
        out.set(c.name, prev && rank(prev) < rank(c.scope) ? prev : c.scope)
      }
    }
    return [...out].map(([name, scope]) => ({ name, scope })).sort(byName)
  }

  verbNeeds(): VerbNeed[] {
    return this.all()
      .flatMap((m) => (m.sensitive ? [] : (m.verbs ?? [])))
      .sort(byName)
  }

  /** The action → owning module map the router uses. */
  verbOwner(action: string): RemoteManifest | undefined {
    const dot = action.indexOf('.')
    if (dot <= 0) return undefined
    const m = this.byId.get(action.slice(0, dot))
    return m?.verbs?.some((v) => v.name === action) ? m : undefined
  }
}

const rank = (s: TokenScope) => ({ view: 0, drive: 1, admin: 2 })[s]
const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name)

// ---------- publish-time checks ----------

const REACT_ELEMENT = Symbol.for('react.element')
const REACT_TRANSITIONAL = Symbol.for('react.transitional.element')

/**
 * Reject anything that survives a `JSON.stringify` only by accident. A React
 * node, a Map, a class instance or a closure in a projection is the failure
 * this catches early: it serialises to `{}` or throws, and the portal shows a
 * blank row that nothing explains.
 */
export function assertSerializable(value: unknown, path = '$'): asserts value is Json {
  const t = typeof value
  if (value === null || t === 'string' || t === 'number' || t === 'boolean') {
    if (t === 'number' && !Number.isFinite(value as number)) {
      throw new Error(`${path}: ${value} is not representable in JSON`)
    }
    return
  }
  if (t === 'function' || t === 'symbol' || t === 'bigint' || t === 'undefined') {
    throw new Error(`${path}: ${t} is not serializable`)
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertSerializable(v, `${path}[${i}]`))
    return
  }
  const obj = value as Record<string, unknown>
  const tag = (obj as { $$typeof?: symbol }).$$typeof
  if (tag === REACT_ELEMENT || tag === REACT_TRANSITIONAL) {
    throw new Error(`${path}: React elements are not serializable — project a plain value`)
  }
  const proto = Object.getPrototypeOf(obj)
  if (proto !== Object.prototype && proto !== null) {
    throw new Error(`${path}: ${obj.constructor?.name ?? 'class instance'} is not a plain object`)
  }
  for (const [k, v] of Object.entries(obj)) assertSerializable(v, `${path}.${k}`)
}

export function measureBytes(nodes: Node[]): number {
  return new TextEncoder().encode(JSON.stringify(nodes)).length
}

export interface BudgetResult {
  nodes: Node[]
  /** How many nodes were dropped to fit. The portal shows this rather than
   *  pretending the list it has is the whole list. */
  more: number
}

/**
 * Hold a projection to its declared budget. Truncating loudly beats streaming a
 * 500KB history to a phone, and beats a silent cap that reads as "that's all
 * there is".
 */
export function enforceBudget(nodes: Node[], budgetBytes: number): BudgetResult {
  if (measureBytes(nodes) <= budgetBytes) return { nodes, more: 0 }
  let lo = 0
  let hi = nodes.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (measureBytes(nodes.slice(0, mid)) <= budgetBytes) lo = mid
    else hi = mid - 1
  }
  return { nodes: nodes.slice(0, lo), more: nodes.length - lo }
}

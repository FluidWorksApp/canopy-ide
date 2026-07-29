/// <reference types="node" />
// The guard for the remote spine. If one of these goes red, a module has
// stopped honouring the contract in registry.ts — fix the module, do not
// weaken the assertion or add an exemption. That is the whole reason the
// contract is machine-checked rather than written down in a doc nobody reads.
//
// The parity block at the bottom is the important one: a manifest is a request
// and `GRANTS` in src-tauri/src/remote/mod.rs is the grant. Keeping them equal
// in a test means widening the remote surface always takes a deliberate Rust
// edit, never a TypeScript one.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  MAX_BUDGET_BYTES,
  Registry,
  assertSerializable,
  enforceBudget,
  measureBytes,
  validateManifest,
  type RemoteManifest,
} from './registry'
import { MANIFESTS, registry } from './modules'
import { STREAM_KINDS, makeRef, parseRef, type Node } from './spine'

const ROOT = process.cwd()
const MODULES = join(ROOT, 'shared', 'remote', 'modules')

const base: RemoteManifest = {
  id: 'demo',
  title: 'Demo',
  scope: 'project',
  capability: { level: 'full' },
  kinds: ['thing'],
}

describe('module registration', () => {
  it('registers every manifest file in the directory', () => {
    const files = readdirSync(MODULES)
      .filter((f) => f.endsWith('.ts') && f !== 'index.ts')
      .map((f) => f.replace(/\.ts$/, ''))
      .sort()
    const registered = MANIFESTS.map((m) => m.id).sort()
    expect(registered).toEqual(files)
  })

  it('accepts every shipped manifest', () => {
    for (const m of MANIFESTS) expect(validateManifest(m)).toEqual([])
  })

  it('refuses a duplicate module id', () => {
    const r = new Registry([base])
    expect(() => r.add({ ...base })).toThrow(/duplicate/)
  })

  it('refuses two modules claiming the same kind', () => {
    const r = new Registry([base])
    expect(() => r.add({ ...base, id: 'demo' })).toThrow()
  })
})

describe('the contract', () => {
  it('requires a reason when a module cannot travel', () => {
    const errs = validateManifest({
      ...base,
      capability: { level: 'none', reason: '  ' },
    })
    expect(errs.join()).toMatch(/user-facing reason/)
  })

  it('refuses a module that is both unavailable and claiming a surface', () => {
    const errs = validateManifest({
      ...base,
      capability: { level: 'none', reason: 'native view' },
      commands: [{ name: 'store_load', scope: 'view' }],
    })
    expect(errs.join()).toMatch(/must not also claim/)
  })

  it('requires verbs to be namespaced by their module', () => {
    const errs = validateManifest({
      ...base,
      verbs: [{ name: 'other.resume', scope: 'drive' }],
    })
    expect(errs.join()).toMatch(/namespaced/)
  })

  it('requires a publish to name the frontend state it owns', () => {
    const errs = validateManifest({
      ...base,
      publish: { owns: '', trigger: { on: 'change', debounceMs: 250 }, budgetBytes: 4096 },
    })
    expect(errs.join()).toMatch(/publish.owns/)
  })

  it('caps a publish budget and floors its cadence', () => {
    const tooBig = validateManifest({
      ...base,
      publish: {
        owns: 'open tabs',
        trigger: { on: 'change', debounceMs: 250 },
        budgetBytes: MAX_BUDGET_BYTES + 1,
      },
    })
    expect(tooBig.join()).toMatch(/budgetBytes/)

    const tooFast = validateManifest({
      ...base,
      publish: { owns: 'open tabs', trigger: { on: 'poll', ms: 200 }, budgetBytes: 4096 },
    })
    expect(tooFast.join()).toMatch(/poll must be/)
  })

  it('refuses a stream kind with no provider', () => {
    const errs = validateManifest({
      ...base,
      streams: ['screencast' as (typeof STREAM_KINDS)[number]],
    })
    expect(errs.join()).toMatch(/no provider/)
  })
})

describe('refs', () => {
  it('round-trips, including ids that contain slashes', () => {
    const ref = makeRef('files', 'file', 'src/components/Term.tsx')
    expect(parseRef(ref)).toEqual({
      module: 'files',
      kind: 'file',
      id: 'src/components/Term.tsx',
    })
  })

  it('rejects malformed refs rather than guessing', () => {
    for (const bad of ['', 'files', 'files/file', 'files//x', '/file/x', 'Files/file/x']) {
      expect(parseRef(bad)).toBeNull()
    }
  })
})

describe('serializability', () => {
  it('accepts plain nested data', () => {
    expect(() =>
      assertSerializable({ a: 1, b: [true, null, 'x'], c: { d: 2 } }),
    ).not.toThrow()
  })

  it('rejects the things that survive JSON.stringify only by accident', () => {
    expect(() => assertSerializable({ onSelect: () => {} })).toThrow(/function/)
    expect(() => assertSerializable({ seen: new Map() })).toThrow(/plain object/)
    expect(() => assertSerializable({ at: new Date() })).toThrow(/plain object/)
    expect(() => assertSerializable({ n: Number.NaN })).toThrow(/not representable/)
    expect(() =>
      assertSerializable({ icon: { $$typeof: Symbol.for('react.element') } }),
    ).toThrow(/React elements/)
  })

  it('names the path so a deep offender is findable', () => {
    expect(() => assertSerializable({ a: { b: [{ c: () => {} }] } })).toThrow(
      /\$\.a\.b\[0\]\.c/,
    )
  })
})

describe('budgets', () => {
  const node = (i: number): Node => ({
    ref: `demo/thing/${i}`,
    module: 'demo',
    kind: 'thing',
    title: `thing ${i}`,
    subtitle: 'x'.repeat(200),
  })

  it('passes a projection that fits through untouched', () => {
    const nodes = [node(1), node(2)]
    expect(enforceBudget(nodes, MAX_BUDGET_BYTES)).toEqual({ nodes, more: 0 })
  })

  it('truncates loudly instead of silently capping', () => {
    const nodes = Array.from({ length: 50 }, (_, i) => node(i))
    const out = enforceBudget(nodes, 2048)
    expect(out.nodes.length).toBeGreaterThan(0)
    expect(out.nodes.length).toBeLessThan(nodes.length)
    expect(out.more).toBe(nodes.length - out.nodes.length)
    expect(measureBytes(out.nodes)).toBeLessThanOrEqual(2048)
  })
})

describe('needs', () => {
  it('dedupes commands at the lowest scope any module asked for', () => {
    const r = new Registry([
      { ...base, id: 'a', kinds: ['a'], commands: [{ name: 'git_log', scope: 'drive' }] },
      { ...base, id: 'b', kinds: ['b'], commands: [{ name: 'git_log', scope: 'view' }] },
    ])
    expect(r.commandNeeds()).toEqual([{ name: 'git_log', scope: 'view' }])
  })

  it('leaves sensitive modules out of the exposed surface', () => {
    const r = new Registry([
      {
        ...base,
        id: 'vault',
        kinds: ['secret'],
        sensitive: true,
        commands: [{ name: 'vault_read', scope: 'admin' }],
      },
    ])
    expect(r.commandNeeds()).toEqual([])
  })

  it('routes a verb only to the module that declared it', () => {
    const r = new Registry([
      { ...base, id: 'naps', kinds: ['nap'], verbs: [{ name: 'naps.resume', scope: 'drive' }] },
    ])
    expect(r.verbOwner('naps.resume')?.id).toBe('naps')
    expect(r.verbOwner('naps.destroy')).toBeUndefined()
    expect(r.verbOwner('nope')).toBeUndefined()
  })
})

// ---------- parity with Rust ----------

const rustSrc = readFileSync(join(ROOT, 'src-tauri', 'src', 'remote', 'mod.rs'), 'utf8')
const streamsSrc = readFileSync(join(ROOT, 'src-tauri', 'src', 'remote', 'streams.rs'), 'utf8')

function rustGrants(): { name: string; scope: string }[] {
  const table = rustSrc.split('pub const GRANTS')[1]?.split('];')[0] ?? ''
  return [...table.matchAll(/\("([a-z_0-9]+)",\s*Scope::(\w+),\s*(\w+)\)/g)].map((m) => ({
    name: m[1],
    scope: m[2].toLowerCase(),
    guard: m[3],
  }))
}

describe('grants match what the modules ask for', () => {
  const grants = rustGrants()

  it('parses the Rust grant table', () => {
    expect(grants.length).toBeGreaterThan(0)
  })

  it('grants every command a module needs, at the scope it declared', () => {
    for (const need of registry.commandNeeds()) {
      const grant = grants.find((g) => g.name === need.name)
      expect(grant, `${need.name} is needed by a module but not granted in Rust`).toBeDefined()
      expect(grant?.scope, `${need.name} scope disagrees`).toBe(need.scope)
    }
  })

  it('exposes nothing no module asked for', () => {
    const needed = new Set(registry.commandNeeds().map((c) => c.name))
    for (const g of grants) {
      expect(needed.has(g.name), `${g.name} is granted but no module needs it`).toBe(true)
    }
  })

  it('has a Rust provider for every stream kind the spine declares', () => {
    const kinds = [...(streamsSrc.split('pub const KINDS')[1]?.split('];')[0] ?? '').matchAll(/"([a-z-]+)"/g)].map(
      (m) => m[1],
    )
    expect(kinds.sort()).toEqual([...STREAM_KINDS].sort())
  })
})

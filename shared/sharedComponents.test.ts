/// <reference types="node" />
// The guard on "why is the portal's file tree a different component?".
//
// It was, once: the remote portal shipped a second lazy tree that merely looked
// like the IDE's. Two implementations of one surface drift the day either is
// touched, and the drift is invisible from whichever screen you are not on.
//
// Written in branchSwitchGuard.test.ts style: greps, not mocks, because what is
// being asserted is a structural rule about the codebase rather than a
// behaviour of one function. If one of these goes red the fix is in the module,
// never an exemption here.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = process.cwd()
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8')

/** Files under shared/ that both shells compile. */
const SHARED_TSX = readdirSync(join(ROOT, 'shared'))
  .filter((f: string) => (f.endsWith('.ts') || f.endsWith('.tsx')) && !f.includes('.test.'))

describe('shared/ is genuinely shared', () => {
  it('never imports from the desktop app', () => {
    // The moment one of these reaches into src/, the portal build breaks — or
    // worse, quietly pulls Tauri's IPC into a browser bundle.
    for (const file of SHARED_TSX) {
      const src = read('shared', file)
      const bad = [...src.matchAll(/from\s+["']([^"']+)["']/g)]
        .map((m) => m[1])
        .filter((spec) => spec.includes('../src/') || spec.startsWith('../ipc'))
      expect(bad, `shared/${file} imports from src/`).toEqual([])
    }
  })

  it('keeps the file tree in one place', () => {
    // The portal must render the IDE's component, not its own. If a second tree
    // ever reappears in portal/, this is what says so.
    const panel = read('portal', 'src', 'panels', 'code.tsx')
    expect(panel).toContain("from '@shared/FileTree'")
    expect(panel).toContain('<FileTree')
    // Calling `fs_read_dir` is fine and expected — that is the adapter. What
    // must not come back is a second *implementation*: the expand/collapse
    // state, the recursive row component, the indent bookkeeping. All of that
    // lives in the shared tree, and a copy of it here is the drift this guards.
    for (const smell of ['function Branch', 'function Tree', 'twisty', 'tree-kids']) {
      expect(panel, `portal is growing its own tree again (${smell})`).not.toContain(smell)
    }
  })

  it('binds the desktop tree to ipc and nothing else', () => {
    const desktop = read('src', 'components', 'FileTree.tsx')
    expect(desktop).toContain('shared/FileTree')
    // The desktop shim's whole job: say what "the filesystem" means here.
    expect(desktop).toContain('readDir:')
    expect(desktop).toContain('iconUrl={fileIconUrl}')
  })

  it('styles the tree from the file beside it, not the desktop stylesheet', () => {
    // 200 lines of `.tree-*` sitting in a 16,000-line desktop stylesheet is a
    // component that is shared on paper only.
    const css = read('shared', 'fileTree.css')
    expect(css).toContain('.tree-row')
    expect(css).toContain('.tree-chevron')
    expect(read('src', 'index.css')).toContain('@import "../shared/fileTree.css"')
    expect(read('portal', 'src', 'panels', 'code.tsx')).toContain("@shared/fileTree.css")
  })

  it('leaves the re-export shims pointing at shared', () => {
    // 55 desktop files import these by their old paths. The shims are what made
    // the move a move rather than a rename of 55 files — and a shim that grows
    // an implementation is how the duplication comes back.
    for (const [path, target] of [
      [['src', 'components', 'ContextMenu.tsx'], 'shared/ContextMenu'],
      [['src', 'components', 'WindowedList.tsx'], 'shared/WindowedList'],
      [['src', 'components', 'Dialog.tsx'], 'shared/Dialog'],
      [['src', 'useEscape.ts'], 'shared/useEscape'],
      [['src', 'components', 'ui', 'Button.tsx'], 'shared/ui/Button'],
    ] as [string[], string][]) {
      const src = read(...path)
      expect(src, `${path.join('/')} should re-export ${target}`).toContain(target)
      // Comments and one export line. Anything longer means logic crept back in.
      const code = src.split('\n').filter((l: string) => l.trim() && !l.trim().startsWith('//'))
      expect(code.length, `${path.join('/')} has grown an implementation`).toBeLessThanOrEqual(2)
    }
  })
})

describe('the tree keeps the remote surface honest', () => {
  it('gates every mutation behind readOnly', () => {
    // The portal passes `readOnly`, and Rust grants no write command. If the
    // component ever calls a mutation outside that gate, the two disagree and
    // the phone gets an affordance the server will refuse.
    const src = read('shared', 'FileTree.tsx')
    for (const call of ['createFile', 'createDir', 'rename', 'trash', 'duplicate']) {
      expect(src).toContain(`fs.${call}`)
    }
    expect(src).toContain('if (readOnly) return')
    expect(src).toContain('!readOnly &&')
  })

  it('makes every writable operation optional on the adapter', () => {
    // The portal's adapter provides `readDir` alone. Requiring the rest would
    // force it to supply stubs for things it must never be able to do.
    const src = read('shared', 'FileTree.tsx')
    const iface = src.slice(src.indexOf('export interface FileTreeFs'))
    // To the interface's own closing brace, not the first `}` — several members
    // carry an inline object type and would cut the slice short.
    const body = iface.slice(0, iface.indexOf('\n}'))
    expect(body).toMatch(/\breadDir\(/)
    for (const m of ['gitStatus', 'createFile', 'rename', 'trash']) {
      expect(body, `${m} must be optional`).toContain(`${m}?(`)
    }
  })
})

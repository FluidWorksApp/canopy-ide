// The Changes panel against what `git_status` actually returns.
//
// `git_status` (src-tauri/src/fsx.rs) runs `git status --porcelain --ignored`,
// so the wire carries `!!` rows for every ignored path. Unfiltered, `!!` is
// "staged" by `isStaged` (`!` is neither a space nor a `?`) and "modified" by
// `statusWord`, so `node_modules/` shows up in the Staged section of a repo
// with nothing staged. These render the panel against that exact payload
// rather than asserting on the filter in isolation, so removing the filter
// from the call site fails here.

import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { changesPanel } from './code'
import { trackedChanges } from '@shared/gitStatus'
import type { PanelCtx } from './types'

interface Entry {
  status: string
  path: string
}

/** A ctx with exactly what this panel reaches for: one component (the repo)
 *  and an rpc that answers `git_status`. Nothing is spied on — the whole
 *  object is the substitute. */
function ctxWith(entries: Entry[], calls: string[] = []): PanelCtx {
  return {
    project: { id: 'p', name: 'canopy', components: [{ path: '/repo', label: 'canopy' }] },
    rpc: {
      call: (method: string) => {
        calls.push(method)
        if (method !== 'git_status') return Promise.reject(new Error(`unexpected ${method}`))
        return Promise.resolve({ is_repo: true, branch: 'main', entries })
      },
    },
    open: () => {},
  } as unknown as PanelCtx
}

const List = changesPanel.List

describe('the Changes panel and --ignored', () => {
  it('leaves ignored paths out of the list entirely', async () => {
    const ctx = ctxWith([
      { status: '!!', path: '/repo/node_modules/' },
      { status: '!!', path: '/repo/dist/' },
      { status: ' M', path: '/repo/src/App.tsx' },
    ])
    render(<List ctx={ctx} />)
    await waitFor(() => expect(screen.getByText('App.tsx')).not.toBeNull())
    expect(screen.queryByText('node_modules')).toBeNull()
    expect(screen.queryByText('dist')).toBeNull()
    // `!!` reads as staged to isStaged, so an unfiltered list grows a Staged
    // section on a repo where nothing is staged at all.
    expect(screen.queryByText('Staged')).toBeNull()
    expect(screen.getByText('Working tree')).not.toBeNull()
  })

  it('calls a tree with nothing but ignored paths clean', async () => {
    const ctx = ctxWith([
      { status: '!!', path: '/repo/node_modules/' },
      { status: '!!', path: '/repo/.env' },
    ])
    render(<List ctx={ctx} />)
    await waitFor(() => expect(screen.getByText('Working tree is clean.')).not.toBeNull())
    expect(screen.queryByText('.env')).toBeNull()
  })

  it('still shows real staged and unstaged work', async () => {
    const ctx = ctxWith([
      { status: '!!', path: '/repo/node_modules/' },
      { status: 'M ', path: '/repo/src/staged.ts' },
      { status: '??', path: '/repo/src/new.ts' },
    ])
    render(<List ctx={ctx} />)
    await waitFor(() => expect(screen.getByText('staged.ts')).not.toBeNull())
    expect(screen.getByText('Staged')).not.toBeNull()
    expect(screen.getByText('new.ts')).not.toBeNull()
    expect(screen.getByText('Working tree')).not.toBeNull()
  })
})

describe('trackedChanges', () => {
  it('drops `!!` and keeps every other porcelain code', () => {
    const entries = [
      { status: '!!', path: 'node_modules/' },
      { status: ' M', path: 'a.ts' },
      { status: '??', path: 'b.ts' },
      { status: 'M ', path: 'c.ts' },
      { status: 'MM', path: 'd.ts' },
      { status: 'R ', path: 'e.ts' },
      { status: ' D', path: 'f.ts' },
    ]
    expect(trackedChanges(entries).map((e) => e.path)).toEqual([
      'a.ts',
      'b.ts',
      'c.ts',
      'd.ts',
      'e.ts',
      'f.ts',
    ])
  })
})

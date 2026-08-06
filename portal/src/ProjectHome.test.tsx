// The "N changes" chip on the remote project home.
//
// `git_status` (src-tauri/src/fsx.rs) runs with `--ignored`, so the entry list
// it returns carries a `!!` row per ignored path. The chip counts *changes*, so
// counting the raw list means every project with a `.gitignore` reports work
// that does not exist. Rendered against that exact payload rather than asserting
// on a filter in isolation.

import { render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ProjectHome } from './ProjectHome'
import type { PanelCtx } from './panels/types'

interface Entry {
  status: string
  path: string
}

const project = {
  id: 'p1',
  name: 'canopy',
  components: [{ path: '/repo', label: 'canopy' }],
}

/** Substituted whole — no spies on anything the environment owns. `rpc.call`
 *  answers the two commands this view issues and rejects anything else, so a
 *  new dependency shows up as a failure rather than as silence. */
function ctxWith(entries: Entry[]): PanelCtx {
  return {
    project,
    projects: [project],
    rows: [],
    clis: [],
    stats: new Map(),
    pending: [],
    attention: [],
    roots: ['/repo'],
    rpc: {
      call: (method: string) => {
        if (method === 'session_digests') return Promise.resolve([])
        if (method === 'git_status') {
          return Promise.resolve({ is_repo: true, branch: 'main', entries })
        }
        return Promise.reject(new Error(`unexpected ${method}`))
      },
    },
    open: () => {},
    spawn: () => {},
  } as unknown as PanelCtx
}

const summary = () => screen.getByLabelText('Project status')

const renderHome = (entries: Entry[]) =>
  render(<ProjectHome ctx={ctxWith(entries)} clis={[]} onNewAgent={() => {}} />)

describe('the project summary change count', () => {
  it('does not count ignored paths as changes', async () => {
    renderHome([
      { status: '!!', path: '/repo/node_modules/' },
      { status: '!!', path: '/repo/dist/' },
      { status: '!!', path: '/repo/.env' },
      { status: ' M', path: '/repo/src/App.tsx' },
    ])
    await waitFor(() => expect(within(summary()).getByText('main')).not.toBeNull())
    expect(within(summary()).getByText('1')).not.toBeNull()
    // The raw list has four rows; four would mean node_modules is "work".
    expect(within(summary()).queryByText('4')).toBeNull()
  })

  it('reads zero on a tree whose only entries are ignored', async () => {
    renderHome([
      { status: '!!', path: '/repo/node_modules/' },
      { status: '!!', path: '/repo/dist/' },
    ])
    await waitFor(() => expect(within(summary()).getByText('main')).not.toBeNull())
    const changes = within(summary()).getByText('changes', { exact: false })
    expect(changes.textContent).toBe('0 changes')
  })

  it('still counts every real change', async () => {
    renderHome([
      { status: '!!', path: '/repo/node_modules/' },
      { status: ' M', path: '/repo/a.ts' },
      { status: '??', path: '/repo/b.ts' },
      { status: 'M ', path: '/repo/c.ts' },
    ])
    await waitFor(() => expect(within(summary()).getByText('main')).not.toBeNull())
    const changes = within(summary()).getByText('changes', { exact: false })
    expect(changes.textContent).toBe('3 changes')
  })
})

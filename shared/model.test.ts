import { describe, it, expect } from 'vitest'
import { agentFromTitle, buildRows, type Digest, type Pty, type Stat } from './model'

const ROOT = '/home/dev/canopy'
const noStats = new Map<number, Stat>()

const digest = (over: Partial<Digest> = {}): Digest => ({
  session_id: 's1',
  agent: 'claude',
  state: 'working',
  surface: '101',
  cwd: ROOT,
  updated: 10,
  ...over,
})
const pty = (id: number, cwd = ROOT, title = 'zsh'): Pty => ({ id, cwd, title })

describe('buildRows — agents', () => {
  it('marks a digest live when a PTY matches both its surface id and cwd', () => {
    const [row] = buildRows([digest()], [], noStats, 'inst', [pty(101)])
    expect(row).toMatchObject({ agent: 'claude', live: true, ptyId: 101 })
    expect(row.terminal).toBeFalsy()
  })

  it('leaves a digest offline when the matching PTY is in another cwd', () => {
    const rows = buildRows([digest()], [], noStats, 'inst', [pty(101, '/somewhere/else')])
    const agent = rows.find((r) => r.agent === 'claude' && !r.terminal)
    expect(agent).toMatchObject({ live: false, ptyId: undefined })
  })
})

describe('buildRows — terminals', () => {
  it('adds a row for every live PTY no digest claimed', () => {
    const rows = buildRows([digest()], [], noStats, 'inst', [pty(101), pty(7, ROOT, 'npm run dev')])
    const terms = rows.filter((r) => r.terminal)
    expect(terms).toHaveLength(1)
    expect(terms[0]).toMatchObject({
      key: 'pty:7',
      agent: 'shell',
      title: 'npm run dev',
      live: true,
      ptyId: 7,
      needsYou: false,
      cwd: ROOT,
    })
  })

  it('does not duplicate a PTY that an agent digest already owns', () => {
    const rows = buildRows([digest()], [], noStats, 'inst', [pty(101)])
    expect(rows.filter((r) => r.terminal)).toHaveLength(0)
    expect(rows).toHaveLength(1)
  })

  it('gives a terminal the PTY’s live cpu and memory', () => {
    const stats = new Map<number, Stat>([
      [
        7,
        {
          id: 7,
          title: 'zsh',
          cwd: ROOT,
          total_cpu: 12,
          total_mem_bytes: 4096,
          ports: [],
          procs: [],
        },
      ],
    ])
    const [term] = buildRows([], [], stats, 'inst', [pty(7)])
    expect(term).toMatchObject({ cpu: 12, memBytes: 4096 })
  })

  it('names a terminal after the agent CLI it is running', () => {
    const rows = buildRows([], [], noStats, 'inst', [pty(7, ROOT, 'codex — canopy')])
    expect(rows[0]).toMatchObject({ agent: 'codex', terminal: true })
  })

  it('only claims a PTY once when two digests share its surface id', () => {
    const sessions = [
      digest({ session_id: 'new', updated: 20 }),
      digest({ session_id: 'stale', updated: 5 }),
    ]
    const rows = buildRows(sessions, [], noStats, 'inst', [pty(101)])
    expect(rows.filter((r) => r.live)).toHaveLength(1)
    expect(rows.filter((r) => r.terminal)).toHaveLength(0)
  })
})

describe('agentFromTitle', () => {
  it.each([
    ['claude', 'claude'],
    ['Codex — canopy', 'codex'],
    ['gemini: worker', 'gemini'],
    ['zsh', undefined],
    ['npm run dev', undefined],
    ['shell', undefined],
    [undefined, undefined],
    ['', undefined],
  ])('%s -> %s', (title, expected) => {
    expect(agentFromTitle(title)).toBe(expected)
  })
})

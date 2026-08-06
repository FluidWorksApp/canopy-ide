// The portal's own logic, tested where it is testable: the pure functions that
// decide what a row says and what a notification says. The panels themselves are
// thin — a query and a projection — and their real failure mode is a Rust struct
// changing shape, which the interfaces beside each query catch at compile time.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseDiff } from './views/Diff'
import { KEYBOARD_QUERY, WIDE_QUERY } from './useMedia'
import { rel, statusWord } from './panels/code'
import { isStaged } from '@shared/gitStatus'
import { targetKey, type Target } from './panels/types'
import { tabLabel } from './shells/WideShell'
import { COMPACT_PRIMARY, PANELS, WIDE_RAIL_FOOTER, WIDE_RAIL_GROUPS, panelById } from './panels'
import { alertFor } from './notify'
import type { PendingItem } from '@shared/notifications'
import { MANIFESTS } from '@shared/remote/modules'

describe('the panel rail', () => {
  it('has a panel for every module that lists something', () => {
    // `browser` is capability:none — it declares why it cannot travel instead of
    // pretending to. `core` is the project addressing space, which the shell
    // renders as the project switcher rather than a panel of its own.
    // `instructions` keeps its manifest (the spine's grant tests hold in both
    // directions) but is deliberately not surfaced: the owner removed its menu
    // from the portal. If it comes back, delete it from this exclusion.
    const listing = MANIFESTS.filter(
      (m) => m.capability.level !== 'none' && m.id !== 'core' && m.id !== 'instructions',
    ).map((m) => m.id)
    for (const id of listing) {
      // `agents` covers both the agents and terminals panels; `stats` renders as
      // "usage". Everything else is one-to-one.
      const covered = panelById(id) ?? (id === 'stats' ? panelById('usage') : undefined)
      expect(covered, `module '${id}' has no panel in the rail`).toBeDefined()
    }
  })

  it('gives every panel a unique id', () => {
    const ids = PANELS.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("keeps the phone's primary tabs to a thumb's reach", () => {
    // Home + three panels + More. A sixth makes each target too narrow.
    expect(COMPACT_PRIMARY.length).toBe(3)
    for (const id of COMPACT_PRIMARY) expect(panelById(id)).toBeDefined()
  })

  it('leads with notifications', () => {
    // It is why you picked the phone up.
    expect(PANELS[0].id).toBe('notifications')
    expect(COMPACT_PRIMARY[0]).toBe('notifications')
  })

  it('renders project Home in both shells without pretending it is a module panel', () => {
    const wide = readFileSync(join(process.cwd(), 'portal/src/shells/WideShell.tsx'), 'utf8')
    const compact = readFileSync(join(process.cwd(), 'portal/src/shells/CompactShell.tsx'), 'utf8')
    expect(wide).toContain('<ProjectHome')
    expect(compact).toContain('<ProjectHome')
    expect(PANELS.some((panel) => panel.id === 'home')).toBe(false)
  })

  it('places every wide panel in desktop-style chrome exactly once', () => {
    // `notifications` lives in the title bar; `companion` floats above the
    // shell (it is cross-project, so it has no place in a rail that indexes
    // one project). Everything else is a rail entry.
    const placed = [
      'notifications',
      'companion',
      ...WIDE_RAIL_GROUPS.flatMap((group) => group.panels),
      ...WIDE_RAIL_FOOTER,
    ]
    expect(new Set(placed).size).toBe(placed.length)
    expect(new Set(placed)).toEqual(new Set(PANELS.map((panel) => panel.id)))
  })

  it('keeps the companion off the rail and on the floating face', () => {
    const railed = WIDE_RAIL_GROUPS.flatMap((group) => group.panels as readonly string[])
    expect(railed).not.toContain('companion')
    const shell = readFileSync(join(process.cwd(), 'portal/src/shells/WideShell.tsx'), 'utf8')
    expect(shell).toContain('<CompanionFab')
  })

  it('consumes the shared desktop chrome contract', () => {
    const shell = readFileSync(join(process.cwd(), 'portal/src/shells/WideShell.tsx'), 'utf8')
    const chrome = readFileSync(join(process.cwd(), 'shared/chrome.css'), 'utf8')
    for (const cls of ['titlebar', 'project-tabs', 'project-tab', 'rail', 'rail-group', 'rail-btn', 'pane-bar', 'tabs', 'tab-active']) {
      expect(shell).toContain(cls)
      expect(chrome).toContain(`.${cls}`)
    }
    expect(shell).not.toContain('prail')
    expect(shell).not.toContain('tabstrip')
  })

  it('keeps the wide tab strip keyboard and screen-reader navigable', () => {
    const shell = readFileSync(join(process.cwd(), 'portal/src/shells/WideShell.tsx'), 'utf8')
    expect(shell).toContain("role=\"tablist\"")
    expect(shell).toContain("role=\"tabpanel\"")
    expect(shell).toContain('aria-selected={key === activeKey}')
    expect(shell).toContain("event.key !== 'ArrowLeft'")
    expect(shell).toContain("event.key !== 'ArrowRight'")
  })
})

describe('the shared theme contract', () => {
  it('publishes the chrome tokens Remote needs', () => {
    const source = readFileSync(join(process.cwd(), 'src/remoteTheme.ts'), 'utf8')
    for (const token of [
      'bg-deep',
      'bg-overlay',
      'border-strong',
      'text-faint',
      'accent-soft',
      'r-xs',
      'shadow-1',
      'font-ui',
      'fs-md',
      'dur-fast',
    ]) {
      expect(source).toContain(`"${token}"`)
    }
  })

  it('republishes the theme while Settings is closed', () => {
    const app = readFileSync(join(process.cwd(), 'src/App.tsx'), 'utf8')
    expect(app).toContain('remoteSetTheme(readRemoteThemeTokens())')
    expect(app).toContain('addEventListener(THEME_CHANGE_EVENT, publish)')
  })

  it('publishes the resolved desktop CLI registry instead of hard-coding Remote', () => {
    const app = readFileSync(join(process.cwd(), 'src/App.tsx'), 'utf8')
    const launcher = readFileSync(join(process.cwd(), 'portal/src/NewAgentSheet.tsx'), 'utf8')
    expect(app).toContain('remoteSetClis(remoteCliMetadata(installed))')
    expect(launcher).not.toContain("const CLIS =")
    expect(launcher).toContain('clis: RemoteCli[]')
  })
})

describe('detail targets', () => {
  const targets: Target[] = [
    { kind: 'terminal', pty: 4 },
    { kind: 'history', key: 'sess-1' },
    { kind: 'file', path: '/w/canopy/src/App.tsx' },
    { kind: 'diff', repo: '/w/canopy', path: '/w/canopy/src/App.tsx', staged: false },
    { kind: 'commit', repo: '/w/canopy', hash: 'abc123def', subject: 'Fix the thing' },
    { kind: 'pr', repo: '/w/canopy', number: 42, title: 'Add remote panels' },
    { kind: 'text', title: 'CLAUDE.md', body: '# hi' },
    { kind: 'research', projectId: 'p1', id: 'e1', title: 'Vault' },
    { kind: 'doc', path: '/w/c/CLAUDE.md', roots: ['/w/c'], title: 'CLAUDE.md' },
  ]

  it('keys every kind distinctly', () => {
    const keys = targets.map(targetKey)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('separates the staged and unstaged diff of one file', () => {
    // They are different patches, so they are different tabs.
    const unstaged: Target = { kind: 'diff', repo: '/w/c', path: '/w/c/a.ts', staged: false }
    const staged: Target = { ...unstaged, staged: true }
    expect(targetKey(unstaged)).not.toBe(targetKey(staged))
  })

  it('labels every kind for the tab strip', () => {
    for (const t of targets) expect(tabLabel(t).length).toBeGreaterThan(0)
  })
})

describe('git status codes', () => {
  it('reads the index column, not the whole code, for staged-ness', () => {
    expect(isStaged('M ')).toBe(true)
    expect(isStaged('MM')).toBe(true)
    expect(isStaged(' M')).toBe(false)
    // Untracked is not staged, even though its first column is not a space.
    expect(isStaged('??')).toBe(false)
  })

  it('says what changed in one word', () => {
    expect(statusWord('??').word).toBe('new')
    expect(statusWord(' M').word).toBe('modified')
    expect(statusWord(' D').word).toBe('deleted')
    expect(statusWord('R ').word).toBe('renamed')
    expect(statusWord('A ').word).toBe('added')
  })

  it('shows a path relative to its repo', () => {
    expect(rel('/w/canopy/src/App.tsx', '/w/canopy')).toBe('src/App.tsx')
    expect(rel('/w/canopy/src/App.tsx', '/w/canopy/')).toBe('src/App.tsx')
    // A path outside the root is left whole rather than mangled.
    expect(rel('/elsewhere/a.ts', '/w/canopy')).toBe('/elsewhere/a.ts')
  })
})

describe('unified diff parsing', () => {
  const patch = [
    'diff --git a/a.ts b/a.ts',
    'index 111..222 100644',
    '--- a/a.ts',
    '+++ b/a.ts',
    '@@ -1,3 +1,3 @@',
    ' const a = 1',
    '-const b = 2',
    '+const b = 3',
  ].join('\n')

  it('classifies each line', () => {
    const kinds = parseDiff(patch).map((l) => l.kind)
    expect(kinds).toEqual(['meta', 'meta', 'meta', 'meta', 'hunk', 'ctx', 'del', 'add'])
  })

  it('does not colour the file headers as content', () => {
    // `---`/`+++` are the classic tell of a diff view written in a hurry: they
    // start with - and + but are headers, not a removed and an added line.
    const lines = parseDiff(patch)
    expect(lines[2].kind).toBe('meta')
    expect(lines[3].kind).toBe('meta')
  })

  it('keeps a removed line that itself begins with a dash', () => {
    const lines = parseDiff('@@ -1 +1 @@\n--- not a header, a deleted line')
    expect(lines[1].kind).toBe('meta')
  })
})

describe('notification text', () => {
  const base: PendingItem = {
    key: 'k1',
    kind: 'question',
    agent: 'claude',
    sessionId: 's1',
    cwd: '/Users/me/Documents/GitHub/canopy',
    pty: 7,
    ts: 1,
  }

  it('names the agent and the checkout, and asks the question', () => {
    const a = alertFor({ ...base, questions: [{ question: 'Merge or rebase?', options: [] }] })
    expect(a.title).toContain('Claude')
    expect(a.title).toContain('canopy')
    expect(a.body).toBe('Merge or rebase?')
    expect(a.urgent).toBe(true)
    expect(a.pty).toBe(7)
  })

  it('carries a permission request through as its message', () => {
    const a = alertFor({ ...base, kind: 'notification', message: 'claude needs permission: Bash' })
    expect(a.body).toBe('claude needs permission: Bash')
    expect(a.urgent).toBe(true)
  })

  it('marks a finished turn as not urgent', () => {
    // A finished agent is worth a line on the lock screen, not a buzz in your
    // pocket — conflating the two is how a channel gets muted for good.
    const a = alertFor({ ...base, kind: 'idle', message: 'Finished — waiting for you' })
    expect(a.urgent).toBe(false)
    expect(a.title).toContain('finished')
  })

  it('truncates a long body rather than shipping an essay to a lock screen', () => {
    const a = alertFor({ ...base, kind: 'idle', message: 'x'.repeat(500) })
    expect(a.body.length).toBe(180)
  })

  it('keys the alert by the pending item, so a re-derived card replaces it', () => {
    // The key becomes the Notification `tag`; without that, every poll would
    // stack another copy of the same question.
    expect(alertFor(base).key).toBe('k1')
  })
})

describe('taps are acknowledged before the network answers', () => {
  it('gives research and instruction rows a target the detail pane resolves', () => {
    // These two used to await an RPC and only then call `open`, so a tap did
    // nothing at all — no frame, no spinner — until the round trip finished.
    // Over a phone link that is seconds of an app that looks dead.
    const research: Target = { kind: 'research', projectId: 'p1', id: 'e1', title: 'Vault' }
    const doc: Target = { kind: 'doc', path: '/w/c/CLAUDE.md', roots: ['/w/c'], title: 'CLAUDE.md' }
    expect(targetKey(research)).toBe('research:p1:e1')
    expect(targetKey(doc)).toBe('doc:/w/c/CLAUDE.md')
    expect(tabLabel(research)).toBe('Vault')
    expect(tabLabel(doc)).toBe('CLAUDE.md')
  })

  it('keys two entries in one project apart', () => {
    const a: Target = { kind: 'research', projectId: 'p', id: 'a', title: 'A' }
    const b: Target = { kind: 'research', projectId: 'p', id: 'b', title: 'B' }
    expect(targetKey(a)).not.toBe(targetKey(b))
  })
})

// The shells may differ by input device and viewport. They may never differ by
// vocabulary — same icons, same order, same tokens, everywhere. This is the
// first half of that rule, written down where it can fail.
describe('the input aids follow the input device', () => {
  it('asks whether there is a keyboard, not merely whether the screen is wide', () => {
    // A landscape tablet is wide and has neither a keyboard nor a pointer. Gate
    // the composer on width alone and it renders a terminal it cannot type into.
    expect(KEYBOARD_QUERY).toContain('hover: hover')
    expect(KEYBOARD_QUERY).toContain('pointer: fine')
    expect(KEYBOARD_QUERY).toContain('min-width')
  })

  it('keeps the layout breakpoint a separate question from the input one', () => {
    // Which shell to render is about how much fits on screen; whether to show a
    // composer is about how the user types. Collapsing them is what put a phone
    // keyboard row under a laptop terminal in the first place.
    expect(WIDE_QUERY).not.toContain('pointer')
    expect(KEYBOARD_QUERY).not.toBe(WIDE_QUERY)
  })

  it('shows the composer and the control keys only without a keyboard', () => {
    // Asserted against the source because the alternative is mounting xterm in
    // jsdom. What matters is that ONE condition governs both aids and that it
    // is the keyboard one — two independent gates is how they drift apart.
    const src = readFileSync(join(process.cwd(), 'portal/src/views/Detail.tsx'), 'utf8')
    expect(src).toMatch(/const keyboard = useHardwareKeyboard\(\)/)
    expect(src).toMatch(/\{!keyboard && \(/)
    // Both aids sit inside that one gate, and the terminal takes the keyboard
    // exactly when they are absent.
    const gated = src.slice(src.indexOf('{!keyboard && ('))
    expect(gated).toContain('className="keys"')
    expect(gated).toContain('className="composer"')
    expect(src).toMatch(/autoFocus=\{keyboard\}/)
  })
})

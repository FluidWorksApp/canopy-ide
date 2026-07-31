// Files and Changes — the two panels the remote UX was most obviously missing.
//
// "What is the agent doing?" is answerable from a terminal. "What did it do to
// my repo?" is not, and that is the question you actually have on a phone.

import { useMemo, useState } from 'react'
import { IconDiff, IconFile, IconFolder, IconSearch } from '@shared/icons'
import { FileTree, type DirEntry } from '@shared/FileTree'
import '@shared/fileTree.css'
import { basename } from '@shared/model'
import { useAsync } from '../useAsync'
import { AsyncBody, Pill, Row, SubHead } from './ui'
import { repoOf, type PanelCtx, type PanelDef } from './types'

interface SearchHit {
  path: string
  line: number
  text: string
}

/** `git_status` (fsx.rs) — absolute paths and git's raw XY porcelain code. */
interface GitEntry {
  status: string
  path: string
}
interface GitStatus {
  is_repo: boolean
  branch?: string | null
  entries: GitEntry[]
}

/** Content search across the project's roots.
 *
 *  The portal's own control, not a port of anything: the desktop answers this
 *  with the ⌘K palette, which is a different interaction entirely. On a phone
 *  the search belongs on the panel it searches. */
function FileSearch({ ctx, roots }: { ctx: PanelCtx; roots: string[] }) {
  const [q, setQ] = useState('')
  const [live, setLive] = useState('')
  const hits = useAsync<SearchHit[]>(
    () =>
      live.trim().length < 2
        ? Promise.resolve([])
        : ctx.rpc.call<SearchHit[]>('fs_search', { roots, query: live, limit: 60 }),
    [live, roots.join('\n')],
  )
  return (
    <>
      <form
        className="panel-search"
        onSubmit={(e) => {
          e.preventDefault()
          setLive(q)
        }}
      >
        <IconSearch s={15} />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search this project…"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="search"
        />
      </form>
      {live.trim().length >= 2 && (
        <AsyncBody state={hits} empty={`Nothing matches “${live}”.`} skeletonRows={4}>
          {(rows) => (
            <>
              <SubHead title="Matches" n={rows.length} />
              {rows.map((h, i) => (
                <Row
                  key={`${h.path}:${h.line}:${i}`}
                  icon={<IconFile s={14} />}
                  title={basename(h.path)}
                  sub={<span className="mono">{h.text.trim().slice(0, 120)}</span>}
                  meta={<span className="mono dim">{h.line}</span>}
                  onClick={() => ctx.open({ kind: 'file', path: h.path })}
                />
              ))}
            </>
          )}
        </AsyncBody>
      )}
    </>
  )
}

export const filesPanel: PanelDef = {
  id: 'files',
  title: 'Files',
  Icon: IconFolder,
  scope: 'project',
  List({ ctx }) {
    const comps = ctx.project?.components ?? []
    const roots = useMemo(() => comps.map((c) => c.path), [comps])
    // The IDE's own tree, not a lookalike. `readOnly` switches off the git
    // overlay, the fs watcher and every mutation — which is exactly the remote
    // surface Rust grants, so the component and the permission agree. No
    // `iconUrl`: the desktop's set is 1250 bundled SVGs, and baking those into
    // the binary to pull over a mobile link is a bad trade.
    const fs = useMemo(
      () => ({ readDir: (path: string) => ctx.rpc.call<DirEntry[]>('fs_read_dir', { path }) }),
      [ctx.rpc],
    )
    if (!comps.length) return <div className="panel-empty">This project has no folders.</div>
    return (
      <>
        <FileSearch ctx={ctx} roots={roots} />
        <FileTree
          roots={roots}
          fs={fs}
          readOnly
          changedPaths={EMPTY}
          selectedPath={selectedPathOf(ctx)}
          onOpenFile={(path) => ctx.open({ kind: 'file', path })}
        />
      </>
    )
  },
}

/** No local git overlay on a remote tree — the Changes panel is where "what
 *  changed" is answered, and it asks the server. */
const EMPTY: Set<string> = new Set()

/** The file the detail pane is showing, so the tree marks its row the way the
 *  desktop marks the open tab's file. */
function selectedPathOf(ctx: PanelCtx): string | null {
  const key = ctx.openKey ?? ''
  return key.startsWith('file:') ? key.slice('file:'.length) : null
}

/**
 * git's two-letter porcelain code, said in words.
 *
 * X is the index, Y is the working tree. The pair is precise and unreadable; a
 * phone row has space for one word, so this picks the one that describes what
 * changed and lets the section heading carry staged-vs-not.
 */
export function statusWord(code: string): { word: string; tone: string } {
  const c = code.trim()
  if (c.startsWith('?')) return { word: 'new', tone: 'ok' }
  if (c.includes('D')) return { word: 'deleted', tone: 'danger' }
  if (c.includes('R')) return { word: 'renamed', tone: '' }
  if (c.includes('A')) return { word: 'added', tone: 'ok' }
  return { word: 'modified', tone: 'warn' }
}

/** True when the index column says this file has something staged. `??` is
 *  untracked, not staged, even though its first column is not a space. */
export function isStaged(code: string): boolean {
  const x = code[0] ?? ' '
  return x !== ' ' && x !== '?'
}

export const changesPanel: PanelDef = {
  id: 'changes',
  title: 'Changes',
  Icon: IconDiff,
  scope: 'project',
  List({ ctx }) {
    const repo = repoOf(ctx)
    const state = useAsync<GitStatus>(
      () =>
        repo
          ? ctx.rpc.call<GitStatus>('git_status', { path: repo })
          : Promise.reject(new Error('No repo in this project.')),
      [repo],
    )
    if (!repo) return <div className="panel-empty">This project has no git repo.</div>
    return (
      <AsyncBody state={state} empty="Working tree is clean.">
        {(status) => {
          const entries = status.entries ?? []
          if (!status.is_repo) return <div className="panel-empty">Not a git repo.</div>
          if (!entries.length) return <div className="panel-empty">Working tree is clean.</div>
          const staged = entries.filter((e) => isStaged(e.status))
          const unstaged = entries.filter((e) => !isStaged(e.status))
          const group = (rows: GitEntry[], inIndex: boolean) =>
            rows.map((f) => {
              const s = statusWord(f.status)
              return (
                <Row
                  key={`${inIndex}:${f.path}`}
                  on={ctx.openKey === `diff:${repo}:${f.path}:${inIndex}`}
                  icon={<IconFile s={14} />}
                  title={basename(f.path)}
                  sub={rel(f.path, repo)}
                  meta={<Pill tone={s.tone}>{s.word}</Pill>}
                  onClick={() => ctx.open({ kind: 'diff', repo, path: f.path, staged: inIndex })}
                />
              )
            })
          return (
            <>
              {status.branch && (
                <div className="panel-note mono">⑂ {status.branch}</div>
              )}
              {staged.length > 0 && (
                <>
                  <SubHead title="Staged" n={staged.length} />
                  {group(staged, true)}
                </>
              )}
              {unstaged.length > 0 && (
                <>
                  <SubHead title="Working tree" n={unstaged.length} />
                  {group(unstaged, false)}
                </>
              )}
            </>
          )
        }}
      </AsyncBody>
    )
  },
}

/** An absolute path shown relative to the repo — the full one is mostly the
 *  user's home directory repeated on every row. */
export function rel(path: string, root: string): string {
  const r = root.replace(/\/+$/, '')
  return path.startsWith(r + '/') ? path.slice(r.length + 1) : path
}

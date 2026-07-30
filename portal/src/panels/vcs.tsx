// Git and pull requests. Read-only, on purpose: `git_checkout`, `git_commit`,
// `git_push` and `gh_pr_review` are all absent from the Rust grant table, so
// there is no affordance here that the server would refuse — the panel and the
// permission agree.

import { useState } from 'react'
import { IconBranch, IconGit, IconPr } from '@shared/icons'
import { useAsync } from '../useAsync'
import { AsyncBody, Pill, Row, SubHead } from './ui'
import { repoOf, type PanelCtx, type PanelDef } from './types'

// These mirror the Rust structs exactly (git.rs). Written out rather than
// loosely typed because a field renamed in Rust should break this file at
// compile time, not render a blank column on someone's phone.
interface BranchInfo {
  name: string
  current: boolean
  remote_only: boolean
  synced: boolean
  subject: string
  protected: boolean
}

interface CommitInfo {
  hash: string
  short: string
  author: string
  date: string
  subject: string
  refs: string
}

interface WorktreeInfo {
  path: string
  name: string
  branch?: string | null
  is_main: boolean
  dirty: number
  detached?: boolean
}

interface PrInfo {
  number: number
  title: string
  author: string
  branch: string
  base: string
  draft: boolean
  state: string
  review_decision: string
  additions: number
  deletions: number
  mergeable: string
  checks: string
  checks_summary: string
}

type GitTab = 'branches' | 'commits' | 'worktrees'

export const gitPanel: PanelDef = {
  id: 'git',
  title: 'Git',
  Icon: IconGit,
  scope: 'project',
  List({ ctx }) {
    const repo = repoOf(ctx)
    if (!repo) return <div className="panel-empty">This project has no git repo.</div>
    return <GitBody ctx={ctx} repo={repo} />
  },
}

function GitBody({ ctx, repo }: { ctx: PanelCtx; repo: string }) {
  const [tab, setTab] = useState<GitTab>('branches')
  return (
    <>
      <div className="segmented tight" role="tablist">
        {(['branches', 'commits', 'worktrees'] as GitTab[]).map((t) => (
          <button key={t} role="tab" className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
            {t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      {tab === 'branches' && <Branches ctx={ctx} repo={repo} />}
      {tab === 'commits' && <Commits ctx={ctx} repo={repo} />}
      {tab === 'worktrees' && <Worktrees ctx={ctx} repo={repo} />}
    </>
  )
}

function Branches({ ctx, repo }: { ctx: PanelCtx; repo: string }) {
  const state = useAsync<BranchInfo[]>(() => ctx.rpc.call('git_branches', { repo }), [repo])
  return (
    <AsyncBody state={state} empty="No branches.">
      {(branches) => (
        <>
          {branches.map((b) => (
            <Row
              key={b.name}
              icon={<IconBranch s={14} />}
              title={<span className="mono">{b.name}</span>}
              sub={b.subject}
              meta={
                <>
                  {b.current && <Pill tone="ok">current</Pill>}
                  {b.protected && <Pill>base</Pill>}
                  {b.remote_only && <Pill tone="dim">remote</Pill>}
                </>
              }
            />
          ))}
        </>
      )}
    </AsyncBody>
  )
}

function Commits({ ctx, repo }: { ctx: PanelCtx; repo: string }) {
  const state = useAsync<CommitInfo[]>(
    () => ctx.rpc.call('git_log', { repo, limit: 60 }),
    [repo],
  )
  return (
    <AsyncBody state={state} empty="No commits.">
      {(commits) => (
        <>
          {commits.map((c) => (
            <Row
              key={c.hash}
              on={ctx.openKey === `commit:${repo}:${c.hash}`}
              title={c.subject}
              sub={[c.author, c.date].filter(Boolean).join(' · ')}
              meta={<span className="mono dim">{c.short}</span>}
              onClick={() =>
                ctx.open({ kind: 'commit', repo, hash: c.hash, subject: c.subject })
              }
            />
          ))}
        </>
      )}
    </AsyncBody>
  )
}

function Worktrees({ ctx, repo }: { ctx: PanelCtx; repo: string }) {
  const state = useAsync<WorktreeInfo[]>(() => ctx.rpc.call('git_worktrees', { repo }), [repo])
  return (
    <AsyncBody state={state} empty="No worktrees.">
      {(trees) => (
        <>
          {trees.map((w) => {
            // Agents whose cwd is inside this worktree. This is the join the
            // desktop makes too — a worktree is only interesting because of who
            // is working in it.
            const here = ctx.rows.filter((r) => (r.cwd ?? '').startsWith(w.path))
            return (
              <Row
                key={w.path}
                icon={<IconBranch s={14} />}
                title={<span className="mono">{w.branch ?? w.name}</span>}
                sub={w.path}
                meta={
                  <>
                    {w.is_main && <Pill>main</Pill>}
                    {w.dirty > 0 && <Pill tone="warn">{w.dirty} dirty</Pill>}
                    {here.length > 0 && <Pill tone="ok">{here.length} agent</Pill>}
                  </>
                }
              />
            )
          })}
        </>
      )}
    </AsyncBody>
  )
}

export const prsPanel: PanelDef = {
  id: 'prs',
  title: 'Pull requests',
  Icon: IconPr,
  scope: 'project',
  List({ ctx }) {
    const repo = repoOf(ctx)
    const state = useAsync<PrInfo[]>(
      () =>
        repo
          ? ctx.rpc.call<PrInfo[]>('gh_pr_list', { repo })
          : Promise.reject(new Error('No repo in this project.')),
      [repo],
    )
    if (!repo) return <div className="panel-empty">This project has no git repo.</div>
    return (
      <AsyncBody state={state} empty="No open pull requests.">
        {(prs) => (
          <>
            <SubHead title="Open" n={prs.length} />
            {prs.map((pr) => (
              <Row
                key={pr.number}
                on={ctx.openKey === `pr:${repo}:${pr.number}`}
                icon={<IconPr s={15} />}
                title={pr.title}
                sub={
                  <>
                    <span className="mono">#{pr.number}</span>
                    {pr.branch ? ` · ${pr.branch}` : ''}
                    {pr.author ? ` · ${pr.author}` : ''}
                  </>
                }
                meta={
                  <>
                    {pr.draft && <Pill>draft</Pill>}
                    {pr.checks === 'FAIL' && <Pill tone="danger">checks</Pill>}
                    {pr.checks === 'PENDING' && <Pill tone="warn">running</Pill>}
                    {pr.mergeable === 'CONFLICTING' && <Pill tone="danger">conflict</Pill>}
                    {pr.review_decision === 'APPROVED' && <Pill tone="ok">approved</Pill>}
                    {pr.review_decision === 'CHANGES_REQUESTED' && (
                      <Pill tone="warn">changes</Pill>
                    )}
                    <span className="mono dim">
                      +{pr.additions}/−{pr.deletions}
                    </span>
                  </>
                }
                onClick={() => ctx.open({ kind: 'pr', repo, number: pr.number, title: pr.title })}
              />
            ))}
          </>
        )}
      </AsyncBody>
    )
  },
}

// The detail pane: one component per Target kind, and one switch.
//
// Panels never render their own detail. That is what lets the same panel list
// drive two shells — on a wide screen the detail is the right-hand pane, on a
// phone it is the pushed screen, and neither the panel nor this file knows
// which.

import { useState } from 'react'
import { AgentTerminal } from '@shared/AgentTerminal'
import { AgentBadge } from '@shared/components'
import { IconBack, IconBranch, IconFile, IconSend, IconStop, IconTerminal } from '@shared/icons'
import { agentMeta, basename, resumeCommand, type AgentRow } from '@shared/model'
import { useAsync } from '../useAsync'
import { AsyncBody } from '../panels/ui'
import type { PanelCtx, Target } from '../panels/types'
import { DiffText } from './Diff'

/** `fs_read_file`'s remote projection — text, capped, and honest about it. */
interface FileText {
  binary: boolean
  bytes: number
  truncated?: boolean
  text?: string
}

// Both mirror git.rs exactly.
interface CommitDetail {
  hash: string
  short: string
  author: string
  email: string
  date: string
  subject: string
  body: string
  refs: string
  parents: string[]
}

interface CommitPatch {
  patch: string
  files_changed: number
  insertions: number
  deletions: number
  truncated: boolean
}

export function Detail({
  ctx,
  target,
  onBack,
  showBack,
}: {
  ctx: PanelCtx
  target: Target
  onBack: () => void
  showBack: boolean
}) {
  switch (target.kind) {
    case 'terminal':
      return <TerminalDetail ctx={ctx} pty={target.pty} onBack={onBack} showBack={showBack} />
    case 'history':
      return <HistoryDetail ctx={ctx} rowKey={target.key} onBack={onBack} showBack={showBack} />
    case 'file':
      return <FileDetail ctx={ctx} path={target.path} onBack={onBack} showBack={showBack} />
    case 'diff':
      return (
        <Frame
          title={basename(target.path)}
          subtitle={target.staged ? 'staged' : 'working tree'}
          onBack={onBack}
          showBack={showBack}
        >
          <Patch
            load={() =>
              ctx.rpc.call<string>('git_diff', {
                repo: target.repo,
                path: target.path,
                staged: target.staged,
              })
            }
            deps={[target.repo, target.path, target.staged]}
          />
        </Frame>
      )
    case 'commit':
      return <CommitDetailView ctx={ctx} target={target} onBack={onBack} showBack={showBack} />
    case 'pr':
      return <PrDetail ctx={ctx} target={target} onBack={onBack} showBack={showBack} />
    case 'text':
      return (
        <Frame
          title={target.title}
          subtitle={target.subtitle}
          onBack={onBack}
          showBack={showBack}
        >
          <pre className={`doc ${target.mono ? 'mono' : ''}`}>{target.body}</pre>
        </Frame>
      )
  }
}

/** The shared chrome: a back affordance that only exists where back means
 *  something (a phone's stack), a title, and a scrolling body. */
function Frame({
  title,
  subtitle,
  badge,
  actions,
  onBack,
  showBack,
  children,
  flush,
}: {
  title: string
  subtitle?: React.ReactNode
  badge?: React.ReactNode
  actions?: React.ReactNode
  onBack: () => void
  showBack: boolean
  children: React.ReactNode
  /** Terminals own their own scrolling and must not be padded. */
  flush?: boolean
}) {
  return (
    <div className="detail">
      <header className="bar detail-bar">
        {showBack && (
          <button className="iconbtn back" onClick={onBack} aria-label="Back">
            <IconBack s={19} />
          </button>
        )}
        {badge}
        <div className="detail-title">
          <span className="detail-name">{title}</span>
          {subtitle && <span className="detail-sub">{subtitle}</span>}
        </div>
        {actions}
      </header>
      <div className={`detail-body ${flush ? 'flush' : ''}`}>{children}</div>
    </div>
  )
}

function Patch({ load, deps }: { load: () => Promise<string>; deps: unknown[] }) {
  const state = useAsync<string>(load, deps)
  return (
    <AsyncBody state={state} empty="No changes.">
      {(patch) => <DiffText patch={patch} />}
    </AsyncBody>
  )
}

function FileDetail({
  ctx,
  path,
  onBack,
  showBack,
}: {
  ctx: PanelCtx
  path: string
  onBack: () => void
  showBack: boolean
}) {
  const state = useAsync<FileText>(() => ctx.rpc.call<FileText>('fs_read_file', { path }), [path])
  return (
    <Frame title={basename(path)} subtitle={path} onBack={onBack} showBack={showBack}>
      <AsyncBody state={state} empty="Empty file.">
        {(f) =>
          f.binary ? (
            <div className="panel-empty">
              Binary file ({Math.round(f.bytes / 1024)} KB) — nothing to show.
            </div>
          ) : (
            <>
              {f.truncated && (
                <div className="panel-note">
                  Showing the first 512 KB of {Math.round(f.bytes / 1024)} KB.
                </div>
              )}
              <pre className="code mono">{f.text}</pre>
            </>
          )
        }
      </AsyncBody>
    </Frame>
  )
}

function CommitDetailView({
  ctx,
  target,
  onBack,
  showBack,
}: {
  ctx: PanelCtx
  target: Extract<Target, { kind: 'commit' }>
  onBack: () => void
  showBack: boolean
}) {
  const meta = useAsync<CommitDetail>(
    () => ctx.rpc.call<CommitDetail>('git_commit_detail', { repo: target.repo, hash: target.hash }),
    [target.repo, target.hash],
  )
  const patch = useAsync<CommitPatch>(
    () => ctx.rpc.call<CommitPatch>('git_commit_patch', { repo: target.repo, hash: target.hash }),
    [target.repo, target.hash],
  )
  return (
    <Frame
      title={target.subject}
      subtitle={<span className="mono">{target.hash.slice(0, 10)}</span>}
      onBack={onBack}
      showBack={showBack}
    >
      <AsyncBody state={meta} empty="">
        {(c) => (
          <div className="commit-meta">
            <span>{c.author}</span>
            <span className="dim">{c.date}</span>
            {c.body && <pre className="doc">{c.body}</pre>}
          </div>
        )}
      </AsyncBody>
      <AsyncBody state={patch} empty="No patch.">
        {(p) => (
          <>
            {p.truncated && (
              <div className="panel-note">
                This patch was truncated by the server ({p.files_changed} files, +{p.insertions}/−
                {p.deletions}).
              </div>
            )}
            <DiffText patch={p.patch} />
          </>
        )}
      </AsyncBody>
    </Frame>
  )
}

function PrDetail({
  ctx,
  target,
  onBack,
  showBack,
}: {
  ctx: PanelCtx
  target: Extract<Target, { kind: 'pr' }>
  onBack: () => void
  showBack: boolean
}) {
  const [tab, setTab] = useState<'body' | 'diff'>('body')
  const body = useAsync<string>(
    () => ctx.rpc.call<string>('gh_pr_body', { repo: target.repo, number: target.number }),
    [target.repo, target.number],
  )
  return (
    <Frame
      title={target.title}
      subtitle={<span className="mono">#{target.number}</span>}
      onBack={onBack}
      showBack={showBack}
    >
      <div className="segmented tight" role="tablist">
        <button role="tab" className={tab === 'body' ? 'on' : ''} onClick={() => setTab('body')}>
          Description
        </button>
        <button role="tab" className={tab === 'diff' ? 'on' : ''} onClick={() => setTab('diff')}>
          Diff
        </button>
      </div>
      {tab === 'body' ? (
        <AsyncBody state={body} empty="This pull request has no description.">
          {(text) => <pre className="doc">{text}</pre>}
        </AsyncBody>
      ) : (
        <Patch
          load={() =>
            ctx.rpc.call<string>('gh_pr_diff', { repo: target.repo, number: target.number })
          }
          deps={[target.repo, target.number]}
        />
      )}
    </Frame>
  )
}

/** Control keys a phone keyboard has no room for, and an agent TUI needs. */
const KEYS: [string, string][] = [
  ['esc', '\x1b'],
  ['tab', '\t'],
  ['^C', '\x03'],
  ['↑', '\x1b[A'],
  ['↓', '\x1b[B'],
  ['⏎', '\r'],
]

function TerminalDetail({
  ctx,
  pty,
  onBack,
  showBack,
}: {
  ctx: PanelCtx
  pty: number
  onBack: () => void
  showBack: boolean
}) {
  const [text, setText] = useState('')
  const row = ctx.rows.find((r) => r.ptyId === pty)
  const m = agentMeta(row?.agent ?? 'shell')

  const send = () => {
    if (!text) return
    // Enter has to be its own write, a beat after the text: TUIs like Codex read
    // a burst ending in \r as a paste and drop a literal newline in the composer
    // instead of submitting, so "text\r" in one write left the message sitting
    // there waiting on a second Enter. Same two-write pattern (and delay) the
    // desktop uses to message an agent.
    ctx.transport.writePty(pty, text)
    setTimeout(() => ctx.transport.writePty(pty, '\r'), 350)
    setText('')
  }

  return (
    <Frame
      title={row?.terminal ? (row.title ?? 'Terminal') : m.label}
      subtitle={
        row?.branch ? (
          <span className="mono">
            <IconBranch s={11} /> {row.branch}
          </span>
        ) : (
          <span className="mono">{basename(row?.cwd)}</span>
        )
      }
      badge={<AgentBadge agent={row?.agent ?? 'shell'} sz={28} />}
      actions={
        <button
          className="danger sm"
          onClick={() => {
            // Terminate, then leave — the row drops off "Active" as its pty:exit
            // propagates. Without the navigation the kill fired silently and the
            // button read as dead.
            ctx.transport.killPty(pty)
            onBack()
          }}
        >
          <IconStop s={13} /> Stop
        </button>
      }
      onBack={onBack}
      showBack={showBack}
      flush
    >
      <div className="term-wrap">
        <AgentTerminal transport={ctx.transport} pty={pty} />
      </div>
      <div className="keys">
        {KEYS.map(([label, data]) => (
          <button key={label} onClick={() => ctx.transport.writePty(pty, data)}>
            {label}
          </button>
        ))}
      </div>
      <form
        className="composer"
        autoComplete="off"
        onSubmit={(e) => {
          e.preventDefault()
          send()
        }}
      >
        {/* A bare text input in a form reads to Chrome as a fillable field, so
         *  Android floated its passwords/cards/addresses strip over the
         *  composer. Naming it, opting out of autofill and declaring it plain
         *  text takes the field out of those heuristics. */}
        <input
          type="text"
          name="canopy-message"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={row?.terminal ? 'Run a command…' : 'Message the agent…'}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="send"
          data-form-type="other"
          data-lpignore="true"
          data-1p-ignore
        />
        <button className="primary send" type="submit" aria-label="Send">
          <IconSend s={18} />
        </button>
      </form>
    </Frame>
  )
}

function HistoryDetail({
  ctx,
  rowKey,
  onBack,
  showBack,
}: {
  ctx: PanelCtx
  rowKey: string
  onBack: () => void
  showBack: boolean
}) {
  const row = ctx.rows.find((r) => r.key === rowKey)
  if (!row) {
    return (
      <Frame title="Session" onBack={onBack} showBack={showBack}>
        <div className="panel-empty">That session is no longer in the list.</div>
      </Frame>
    )
  }
  const m = agentMeta(row.agent)
  const prompts = (row.prompts ?? []).filter((p) => p.trim() && !p.trim().startsWith('<'))
  return (
    <Frame
      title={m.label}
      subtitle={
        row.branch ? (
          <span className="mono">
            <IconBranch s={11} /> {row.branch}
          </span>
        ) : (
          <span className="mono">{basename(row.cwd)}</span>
        )
      }
      badge={<AgentBadge agent={row.agent} sz={28} />}
      actions={<ResumeButton ctx={ctx} row={row} />}
      onBack={onBack}
      showBack={showBack}
    >
      <div className="sect-head">
        <IconTerminal s={13} /> Conversation <span className="subhead-n">{prompts.length}</span>
      </div>
      {prompts.length === 0 ? (
        <div className="panel-empty">No saved prompts for this session.</div>
      ) : (
        prompts.map((p, i) => (
          <div className="hprompt" key={i}>
            {p}
          </div>
        ))
      )}
      {row.files && row.files.length > 0 && (
        <>
          <div className="sect-head">
            <IconFile s={13} /> Files touched <span className="subhead-n">{row.files.length}</span>
          </div>
          <div className="hfiles">
            {row.files.map((f, i) => (
              <button
                className="hfile"
                key={i}
                onClick={() => ctx.open({ kind: 'file', path: f })}
              >
                <IconFile s={13} />
                <code className="mono">{f}</code>
              </button>
            ))}
          </div>
        </>
      )}
    </Frame>
  )
}

function ResumeButton({ ctx, row }: { ctx: PanelCtx; row: AgentRow }) {
  if (!row.resumeCwd) return null
  return (
    <button
      className="primary sm"
      // resumeCommand lives in shared/model, so the phone and the desktop revive
      // a session with the same CLI incantation.
      onClick={() => ctx.spawn(row.resumeCwd!, resumeCommand(row.agent, row.sessionId))}
    >
      Resume
    </button>
  )
}

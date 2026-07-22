// Presentational components shared by both shells. Pure and transport-agnostic:
// they take already-fused data plus callbacks, and render. No invoke, no fetch,
// no WebSocket. Styles live in agents.css (imported by whichever shell mounts
// them) and are driven entirely by Canopy's theme CSS variables.

import type { ReactNode } from 'react'
import { type AgentRow, type Project, STATE_LABEL, basename, fmtTokens } from './model'

export function StatusDot({ state }: { state: string }) {
  return <span className={`dot ${state}`} />
}

export function Chip({ children, mono }: { children: ReactNode; mono?: boolean }) {
  return <span className={`chip ${mono ? 'mono' : ''}`}>{children}</span>
}

export function Metric({ n, label, tone }: { n: number; label: string; tone?: string }) {
  return (
    <div className="metric">
      <span className={`metric-n ${tone ?? ''}`}>{n}</span>
      <span className="metric-l">{label}</span>
    </div>
  )
}

/** One agent, dense and status-forward. `onOpen` fires only when live/attachable
 *  (offline rows render dimmed and inert). `trailing` lets a shell graft extra
 *  actions (the desktop's approve/deny) without forking the card. */
export function AgentCard({
  row,
  index = 0,
  onOpen,
  trailing,
}: {
  row: AgentRow
  index?: number
  onOpen?: () => void
  trailing?: ReactNode
}) {
  const clickable = !!onOpen
  return (
    <button
      className={`card agent state-${row.state} ${row.live ? 'on' : 'off'} ${row.needsYou ? 'attn' : ''}`}
      style={{ ['--i' as string]: index }}
      onClick={onOpen}
      disabled={!clickable}
    >
      <div className="agent-main">
        <div className="agent-top">
          <StatusDot state={row.state} />
          <span className="agent-name">{row.agent}</span>
          {row.branch && <Chip mono>⎇ {row.branch}</Chip>}
          <span className={`agent-state ${row.needsYou ? 'warn' : ''}`}>
            {row.live ? STATE_LABEL[row.state] ?? row.state : 'idle'}
          </span>
          {trailing}
          {clickable && <span className="chev">›</span>}
        </div>
        {row.lastPrompt && <div className="agent-prompt">{row.lastPrompt}</div>}
        <div className="agent-meta">
          {row.cwd && <span className="mono">{basename(row.cwd)}</span>}
          {row.live && row.cpu !== undefined && <span className="mono">{Math.round(row.cpu)}%</span>}
          {row.tokens ? <span className="mono">{fmtTokens(row.tokens)} tok</span> : null}
        </div>
      </div>
    </button>
  )
}

/** One project, with a glance at its agent activity. */
export function ProjectCard({
  project,
  agents,
  index = 0,
  onOpen,
}: {
  project: Project
  agents: AgentRow[]
  index?: number
  onOpen?: () => void
}) {
  const liveN = agents.filter((r) => r.live).length
  const needs = agents.some((r) => r.needsYou)
  return (
    <button className="card project" style={{ ['--i' as string]: index }} onClick={onOpen}>
      <div className="project-head">
        <span className="project-name">{project.name}</span>
        {needs && <span className="pill warn">needs you</span>}
        {liveN > 0 ? (
          <span className="pill ok">
            <span className="dot working" />
            {liveN} live
          </span>
        ) : agents.length > 0 ? (
          <span className="pill muted">{agents.length}</span>
        ) : null}
        {onOpen && <span className="chev">›</span>}
      </div>
      <div className="chips">
        {(project.components ?? []).map((c, j) => (
          <Chip key={j}>{c.label}</Chip>
        ))}
      </div>
    </button>
  )
}

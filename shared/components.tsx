// Presentational components shared by both shells. Pure and transport-agnostic:
// they take already-fused data plus callbacks, and render. No invoke, no fetch,
// no WebSocket. Styles live in agents.css (imported by whichever shell mounts
// them); the app chrome follows Canopy's theme CSS variables, while each agent
// carries its own brand hue (its identity, not the app's) so a list of agents
// reads as distinct faces instead of one grey column.

import type { ReactNode } from 'react'
import {
  type AgentRow,
  type Project,
  STATE_LABEL,
  agentMeta,
  basename,
  fmtTokens,
} from './model'
import { formatDuration, formatDurationWords, hasWorkingTime, workingTime } from './agentDuration'
import {
  IconBranch,
  IconChevron,
  IconCpu,
  IconFolder,
  IconStopwatch,
  IconToken,
} from './icons'
import { AgentGlyph } from './agentGlyphs'

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

/** The colour-carrying identity mark for an agent: a rounded annunciator tile
 *  tinted with the agent's brand hue and stamped with its glyph. This is the
 *  single loudest bit of colour in the list — what turns a wall of rows into a
 *  scannable panel. `sz` lets a project card show a denser cluster of them. */
export function AgentBadge({ agent, sz = 34 }: { agent: string; sz?: number }) {
  const m = agentMeta(agent)
  return (
    <span className="abadge" style={{ width: sz, height: sz }} title={m.label}>
      <AgentGlyph agent={agent} s={Math.round(sz * 0.62)} />
    </span>
  )
}

/** A small icon + value telemetry cell (folder, cpu, tokens). `title` is for a
 *  cell whose number needs spelling out — "12:07" is compact, not obvious. */
function Telem({
  icon,
  title,
  children,
}: {
  icon: ReactNode
  title?: string
  children: ReactNode
}) {
  return (
    <span className="telem" title={title}>
      {icon}
      <span className="mono">{children}</span>
    </span>
  )
}

/** One agent, status-forward and colour-coded by its brand. `onOpen` fires only
 *  when clickable. `trailing` lets a shell graft extra actions (the desktop's
 *  approve/deny) without forking the card. */
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
  const m = agentMeta(row.agent)
  // A terminal has no hook behind it, so "idle"/"working" would be a guess.
  // Say what it is instead, and show its title where a prompt would go.
  const stateLabel = row.terminal
    ? 'terminal'
    : row.live
      ? STATE_LABEL[row.state] ?? row.state
      : 'idle'
  // Working time: this stretch, and what the session has done in total. Only a
  // live, working row keeps counting past its last hook event — see
  // agentDuration.ts for why a stopped agent must freeze instead.
  const work = workingTime(
    { active_secs: row.activeSecs, run_secs: row.runSecs, updated: row.updated },
    Date.now() / 1000,
    row.live && row.state === 'working',
  )
  return (
    <button
      className={`card agent state-${row.state} ${row.live ? 'on' : 'off'} ${
        row.needsYou ? 'attn' : ''
      } ${row.terminal ? 'term-row' : ''}`}
      style={{ ['--i' as string]: index, ['--hue' as string]: m.hue }}
      onClick={onOpen}
      disabled={!clickable}
    >
      <span className={`agent-card-rail ${row.live ? row.state : 'ended'}`} />
      <AgentBadge agent={row.agent} />
      <div className="agent-main">
        <div className="agent-top">
          <span className="agent-name">{m.label}</span>
          {row.branch && (
            <span className="chip mono branch">
              <IconBranch s={12} /> <span className="chip-t">{row.branch}</span>
            </span>
          )}
          <span className={`annun ${row.needsYou ? 'warn' : `s-${row.live ? row.state : 'idle'}`}`}>
            {!row.terminal && <StatusDot state={row.live ? row.state : 'idle'} />}
            {stateLabel}
          </span>
          {trailing}
          {clickable && <IconChevron s={17} className="chev" />}
        </div>
        {row.lastPrompt ? (
          <div className="agent-prompt">{row.lastPrompt}</div>
        ) : row.title ? (
          <div className="agent-prompt mono">{row.title}</div>
        ) : null}
        <div className="agent-meta">
          {row.cwd && (
            <Telem icon={<IconFolder s={13} />}>{basename(row.cwd)}</Telem>
          )}
          {row.live && row.cpu !== undefined && (
            <Telem icon={<IconCpu s={13} />}>{Math.round(row.cpu)}%</Telem>
          )}
          {row.tokens ? (
            <Telem icon={<IconToken s={13} />}>{fmtTokens(row.tokens)}</Telem>
          ) : null}
          {hasWorkingTime(work) && (
            <Telem
              icon={<IconStopwatch s={13} />}
              title={[
                work.run > 0 && work.run !== work.total
                  ? `Working for ${formatDurationWords(work.run)} without a break`
                  : '',
                `${formatDurationWords(work.total)} of work in this session`,
                'Time spent idle or waiting on you is not counted',
              ]
                .filter(Boolean)
                .join('\n')}
            >
              {work.run > 0 && work.run !== work.total
                ? `${formatDuration(work.run)} · ${formatDuration(work.total)}`
                : formatDuration(work.total)}
            </Telem>
          )}
        </div>
      </div>
    </button>
  )
}

/** One project, with a glanceable cluster of its agents' brand badges. */
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
  // Distinct agent kinds present, live first — the badge cluster.
  const kinds = [...new Set(agents.map((a) => a.agent))].slice(0, 6)
  return (
    <button className="card project" style={{ ['--i' as string]: index }} onClick={onOpen}>
      <div className="project-head">
        <span className="project-name">{project.name}</span>
        {needs ? (
          <span className="pill warn">
            <span className="dot waiting" /> needs you
          </span>
        ) : liveN > 0 ? (
          <span className="pill ok">
            <span className="dot working" /> {liveN} live
          </span>
        ) : agents.length > 0 ? (
          <span className="pill muted">{agents.length} idle</span>
        ) : (
          <span className="pill muted">empty</span>
        )}
        {onOpen && <IconChevron s={17} className="chev" />}
      </div>
      {kinds.length > 0 && (
        <div className="agent-cluster">
          {kinds.map((k) => (
            <AgentBadge key={k} agent={k} sz={22} />
          ))}
          {agents.length > kinds.length && (
            <span className="cluster-more">+{agents.length - kinds.length}</span>
          )}
        </div>
      )}
      <div className="chips">
        {(project.components ?? []).map((c, j) => (
          <span className="chip" key={j}>
            <IconFolder s={12} /> {c.label}
          </span>
        ))}
      </div>
    </button>
  )
}

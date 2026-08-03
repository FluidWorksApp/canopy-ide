import { useEffect, useMemo, useState } from 'react'
import { AgentBadge } from '@shared/components'
import {
  agentsForProject,
  basename,
  type Digest,
  type RemoteCli,
} from '@shared/model'
import { restorableSessions, type RestorableSession } from '@shared/restorable'
import { IconClose, IconFolder, IconPlus, IconTerminal } from '@shared/icons'
import type { PanelCtx } from './panels/types'
import { useAsync } from './useAsync'

const FORGOTTEN_KEY = 'canopy:remote:forgotten-sessions'

function readForgotten(): Record<string, number> {
  try { return JSON.parse(localStorage.getItem(FORGOTTEN_KEY) ?? '{}') }
  catch { return {} }
}

function age(ts?: number): string {
  if (!ts) return ''
  const seconds = Math.max(0, Date.now() / 1000 - ts)
  if (seconds < 60) return 'now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86400)}d`
}

export function ProjectHome({
  ctx,
  clis,
  compact = false,
  onNewAgent,
}: {
  ctx: PanelCtx
  clis: RemoteCli[]
  compact?: boolean
  onNewAgent: () => void
}) {
  const project = ctx.project
  const roots = useMemo(() => project?.components.map((component) => component.path) ?? [], [project])
  const history = useAsync<Digest[]>(
    () => (roots.length ? ctx.rpc.call('session_digests', { roots }) : Promise.resolve([])),
    [project?.id, roots.join('\0')],
  )
  const repo = project?.components[0]?.path
  const git = useAsync<{ is_repo: boolean; branch?: string | null; entries: unknown[] }>(
    () => repo ? ctx.rpc.call('git_status', { path: repo }) : Promise.resolve({ is_repo: false, entries: [] }),
    [repo],
  )
  const rows = useMemo(
    () => project ? agentsForProject(project, ctx.rows, ctx.projects) : [],
    [project, ctx.rows, ctx.projects],
  )
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const [forgotten, setForgotten] = useState(readForgotten)
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const restorables = useMemo(
    () =>
      project
        ? restorableSessions(history.data ?? [], rows, clis, project, ctx.projects, forgotten)
        : [],
    [history.data, rows, clis, project, ctx.projects, forgotten],
  )
  useEffect(() => {
    setHidden(new Set())
    setChosen(new Set())
  }, [project?.id])
  const visible = restorables.filter((item) => !hidden.has(item.digest.session_id!))
  const liveAgents = rows.filter((row) => row.live && !row.terminal)
  const terminals = rows.filter((row) => row.live && row.terminal)
  const waiting = liveAgents.filter((row) => row.needsYou).length
  const working = liveAgents.filter((row) => row.state === 'working').length

  const restore = (items: RestorableSession[]) => {
    setHidden((before) => new Set([...before, ...items.map((item) => item.digest.session_id!)]))
    setChosen(new Set())
    for (const item of items) {
      ctx.spawn(item.cwd, item.command, { agent: item.agentId, profile: item.profile })
    }
  }
  const forget = async (items: RestorableSession[]) => {
    const ids = items.flatMap((item) => [item.digest, ...item.superseded])
      .map((digest) => digest.session_id)
      .filter((id): id is string => !!id)
    setHidden((before) => new Set([...before, ...items.map((item) => item.digest.session_id!)]))
    setForgotten((before) => {
      const next = { ...before }
      for (const id of ids) next[id] = Date.now() / 1000
      localStorage.setItem(FORGOTTEN_KEY, JSON.stringify(next))
      return next
    })
    setChosen(new Set())
    await Promise.allSettled(ids.map((sessionId) => ctx.rpc.call('session_forget', { sessionId })))
  }

  if (!project) return <div className="panel-empty">Open a project in Canopy to use Remote.</div>
  return (
    <main className={`project-home ${compact ? 'compact-home' : ''}`}>
      <div className="home-head">
        <div>
          <span className="home-kicker">Remote workspace</span>
          <h1>{project.name}</h1>
          <div className="home-components">
            {project.components.map((component) => (
              <span className="home-component" key={component.path} title={component.path}>
                <IconFolder s={12} /> {component.label}
              </span>
            ))}
          </div>
        </div>
        <button className="primary sm" onClick={onNewAgent}>
          <IconPlus s={15} /> New agent
        </button>
      </div>

      <div className="home-summary" aria-label="Project status">
        {git.data?.is_repo && <span><strong>{git.data.branch || 'detached'}</strong> branch</span>}
        {git.data?.is_repo && <span><strong>{git.data.entries.length}</strong> changes</span>}
        <span className={waiting ? 'hot' : ''}><strong>{waiting}</strong> needs you</span>
        <span><strong>{working}</strong> working</span>
        <span><strong>{liveAgents.length}</strong> agents</span>
        <span><strong>{terminals.length}</strong> terminals</span>
        <span><strong>{visible.length}</strong> resumable</span>
      </div>

      <section className="home-section">
        <div className="home-section-head">
          <div>
            <span className="home-kicker">Start something</span>
            <h2>Launch</h2>
          </div>
        </div>
        <div className="home-launch-grid">
          <button className="home-launch-card" onClick={() => ctx.spawn(project.components[0]?.path)}>
            <IconTerminal s={27} /><span>Shell</span>
          </button>
          {clis.map((cli) => (
            <button
              className="home-launch-card"
              key={cli.id}
              disabled={!cli.available}
              title={cli.available ? cli.command : `${cli.name} is not installed`}
              onClick={() => {
                if (project.components.length === 1) {
                  ctx.spawn(project.components[0].path, cli.command, { agent: cli.id })
                }
                else onNewAgent()
              }}
            >
              <AgentBadge agent={cli.id} sz={29} />
              <span>{cli.name}</span>
              {!cli.available && <small>not found</small>}
            </button>
          ))}
        </div>
      </section>

      <section className="home-section home-resume">
        <div className="home-section-head">
          <div>
            <span className="home-kicker">Continue</span>
            <h2>Pick up where you left off <span className="home-count">{visible.length}</span></h2>
          </div>
          {visible.length > 0 && (
            <div className="home-actions">
              <button className="ghost" onClick={() => void forget(visible)} title="Forget every session below">
                Forget all
              </button>
              <button className="primary sm" onClick={() => restore(chosen.size ? visible.filter((item) => chosen.has(item.digest.session_id!)) : visible)}>
                {chosen.size ? `Restore selected (${chosen.size})` : 'Restore all'}
              </button>
            </div>
          )}
        </div>
        {history.cold ? (
          <div className="home-empty">Loading session history…</div>
        ) : history.error ? (
          <div className="home-empty err">{history.error}</div>
        ) : visible.length === 0 ? (
          <div className="home-empty">No restorable sessions in this project.</div>
        ) : visible.map((item) => {
          const id = item.digest.session_id!
          return (
            <div className="home-resume-row" key={id}>
              <input
                type="checkbox"
                checked={chosen.has(id)}
                aria-label={`Select ${item.prompt || item.agentId}`}
                onChange={() => setChosen((before) => {
                  const next = new Set(before)
                  if (next.has(id)) next.delete(id); else next.add(id)
                  return next
                })}
              />
              <AgentBadge agent={item.agentId} sz={25} />
              <button className="home-resume-main" onClick={() => restore([item])}>
                <span className="home-resume-prompt">{item.prompt || '(no prompt captured)'}</span>
                <span className="home-resume-meta">
                  {basename(item.cwd)}
                  {item.digest.branch && <> · {item.digest.branch}</>}
                  {item.profile !== 'default' && <> · {item.profile}</>}
                </span>
              </button>
              <span className="home-age">{age(item.digest.updated)}</span>
              <button className="primary sm" onClick={() => restore([item])}>Resume</button>
              <button className="iconbtn" aria-label="Forget session" onClick={() => void forget([item])}>
                <IconClose s={13} />
              </button>
            </div>
          )
        })}
      </section>
    </main>
  )
}

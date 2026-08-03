// The three panels that need no round trip: everything they show is already in
// the snapshot the socket pushes. Agents and terminals come out of `buildRows`
// (the same fusion the desktop uses), servers out of the port list `pty:stats`
// carries for every live process tree.

import { AgentBadge } from '@shared/components'
import { AgentsIcon, IconTerminal, ServersIcon } from '@shared/icons'
import { agentMeta, basename, fmtMem, fmtTokens, type AgentRow } from '@shared/model'
import { formatDuration, hasWorkingTime, workingTime } from '@shared/agentDuration'
import { Pill, Row, SubHead } from './ui'
import type { PanelCtx, PanelDef } from './types'

function agentRow(ctx: PanelCtx, r: AgentRow, key: string) {
  const m = agentMeta(r.agent)
  const live = r.live && r.ptyId !== undefined
  // Only a live, *working* row keeps counting past its last hook event — see
  // agentDuration.ts. A stopped agent must freeze, not drift upward.
  const work = workingTime(
    { active_secs: r.activeSecs, run_secs: r.runSecs, updated: r.updated },
    Date.now() / 1000,
    r.live && r.state === 'working',
  )
  return (
    <Row
      key={key}
      on={ctx.openKey === (live ? `terminal:${r.ptyId}` : `history:${r.key}`)}
      icon={<AgentBadge agent={r.agent} sz={26} />}
      title={
        <>
          {r.terminal ? (r.title ?? 'Terminal') : m.label}
          {r.needsYou && <Pill tone="warn">needs you</Pill>}
        </>
      }
      sub={r.lastPrompt ?? (r.branch ? `⑂ ${r.branch}` : basename(r.cwd))}
      meta={
        <>
          {hasWorkingTime(work) && <span className="mono dim">{formatDuration(work.total)}</span>}
          {r.tokens ? <span className="mono dim">{fmtTokens(r.tokens)}</span> : null}
          {r.memBytes ? <span className="mono dim">{fmtMem(r.memBytes)}</span> : null}
          <span className={`dot ${live ? r.state : 'off'}`} />
        </>
      }
      onClick={() =>
        live
          ? ctx.open({ kind: 'terminal', pty: r.ptyId! })
          : ctx.open({ kind: 'history', key: r.key })
      }
    />
  )
}

/** Rows whose cwd is inside the selected project — the same "deepest matching
 *  component wins" rule the desktop uses, applied to whichever project the
 *  shell is pointed at. `undefined` project means show them all. */
function forProject(ctx: PanelCtx): AgentRow[] {
  const paths = ctx.project?.components?.map((c) => c.path.replace(/\/+$/, '')) ?? []
  if (!paths.length) return ctx.rows
  return ctx.rows.filter((r) => {
    const cwd = (r.cwd ?? '').replace(/\/+$/, '')
    return paths.some((p) => cwd === p || cwd.startsWith(p + '/'))
  })
}

export const agentsPanel: PanelDef = {
  id: 'agents',
  title: 'Agents',
  Icon: AgentsIcon,
  scope: 'project',
  badge: (ctx) => forProject(ctx).filter((r) => !r.terminal).length,
  urgent: (ctx) => forProject(ctx).some((r) => r.needsYou),
  List({ ctx }) {
    const rows = forProject(ctx).filter((r) => !r.terminal)
    const live = rows.filter((r) => r.live)
    const past = rows.filter((r) => !r.live)
    if (!rows.length) {
      return <div className="panel-empty">No agents in this project yet.</div>
    }
    return (
      <>
        {live.length > 0 && (
          <>
            <SubHead icon={<AgentsIcon s={12} />} title="Active" n={live.length} />
            {live.map((r) => agentRow(ctx, r, r.key))}
          </>
        )}
        {past.length > 0 && (
          <>
            <SubHead icon={<IconTerminal s={12} />} title="Recent" n={past.length} />
            {past.map((r) => agentRow(ctx, r, r.key))}
          </>
        )}
      </>
    )
  },
}

export const terminalsPanel: PanelDef = {
  id: 'terminals',
  title: 'Terminals',
  Icon: IconTerminal,
  scope: 'project',
  badge: (ctx) => forProject(ctx).filter((r) => r.terminal).length,
  List({ ctx }) {
    const rows = forProject(ctx).filter((r) => r.terminal)
    const comps = ctx.project?.components ?? []
    return (
      <>
        {rows.length === 0 ? (
          <div className="panel-empty">No plain terminals running.</div>
        ) : (
          rows.map((r) => agentRow(ctx, r, r.key))
        )}
        {comps.length > 0 && (
          <>
            <SubHead title="New shell in" n={comps.length} />
            {comps.map((c) => (
              <Row
                key={c.path}
                icon={<IconTerminal s={15} />}
                title={c.label}
                sub={c.path}
                onClick={() => ctx.spawn(c.path)}
              />
            ))}
          </>
        )}
      </>
    )
  },
}

export const serversPanel: PanelDef = {
  id: 'servers',
  title: 'Servers',
  Icon: ServersIcon,
  scope: 'project',
  badge: (ctx) => listening(ctx).length,
  List({ ctx }) {
    const running = listening(ctx)
    if (!running.length) {
      return (
        <div className="panel-empty">
          Nothing is listening on a port. A dev server started in any terminal shows up here.
        </div>
      )
    }
    return (
      <>
        {running.map((s) => (
          <Row
            key={s.id}
            on={ctx.openKey === `terminal:${s.id}`}
            icon={<ServersIcon s={16} />}
            title={s.title?.trim() || basename(s.cwd)}
            sub={basename(s.cwd)}
            meta={s.ports.map((p) => (
              <Pill key={p} tone="ok">
                :{p}
              </Pill>
            ))}
            onClick={() => ctx.open({ kind: 'terminal', pty: s.id })}
          />
        ))}
      </>
    )
  },
}

/** Live PTYs with a listening port, inside the selected project. The ports come
 *  off the process-tree scan Rust already runs for `pty:stats`, so a server is
 *  detected however it was started — no registry, no convention. */
function listening(ctx: PanelCtx) {
  const paths = ctx.project?.components?.map((c) => c.path.replace(/\/+$/, '')) ?? []
  return [...ctx.stats.values()]
    .filter((s) => s.ports?.length)
    .filter((s) => {
      if (!paths.length) return true
      const cwd = (s.cwd ?? '').replace(/\/+$/, '')
      return paths.some((p) => cwd === p || cwd.startsWith(p + '/'))
    })
    .sort((a, b) => a.id - b.id)
}

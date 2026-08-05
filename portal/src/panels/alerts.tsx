// Notifications and plan usage.
//
// The notifications panel is the one that makes the whole portal worth carrying:
// it is the list of agents that have stopped and are waiting on you, and it is
// where the browser's notification permission is asked for — from a real tap,
// which every mobile browser requires.

import { useState } from 'react'
import { AgentBadge } from '@shared/components'
import { IconBell, IconCheck, IconGauge } from '@shared/icons'
import {
  agentMeta,
  basename,
  isRemoteOutstanding,
  type RemoteAttentionItem,
} from '@shared/model'
import type { PendingItem } from '@shared/notifications'
import { useAsync } from '../useAsync'
import {
  notifyState,
  requestNotifications,
  setWantsNotifications,
  wantsNotifications,
  type NotifyState,
} from '../notify'
import { AsyncBody, Pill, Row, SubHead } from './ui'
import type { PanelCtx, PanelDef } from './types'

interface PlanWindow {
  label: string
  used_percent: number
  resets_at?: number | null
}
interface PlanUsage {
  agent: string
  plan?: string | null
  windows: PlanWindow[]
  credits?: number | null
  observed: number
}

/** The permission control. Deliberately states the plain-HTTP limitation rather
 *  than offering a button that silently does nothing — a "Enable" that never
 *  works is worse than an explanation. */
function NotifyControl() {
  const [state, setState] = useState<NotifyState>(notifyState())
  const [on, setOn] = useState(wantsNotifications())

  if (state === 'insecure') {
    return (
      <div className="notice-card">
        <strong>Notifications need a secure link.</strong> Browsers only allow them over HTTPS, so
        this plain-HTTP LAN address can't use them. Turn on a tunnel in Canopy → Settings → Remote
        access and open the https:// URL instead.
      </div>
    )
  }
  if (state === 'unsupported') {
    return <div className="notice-card">This browser has no notification support.</div>
  }
  if (state === 'denied') {
    return (
      <div className="notice-card">
        <strong>Notifications are blocked</strong> for this site. Re-allow them in your browser's
        site settings — a page can't ask twice once it has been refused.
      </div>
    )
  }
  if (state === 'default') {
    return (
      <button
        className="primary block"
        onClick={() => void requestNotifications().then(setState)}
      >
        <IconBell s={16} /> Notify me when an agent needs me
      </button>
    )
  }
  return (
    <label className="toggle-row">
      <span>
        <IconCheck s={15} /> Notifications on this device
      </span>
      <input
        type="checkbox"
        checked={on}
        onChange={(e) => {
          setOn(e.target.checked)
          setWantsNotifications(e.target.checked)
        }}
      />
    </label>
  )
}

function alertRow(ctx: PanelCtx, item: PendingItem) {
  const m = agentMeta(item.agent)
  const live = item.pty != null && ctx.rows.some((r) => r.ptyId === item.pty)
  return (
    <Row
      key={item.key}
      on={ctx.openKey === `terminal:${item.pty}`}
      icon={<AgentBadge agent={item.agent} sz={26} />}
      title={
        <>
          {m.label}
          {item.kind !== 'idle' && <Pill tone="warn">needs you</Pill>}
        </>
      }
      sub={item.questions?.[0]?.question ?? item.message ?? 'Waiting on you.'}
      meta={<span className="dim">{basename(item.cwd)}</span>}
      onClick={live ? () => ctx.open({ kind: 'terminal', pty: item.pty! }) : undefined}
    />
  )
}

/** One attention-channel item — the desktop's bell list, mirrored. There is no
 *  terminal to land on (many of these come from dialogs, not sessions), so the
 *  row is informational: what was raised, by which project, and whether it is
 *  still waiting. */
function attentionRow(item: RemoteAttentionItem) {
  const waiting = isRemoteOutstanding(item)
  return (
    <Row
      key={`att:${item.id}`}
      icon={<IconBell s={18} />}
      title={
        <>
          {item.title}
          {waiting && <Pill tone="warn">needs you</Pill>}
          {!waiting && item.tone === 'error' && <Pill tone="warn">error</Pill>}
        </>
      }
      sub={item.body}
      meta={item.projectName ? <span className="dim">{item.projectName}</span> : undefined}
    />
  )
}

/** The attention items worth showing beside the hook-stream cards. The desktop
 *  derives a question per blocked agent from the same hook stream this panel
 *  already renders, keyed `agent:<sessionId>` — where both copies are present
 *  the card wins (it can jump to the terminal). The attention copy still shows
 *  when the event predates this page's tail, so nothing waiting goes
 *  invisible. */
function attentionSansCards(ctx: PanelCtx): RemoteAttentionItem[] {
  const shown = new Set(ctx.pending.map((i) => `agent:${i.sessionId}`))
  return ctx.attention.filter((i) => !i.dedupeKey || !shown.has(i.dedupeKey))
}

export const notificationsPanel: PanelDef = {
  id: 'notifications',
  title: 'Notifications',
  Icon: IconBell,
  scope: 'global',
  badge: (ctx) =>
    ctx.pending.filter((i) => i.kind !== 'idle').length +
    attentionSansCards(ctx).filter(isRemoteOutstanding).length,
  urgent: (ctx) =>
    ctx.pending.some((i) => i.kind !== 'idle') ||
    attentionSansCards(ctx).some(isRemoteOutstanding),
  List({ ctx }) {
    const urgent = ctx.pending.filter((i) => i.kind !== 'idle')
    const done = ctx.pending.filter((i) => i.kind === 'idle')
    const attention = attentionSansCards(ctx)
    // Questions still waiting lead, then the rest of the history, newest
    // first (the push is already newest-first).
    const asking = attention.filter(isRemoteOutstanding)
    const rest = attention.filter((i) => !isRemoteOutstanding(i))
    const empty = ctx.pending.length === 0 && ctx.attention.length === 0
    return (
      <>
        <div className="panel-pad">
          <NotifyControl />
        </div>
        {(urgent.length > 0 || asking.length > 0) && (
          <>
            <SubHead title="Waiting on you" n={urgent.length + asking.length} />
            {urgent.map((i) => alertRow(ctx, i))}
            {asking.map(attentionRow)}
          </>
        )}
        {done.length > 0 && (
          <>
            <SubHead title="Finished" n={done.length} />
            {done.map((i) => alertRow(ctx, i))}
          </>
        )}
        {rest.length > 0 && (
          <>
            <SubHead title="Notifications" n={rest.length} />
            {rest.map(attentionRow)}
          </>
        )}
        {empty && (
          <div className="panel-empty">
            Nothing is waiting on you. Anything an agent raises will show up here — and buzz your
            phone once notifications are on.
          </div>
        )}
      </>
    )
  },
}

export const usagePanel: PanelDef = {
  id: 'usage',
  title: 'Usage',
  Icon: IconGauge,
  scope: 'global',
  List({ ctx }) {
    const state = useAsync<PlanUsage[]>(() => ctx.rpc.call('plan_usage'), [])
    const spend = ctx.rows.reduce((n, r) => n + (r.cost ?? 0), 0)
    return (
      <>
        <AsyncBody state={state} empty="No plan limits are being reported.">
          {(plans) => (
            <>
              <SubHead title="Plan limits" n={plans.length} />
              {plans.map((p) => (
                <div className="usage-card" key={p.agent}>
                  <div className="usage-head">
                    <AgentBadge agent={p.agent} sz={24} />
                    <span className="usage-name">{agentMeta(p.agent).label}</span>
                    {p.plan && <Pill>{p.plan}</Pill>}
                  </div>
                  {p.windows.map((w) => (
                    <div className="meter-row" key={w.label}>
                      <span className="meter-label mono">{w.label}</span>
                      <span className="meter">
                        <span
                          className={`meter-fill ${w.used_percent >= 90 ? 'hot' : w.used_percent >= 70 ? 'warm' : ''}`}
                          style={{ width: `${Math.min(100, Math.max(0, w.used_percent))}%` }}
                        />
                      </span>
                      <span className="meter-n mono">{Math.round(w.used_percent)}%</span>
                    </div>
                  ))}
                  {p.credits != null && (
                    <div className="meter-row">
                      <span className="meter-label mono">credits</span>
                      <span className="meter-n mono">${p.credits.toFixed(2)}</span>
                    </div>
                  )}
                </div>
              ))}
            </>
          )}
        </AsyncBody>
        {spend > 0 && (
          <>
            <SubHead title="This session" />
            <Row title="Spend across visible agents" meta={<span className="mono">${spend.toFixed(2)}</span>} />
          </>
        )}
      </>
    )
  },
}

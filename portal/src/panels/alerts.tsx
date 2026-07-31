// Notifications and plan usage.
//
// The notifications panel is the one that makes the whole portal worth carrying:
// it is the list of agents that have stopped and are waiting on you, and it is
// where the browser's notification permission is asked for — from a real tap,
// which every mobile browser requires.

import { useState } from 'react'
import { AgentBadge } from '@shared/components'
import { IconBell, IconCheck, IconGauge } from '@shared/icons'
import { agentMeta, basename } from '@shared/model'
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

export const notificationsPanel: PanelDef = {
  id: 'notifications',
  title: 'Notifications',
  Icon: IconBell,
  scope: 'global',
  badge: (ctx) => ctx.pending.filter((i) => i.kind !== 'idle').length,
  urgent: (ctx) => ctx.pending.some((i) => i.kind !== 'idle'),
  List({ ctx }) {
    const urgent = ctx.pending.filter((i) => i.kind !== 'idle')
    const done = ctx.pending.filter((i) => i.kind === 'idle')
    return (
      <>
        <div className="panel-pad">
          <NotifyControl />
        </div>
        {urgent.length > 0 && (
          <>
            <SubHead title="Waiting on you" n={urgent.length} />
            {urgent.map((i) => alertRow(ctx, i))}
          </>
        )}
        {done.length > 0 && (
          <>
            <SubHead title="Finished" n={done.length} />
            {done.map((i) => alertRow(ctx, i))}
          </>
        )}
        {ctx.pending.length === 0 && (
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

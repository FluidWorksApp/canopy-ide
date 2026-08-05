// The companion, on the portal.
//
// The desktop pushes presence + the transcript tail into the snapshot (see
// src/remoteCompanion.ts); this panel renders whatever was last pushed. It is
// deliberately read-only for now: sending a message needs the desktop-verb hop
// (remote/verbs.rs), which lands with the first verb that needs it — showing
// the conversation must not wait on that.

import { CompanionIcon } from '@shared/icons'
import { Pill } from './ui'
import type { PanelCtx, PanelDef } from './types'
import './companion.css'

const STATUS_LABEL: Record<string, string> = {
  off: 'off',
  starting: 'starting…',
  ready: 'ready',
  working: 'working…',
  failed: 'failed',
  unavailable: 'unavailable',
}

export const companionPanel: PanelDef = {
  id: 'companion',
  title: 'Companion',
  Icon: CompanionIcon,
  scope: 'global',
  badge: (ctx) => (ctx.companion && ctx.companion.status !== 'off' ? 1 : 0),
  urgent: (ctx) => ctx.companion?.status === 'failed',
  List({ ctx }: { ctx: PanelCtx }) {
    const c = ctx.companion
    if (!c || c.status === 'off') {
      return (
        <div className="panel-empty">
          The companion is off. Start it from the desktop — its conversation shows up here.
        </div>
      )
    }
    return (
      <div className="comp">
        <div className="comp-head">
          <CompanionIcon s={18} />
          <span className="comp-name">Ash</span>
          {c.cliName && <span className="comp-cli">{c.cliName}</span>}
          <Pill tone={c.status === 'failed' ? 'warn' : c.status === 'working' ? 'ok' : undefined}>
            {STATUS_LABEL[c.status] ?? c.status}
          </Pill>
        </div>
        {c.error && <div className="comp-error">{c.error}</div>}
        {c.messages.length === 0 ? (
          <div className="panel-note">Nothing said yet this session.</div>
        ) : (
          <div className="comp-thread">
            {c.messages.map((m, i) => (
              <div key={i} className={`comp-msg ${m.who}${m.failed ? ' failed' : ''}`}>
                {m.tools && m.tools.length > 0 && (
                  <div className="comp-tools">
                    {m.tools.map((t, j) => (
                      <span key={j} className="tag">
                        {t}
                      </span>
                    ))}
                  </div>
                )}
                <div className="comp-text">{m.text}</div>
              </div>
            ))}
          </div>
        )}
        <div className="panel-note comp-note">
          Read-only from here for now — talk to Ash on the desktop.
        </div>
      </div>
    )
  },
}

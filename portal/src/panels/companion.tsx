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

/** The face, drawn small: the canopy arc as the brow, dash eyes when asleep,
 *  dot eyes when the session is up. A sketch of the desktop's Ash, not a copy —
 *  the real repertoire lives in the desktop's Mascot; the portal only needs
 *  presence. */
function CompanionFace({ awake, s = 26 }: { awake: boolean; s?: number }) {
  return (
    <svg
      width={s}
      height={s}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      aria-hidden
    >
      <path d="M5.2 12.4a6.8 6.8 0 0 1 13.6 0" />
      {awake ? (
        <>
          <circle cx="9.4" cy="14.8" r="1" fill="currentColor" stroke="none" />
          <circle cx="14.6" cy="14.8" r="1" fill="currentColor" stroke="none" />
        </>
      ) : (
        <path d="M8.4 14.8h2M13.6 14.8h2" />
      )}
      <path d="M10.6 18h2.8" />
    </svg>
  )
}

/** The companion as a floating presence, not a rail entry. It is cross-project
 *  — the rail is one project's index, and Ash is nobody's project — so it
 *  floats above the shell the way the desktop's face does, and opens the same
 *  read-only conversation panel. */
export function CompanionFab({
  ctx,
  active,
  onOpen,
}: {
  ctx: PanelCtx
  active: boolean
  onOpen: () => void
}) {
  const status = ctx.companion?.status ?? 'off'
  const awake = status === 'ready' || status === 'working' || status === 'failed'
  return (
    <button
      className={`comp-fab ${active ? 'on' : ''} ${awake ? '' : 'asleep'}`}
      onClick={onOpen}
      title="Ash — companion"
      aria-label={`Companion — ${STATUS_LABEL[status] ?? status}`}
    >
      <CompanionFace awake={awake} />
      {!awake && <span className="comp-fab-z">z</span>}
      {status === 'failed' && <span className="comp-fab-dot" />}
    </button>
  )
}

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

// The phone shell: still an IDE, laid out for one hand.
//
// Same panels, same detail views, different navigation model — a stack instead
// of panes, a bottom bar instead of a rail, a sheet instead of a twelfth tab.
// The bar is at the bottom because that is where a thumb is, and the four
// primaries are the ones you open when you are not at your desk; everything
// else lives one tap deeper rather than being cut.

import { useState } from 'react'
import { IconClose, IconFolder, IconHome, IconMenu, IconPlus, IconPower } from '@shared/icons'
import { COMPACT_PRIMARY, PANELS } from '../panels'
import { targetKey } from '../panels/types'
import { Detail } from '../views/Detail'
import { BusyDot, type ShellProps } from './WideShell'
import { ProjectHome } from '../ProjectHome'

export function CompactShell(props: ShellProps) {
  const { ctx, up, panelId, onPanel, tabs, activeKey, onCloseTab, projects, onProject } = props
  const [more, setMore] = useState(false)
  const panel = PANELS.find((p) => p.id === panelId) ?? PANELS[0]
  const active = tabs.find((t) => targetKey(t) === activeKey)

  // The detail is a pushed screen, not a pane: it covers the list entirely and
  // back returns to exactly where the list was.
  if (active) {
    return (
      <div className="compact">
        <Detail ctx={ctx} target={active} onBack={() => onCloseTab(activeKey!)} showBack />
      </div>
    )
  }

  const primary = COMPACT_PRIMARY.map((id) => PANELS.find((p) => p.id === id)).filter(
    (p): p is (typeof PANELS)[number] => !!p,
  )
  const secondary = PANELS.filter((p) => !COMPACT_PRIMARY.includes(p.id))
  const inMore = !props.home && secondary.some((p) => p.id === panelId)

  return (
    <div className="compact">
      <header className="cbar">
        <span className={`mark-dot ${up ? 'live' : 'down'}`} />
        <span className="cbar-title">{props.home ? 'Home' : panel.title}</span>
        <BusyDot ctx={ctx} />
        {projects.length > 1 ? (
          <label className="proj-pick">
            <IconFolder s={13} />
            <select value={ctx.project?.id ?? ''} onChange={(e) => onProject(e.target.value)}>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          projects.length === 1 && <span className="cbar-proj">{projects[0].name}</span>
        )}
        <button className="iconbtn" onClick={props.onLogout} aria-label="Sign out">
          <IconPower s={16} />
        </button>
      </header>

      <div className="pane-scroll compact-scroll">
        {props.home ? (
          <ProjectHome ctx={ctx} clis={ctx.clis} compact onNewAgent={props.onNewAgent} />
        ) : (
          <panel.List ctx={ctx} />
        )}
      </div>

      {panel.id === 'agents' && ctx.project && (
        <button className="fab" onClick={props.onNewAgent}>
          <IconPlus s={14} /> New agent
        </button>
      )}

      <nav className="tabbar" aria-label="Panels">
        <button className={props.home ? 'on' : ''} onClick={() => props.onHome(ctx.project?.id)} aria-current={props.home}>
          <span className="tb-i"><IconHome s={20} /></span>
          <span className="tb-l">Home</span>
        </button>
        {primary.map((p) => {
          const n = p.badge?.(ctx) ?? 0
          const hot = p.urgent?.(ctx) ?? false
          return (
            <button
              key={p.id}
              className={!props.home && p.id === panelId ? 'on' : ''}
              onClick={() => onPanel(p.id)}
              aria-current={!props.home && p.id === panelId}
            >
              <span className="tb-i">
                <p.Icon s={20} />
                {n > 0 && <span className={`tb-n ${hot ? 'hot' : ''}`}>{n}</span>}
              </span>
              <span className="tb-l">{p.title}</span>
            </button>
          )
        })}
        <button className={inMore ? 'on' : ''} onClick={() => setMore(true)}>
          <span className="tb-i">
            <IconMenu s={20} />
          </span>
          <span className="tb-l">More</span>
        </button>
      </nav>

      {more && (
        <div className="sheet-backdrop" onClick={() => setMore(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-grip" />
            <h3>
              Everything else
              <button className="iconbtn" onClick={() => setMore(false)} aria-label="Close">
                <IconClose s={14} />
              </button>
            </h3>
            <div className="more-grid">
              {secondary.map((p) => {
                const n = p.badge?.(ctx) ?? 0
                return (
                  <button
                    key={p.id}
                    className={`more-item ${p.id === panelId ? 'on' : ''}`}
                    onClick={() => {
                      onPanel(p.id)
                      setMore(false)
                    }}
                  >
                    <p.Icon s={22} />
                    <span>{p.title}</span>
                    {n > 0 && <span className="more-n">{n}</span>}
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

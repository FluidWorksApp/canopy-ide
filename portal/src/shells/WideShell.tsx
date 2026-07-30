// The desk shell: rail, list, detail — the IDE's own three-pane shape.
//
// An iPad in landscape or a second laptop is not a big phone. It has room to
// keep the list and the thing you opened from it on screen together, and losing
// that is what made the old wide layout read as "a phone stretched": you tapped
// a file, the list vanished, you went back, you had lost your scroll position.
//
// The detail pane keeps a tab strip, because on a screen this size you are
// comparing — a diff against the terminal that produced it — and one slot at a
// time is the phone's constraint, not this one's.

import { IconClose, IconFolder, IconPlus, IconPower } from '@shared/icons'
import { PANELS } from '../panels'
import type { PanelCtx, Target } from '../panels/types'
import { targetKey } from '../panels/types'
import { Detail } from '../views/Detail'
import { PanelHead } from '../panels/ui'
import type { Project } from '@shared/model'

export interface ShellProps {
  ctx: PanelCtx
  up: boolean
  panelId: string
  onPanel: (id: string) => void
  /** Open detail tabs, oldest first, and which one is in front. */
  tabs: Target[]
  activeKey?: string
  onSelectTab: (key: string) => void
  onCloseTab: (key: string) => void
  projects: Project[]
  onProject: (id: string) => void
  onNewAgent: () => void
  onLogout: () => void
}

export function WideShell(props: ShellProps) {
  const { ctx, up, panelId, onPanel, tabs, activeKey, onSelectTab, onCloseTab } = props
  const panel = PANELS.find((p) => p.id === panelId) ?? PANELS[0]
  const active = tabs.find((t) => targetKey(t) === activeKey)

  return (
    <div className="wide">
      <nav className="prail" aria-label="Panels">
        <div className="prail-mark" title={up ? 'Connected' : 'Reconnecting…'}>
          <span className={`mark-dot ${up ? 'live' : 'down'}`} />
        </div>
        {PANELS.map((p) => {
          const n = p.badge?.(ctx) ?? 0
          const hot = p.urgent?.(ctx) ?? false
          return (
            <button
              key={p.id}
              className={`prail-btn ${p.id === panelId ? 'on' : ''}`}
              onClick={() => onPanel(p.id)}
              title={p.title}
              aria-label={p.title}
              aria-current={p.id === panelId}
            >
              <p.Icon s={19} />
              {n > 0 && <span className={`prail-n ${hot ? 'hot' : ''}`}>{n}</span>}
            </button>
          )
        })}
        <span className="prail-fill" />
        <button className="prail-btn" onClick={props.onLogout} title="Sign out" aria-label="Sign out">
          <IconPower s={18} />
        </button>
      </nav>

      <section className="pane list-pane" aria-label={panel.title}>
        <PanelHead title={panel.title} count={panel.badge?.(ctx)}>
          <ProjectPicker {...props} />
          <button className="ghost sm" onClick={props.onNewAgent}>
            <IconPlus s={14} /> Agent
          </button>
        </PanelHead>
        <div className="pane-scroll">
          <panel.List ctx={ctx} />
        </div>
      </section>

      <section className="pane detail-pane">
        {tabs.length > 0 && (
          <div className="tabstrip" role="tablist">
            {tabs.map((t) => {
              const key = targetKey(t)
              return (
                <div key={key} className={`tab ${key === activeKey ? 'on' : ''}`}>
                  <button className="tab-label" role="tab" onClick={() => onSelectTab(key)}>
                    {tabLabel(t)}
                  </button>
                  <button
                    className="tab-x"
                    onClick={() => onCloseTab(key)}
                    aria-label={`Close ${tabLabel(t)}`}
                  >
                    <IconClose s={12} />
                  </button>
                </div>
              )
            })}
          </div>
        )}
        {active ? (
          <Detail ctx={ctx} target={active} onBack={() => onCloseTab(activeKey!)} showBack={false} />
        ) : (
          <div className="detail-idle">
            <panel.Icon s={30} />
            <p>Pick something on the left.</p>
          </div>
        )}
      </section>
    </div>
  )
}

export function ProjectPicker({ projects, ctx, onProject }: ShellProps) {
  if (projects.length <= 1) {
    return projects.length === 1 ? (
      <span className="proj-static">
        <IconFolder s={13} /> {projects[0].name}
      </span>
    ) : null
  }
  return (
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
  )
}

/** A tab's label: short enough for a strip, specific enough to tell two diffs
 *  of different files apart. */
export function tabLabel(t: Target): string {
  const tail = (p: string) => p.split('/').filter(Boolean).pop() ?? p
  switch (t.kind) {
    case 'terminal':
      return `pty ${t.pty}`
    case 'history':
      return 'session'
    case 'file':
      return tail(t.path)
    case 'diff':
      return `${tail(t.path)} ±`
    case 'commit':
      return t.subject.slice(0, 24)
    case 'pr':
      return `#${t.number}`
    case 'text':
      return t.title.slice(0, 24)
  }
}

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

import { useEffect, useState } from 'react'
import { IconBell, IconClose, IconFolder, IconPlus, IconPower } from '@shared/icons'
import { PANELS, WIDE_RAIL_FOOTER, WIDE_RAIL_GROUPS, panelById } from '../panels'
import type { PanelCtx, Target } from '../panels/types'
import { targetKey } from '../panels/types'
import { Detail } from '../views/Detail'
import { PanelHead } from '../panels/ui'
import { agentMeta, type AgentRow, type Project } from '@shared/model'
import { ProjectHome } from '../ProjectHome'

export interface ShellProps {
  ctx: PanelCtx
  up: boolean
  panelId: string
  onPanel: (id: string) => void
  home: boolean
  onHome: (id?: string) => void
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
  const notifications = panelById('notifications')
  const notificationCount = notifications?.badge?.(ctx) ?? 0
  const notificationsHot = notifications?.urgent?.(ctx) ?? false

  return (
    <div className="wide">
      <header className="titlebar portal-titlebar">
        <span
          className="portal-connection"
          title={up ? 'Connected' : 'Reconnecting…'}
          role="status"
          aria-live="polite"
        >
          <span className={`mark-dot ${up ? 'live' : 'down'}`} />
          {up ? 'Remote' : 'Reconnecting…'}
        </span>
        <div className="project-tabs" aria-label="Open projects">
          {props.projects.map((project) => (
            <button
              key={project.id}
              className={`project-tab ${project.id === ctx.project?.id ? 'project-tab-active' : ''}`}
              onClick={() => props.onProject(project.id)}
              aria-current={project.id === ctx.project?.id ? 'page' : undefined}
            >
              <span>{project.name}</span>
            </button>
          ))}
        </div>
        <span className="titlebar-spacer" />
        <button
          className={`project-tab portal-top-icon ${!props.home && panelId === 'notifications' ? 'project-tab-active' : ''}`}
          onClick={() => onPanel('notifications')}
          title="Notifications"
          aria-label="Notifications"
          aria-current={!props.home && panelId === 'notifications' ? 'page' : undefined}
        >
          <IconBell s={14} />
          {notificationCount > 0 && (
            <span className={`rail-badge portal-title-badge ${notificationsHot ? 'rail-badge-hot' : ''}`}>
              {Math.min(notificationCount, 99)}
            </span>
          )}
        </button>
        <button className="project-tab portal-top-action" onClick={props.onNewAgent}>
          <IconPlus s={14} /> <span>Agent</span>
        </button>
        <button
          className="project-tab portal-top-icon"
          onClick={props.onLogout}
          title="Sign out"
          aria-label="Sign out"
        >
          <IconPower s={16} />
        </button>
      </header>

      <nav className="rail portal-rail" aria-label="Panels">
        {WIDE_RAIL_GROUPS.map((group) => (
          <div className="rail-group" role="group" aria-label={group.label} key={group.id}>
            {group.panels.map((id) => panelById(id)).filter(Boolean).map((p) => (
              <RailButton key={p!.id} panel={p!} ctx={ctx} active={!props.home && p!.id === panelId} onPanel={onPanel} />
            ))}
          </div>
        ))}
        <span className="rail-spacer" />
        <div className="rail-group portal-rail-footer" role="group" aria-label="Tools">
          {WIDE_RAIL_FOOTER.map((id) => panelById(id)).filter(Boolean).map((p) => (
            <RailButton key={p!.id} panel={p!} ctx={ctx} active={!props.home && p!.id === panelId} onPanel={onPanel} />
          ))}
        </div>
      </nav>

      {props.home ? (
        <section className="pane home-pane">
          <ProjectHome ctx={ctx} clis={ctx.clis} onNewAgent={props.onNewAgent} />
        </section>
      ) : <>
        <section className="pane list-pane" aria-label={panel.title}>
          <PanelHead title={panel.title} count={panel.badge?.(ctx)}>
            <BusyDot ctx={ctx} />
          </PanelHead>
          <div className="pane-scroll">
            <panel.List ctx={ctx} />
          </div>
        </section>
        <section className="pane detail-pane">
        {tabs.length > 0 && (
          <div className="pane-bar portal-pane-bar">
            <div className="tabs" role="tablist">
            {tabs.map((t) => {
              const key = targetKey(t)
              return (
                <div
                  key={key}
                  className={`tab ${key === activeKey ? 'tab-active' : ''}`}
                  role="presentation"
                >
                  <button
                    className="tab-title portal-tab-label"
                    role="tab"
                    aria-selected={key === activeKey}
                    aria-controls="portal-detail-panel"
                    tabIndex={key === activeKey ? 0 : -1}
                    data-portal-tab={key}
                    onClick={() => onSelectTab(key)}
                    onKeyDown={(event) => {
                      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
                      event.preventDefault()
                      const at = tabs.findIndex((candidate) => targetKey(candidate) === key)
                      const delta = event.key === 'ArrowRight' ? 1 : -1
                      const next = tabs[(at + delta + tabs.length) % tabs.length]
                      const nextKey = targetKey(next)
                      onSelectTab(nextKey)
                      requestAnimationFrame(() => {
                        document.querySelector<HTMLElement>(`[data-portal-tab="${CSS.escape(nextKey)}"]`)?.focus()
                      })
                    }}
                  >
                    {tabLabel(t, ctx.rows)}
                  </button>
                  <button
                    className="tab-close"
                    onClick={() => onCloseTab(key)}
                    aria-label={`Close ${tabLabel(t, ctx.rows)}`}
                  >
                    <IconClose s={14} />
                  </button>
                </div>
              )
            })}
            </div>
          </div>
        )}
        {active ? (
          <div
            className="portal-tabpanel"
            id="portal-detail-panel"
            role="tabpanel"
            aria-label={tabLabel(active, ctx.rows)}
          >
            <Detail ctx={ctx} target={active} onBack={() => onCloseTab(activeKey!)} showBack={false} />
          </div>
        ) : (
          <div className="detail-idle">
            <panel.Icon s={30} />
            <p>Pick something on the left.</p>
          </div>
        )}
        </section>
      </>}
    </div>
  )
}

function RailButton({
  panel,
  ctx,
  active,
  onPanel,
}: {
  panel: (typeof PANELS)[number]
  ctx: PanelCtx
  active: boolean
  onPanel: (id: string) => void
}) {
  const n = panel.badge?.(ctx) ?? 0
  const hot = panel.urgent?.(ctx) ?? false
  return (
    <button
      className={`rail-btn ${active ? 'rail-btn-active' : ''}`}
      onClick={() => onPanel(panel.id)}
      title={panel.title}
      aria-label={panel.title}
      aria-current={active}
    >
      <panel.Icon s={22} />
      {n > 0 && <span className={`rail-badge ${hot ? 'rail-badge-hot' : ''}`}>{Math.min(n, 99)}</span>}
    </button>
  )
}

/** One activity light for the whole app, driven by the RPC layer's in-flight
 *  count. It is the answer to "did my tap do anything?" on a panel that already
 *  has rows on screen and therefore shows no skeleton. */
export function BusyDot({ ctx }: { ctx: PanelCtx }) {
  const [busy, setBusy] = useState(false)
  useEffect(() => ctx.rpc.onBusy(setBusy), [ctx.rpc])
  return <span className={`busy-dot ${busy ? 'on' : ''}`} aria-hidden />
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
 *  of different files apart. Terminal tabs get what the desktop's tab strip
 *  shows — the pty's own title, then the agent's name — never a raw pty id. */
export function tabLabel(t: Target, rows: AgentRow[] = []): string {
  const tail = (p: string) => p.split('/').filter(Boolean).pop() ?? p
  switch (t.kind) {
    case 'terminal': {
      const row = rows.find((r) => r.ptyId === t.pty)
      const name = row?.title ?? (row && row.agent !== 'shell' ? agentMeta(row.agent).label : undefined)
      return name?.slice(0, 24) ?? `pty ${t.pty}`
    }
    case 'history': {
      const row = rows.find((r) => r.key === t.key)
      return (row?.title ?? row?.lastPrompt)?.slice(0, 24) ?? 'session'
    }
    case 'file':
      return tail(t.path)
    case 'diff':
      return `${tail(t.path)} ±`
    case 'commit':
      return t.subject.slice(0, 24)
    case 'pr':
      return `#${t.number}`
    case 'text':
    case 'research':
    case 'doc':
      return t.title.slice(0, 24)
  }
}

// The handful of pieces every panel list is built from. Kept here rather than
// in each panel so twelve lists look like one app — the desktop's panels share
// a rail and a row rhythm, and the remote ones have to earn the same read.

import type { ReactNode } from 'react'
import { IconRefresh } from '@shared/icons'
import type { Async } from '../useAsync'

export function PanelHead({
  title,
  count,
  onReload,
  children,
}: {
  title: string
  count?: number
  onReload?: () => void
  children?: ReactNode
}) {
  return (
    <div className="panel-head">
      <span className="panel-title">{title}</span>
      {count !== undefined && <span className="panel-count">{count}</span>}
      <span className="panel-head-fill" />
      {children}
      {onReload && (
        <button className="iconbtn sm" onClick={onReload} aria-label={`Refresh ${title}`}>
          <IconRefresh s={15} />
        </button>
      )}
    </div>
  )
}

export function SubHead({ icon, title, n }: { icon?: ReactNode; title: string; n?: number }) {
  return (
    <div className="subhead">
      {icon && <span className="subhead-i">{icon}</span>}
      {title}
      {n !== undefined && <span className="subhead-n">{n}</span>}
    </div>
  )
}

/** One row. `on` marks the row the detail pane is showing — on a wide screen
 *  the list stays visible beside the detail, so without it you lose your place
 *  the moment you scroll. */
export function Row({
  icon,
  title,
  sub,
  meta,
  tone,
  on,
  onClick,
}: {
  icon?: ReactNode
  title: ReactNode
  sub?: ReactNode
  meta?: ReactNode
  tone?: string
  on?: boolean
  onClick?: () => void
}) {
  const Tag = onClick ? 'button' : 'div'
  return (
    <Tag className={`prow ${on ? 'on' : ''} ${tone ?? ''}`} onClick={onClick} type={onClick ? 'button' : undefined}>
      {icon && <span className="prow-i">{icon}</span>}
      <span className="prow-main">
        <span className="prow-title">{title}</span>
        {sub && <span className="prow-sub">{sub}</span>}
      </span>
      {meta && <span className="prow-meta">{meta}</span>}
    </Tag>
  )
}

/**
 * The three states a remote list can be in, said out loud.
 *
 * A panel that shows nothing is ambiguous — still loading? nothing to show? the
 * command not granted? Over a phone link that ambiguity lands on every panel at
 * once, so each one answers it.
 */
export function AsyncBody<T>({
  state,
  empty,
  children,
}: {
  state: Async<T>
  empty: string
  children: (data: T) => ReactNode
}) {
  if (state.error) return <div className="panel-error">{state.error}</div>
  if (state.loading && state.data === undefined) return <div className="panel-loading">Loading…</div>
  const data = state.data
  if (data === undefined) return <div className="panel-empty">{empty}</div>
  const rendered = children(data)
  if (Array.isArray(data) && data.length === 0) return <div className="panel-empty">{empty}</div>
  return <>{rendered}</>
}

export function Pill({ children, tone }: { children: ReactNode; tone?: string }) {
  return <span className={`tag ${tone ?? ''}`}>{children}</span>
}

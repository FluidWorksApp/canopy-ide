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

/** Grey bars in the shape of the rows that are coming.
 *
 *  A skeleton rather than a spinner because it says *what* is loading and how
 *  much of it, and because the list does not jump when the real rows land. */
export function Skeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="skel" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div className="skel-row" key={i} style={{ ['--i' as string]: i }}>
          <span className="skel-dot" />
          <span className="skel-lines">
            {/* Varied widths — equal bars read as a broken table, not as text. */}
            <span className="skel-bar" style={{ width: `${52 + ((i * 17) % 34)}%` }} />
            <span className="skel-bar thin" style={{ width: `${28 + ((i * 23) % 40)}%` }} />
          </span>
        </div>
      ))}
    </div>
  )
}

/** A hairline that sits under a panel header while a refresh is in flight.
 *  Indeterminate, because the server cannot tell us how far along a `gh pr
 *  list` is — and a fake percentage is worse than an honest sweep. */
export function ProgressLine({ on }: { on: boolean }) {
  return <div className={`progline ${on ? 'on' : ''}`} aria-hidden />
}

/**
 * Every state a remote list can be in, said out loud.
 *
 * A panel that shows nothing is ambiguous — still loading? nothing to show? the
 * command not granted? Over a phone link that ambiguity lands on every panel at
 * once, so each one answers it: a skeleton while it is cold, the old rows plus
 * a progress line while it refreshes, a named reason when it fails, and a
 * "still going" note once it has taken long enough to worry about.
 */
export function AsyncBody<T>({
  state,
  empty,
  skeletonRows,
  children,
}: {
  state: Async<T>
  empty: string
  skeletonRows?: number
  children: (data: T) => ReactNode
}) {
  if (state.error) {
    return (
      <div className="panel-error">
        {state.error}
        <button className="ghost sm" onClick={state.reload}>
          Try again
        </button>
      </div>
    )
  }
  if (state.cold) {
    return (
      <>
        <Skeleton rows={skeletonRows} />
        {state.slow && <div className="panel-note">Still loading — the link is slow.</div>}
      </>
    )
  }
  const data = state.data
  if (data === undefined) return <div className="panel-empty">{empty}</div>
  if (Array.isArray(data) && data.length === 0) return <div className="panel-empty">{empty}</div>
  return (
    <>
      <ProgressLine on={state.loading} />
      {children(data)}
    </>
  )
}

export function Pill({ children, tone }: { children: ReactNode; tone?: string }) {
  return <span className={`tag ${tone ?? ''}`}>{children}</span>
}

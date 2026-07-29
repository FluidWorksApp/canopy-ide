// The generic renderer — the reason a new module is visible remotely for free.
//
// It draws a Node from the spine and nothing else: title, subtitle, status,
// badge, whichever actions the node says are live on it, and an attach
// affordance when it streams. No module is named here and none ever should be.
// A module ships a bespoke view only once this stops being good enough, which
// makes a custom view an upgrade rather than the price of entry.

import type { ReactNode } from 'react'
import { actionLabel, flatten } from './nodeText'
import type { Capability, Node } from './spine'

export interface NodeViewProps {
  node: Node
  selected?: boolean
  onSelect?: (node: Node) => void
  onAct?: (node: Node, action: string) => void
  /** Rendered in place of the generic body when a module ships its own view. */
  children?: ReactNode
}

export function NodeRow({ node, selected, onSelect, onAct }: NodeViewProps) {
  const clickable = Boolean(onSelect)
  return (
    <div
      className={`node-row${selected ? ' on' : ''}${clickable ? ' click' : ''}`}
      onClick={clickable ? () => onSelect?.(node) : undefined}
      data-ref={node.ref}
    >
      {node.status ? <span className={`node-dot ${node.status}`} /> : null}
      <span className="node-main">
        <span className="node-title">{node.title}</span>
        {node.subtitle ? <span className="node-sub">{node.subtitle}</span> : null}
      </span>
      <NodeBadge node={node} />
      {node.actions?.length && onAct ? (
        <span className="node-acts">
          {node.actions.map((a) => (
            <button
              key={a}
              type="button"
              className="node-act"
              onClick={(e) => {
                e.stopPropagation()
                onAct(node, a)
              }}
            >
              {actionLabel(a)}
            </button>
          ))}
        </span>
      ) : null}
    </div>
  )
}

function NodeBadge({ node }: { node: Node }) {
  const b = node.badge
  if (!b) return null
  if (b.text) return <span className="node-badge">{b.text}</span>
  if (typeof b.count === 'number' && b.count > 0) {
    return <span className="node-badge">{b.count}</span>
  }
  if (b.dot) return <span className="node-badge dot" />
  return null
}

export interface NodeListProps {
  nodes: Node[]
  /** How many the publisher dropped to stay inside its budget. Shown rather
   *  than hidden — a truncated list that looks complete is worse than a short
   *  one that says so. */
  more?: number
  selectedRef?: string
  empty?: ReactNode
  onSelect?: (node: Node) => void
  onAct?: (node: Node, action: string) => void
}

export function NodeList({ nodes, more = 0, selectedRef, empty, onSelect, onAct }: NodeListProps) {
  if (!nodes.length) return <div className="node-empty">{empty ?? 'Nothing here yet.'}</div>
  return (
    <div className="node-list">
      {nodes.map((n) => (
        <NodeRow
          key={n.ref}
          node={n}
          selected={n.ref === selectedRef}
          onSelect={onSelect}
          onAct={onAct}
        />
      ))}
      {more > 0 ? <div className="node-more">{more} more not shown</div> : null}
    </div>
  )
}

/** What a module that cannot travel renders as. The reason comes from the
 *  manifest, so this is never a blank space the user has to interpret. */
export function UnavailableCard({ title, capability }: { title: string; capability: Capability }) {
  if (capability.level !== 'none') return null
  return (
    <div className="node-unavailable">
      <div className="node-unavailable-title">{title} isn't available remotely</div>
      <div className="node-unavailable-why">{capability.reason}</div>
    </div>
  )
}

/** The fallback detail body: a node's own fields, rendered flat. Deliberately
 *  plain — it exists so every module has something honest to show on day one. */
export function NodeDetail({ node, onAct }: { node: Node; onAct?: (node: Node, action: string) => void }) {
  const rows = flatten(node.data)
  return (
    <div className="node-detail">
      <div className="node-detail-head">
        <span className="node-title">{node.title}</span>
        {node.subtitle ? <span className="node-sub">{node.subtitle}</span> : null}
      </div>
      {rows.length ? (
        <dl className="node-fields">
          {rows.map(([k, v]) => (
            <div className="node-field" key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {node.actions?.length && onAct ? (
        <div className="node-acts">
          {node.actions.map((a) => (
            <button key={a} type="button" className="node-act" onClick={() => onAct(node, a)}>
              {actionLabel(a)}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

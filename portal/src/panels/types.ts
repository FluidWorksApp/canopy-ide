// What a panel is, and what it is handed.
//
// A panel is the portal half of a remote module: the module's manifest says what
// it may reach (and Rust's GRANTS decides whether it gets it), and the panel
// says what that looks like. Nothing else in the shell knows a panel's name —
// both shells render whatever is in PANELS, so a new module becomes a rail icon
// on a laptop and a tab on a phone by being added to one list.

import type { ReactNode } from 'react'
import type { AgentRow, Project, RemoteCli, Stat } from '@shared/model'
import type { PendingItem } from '@shared/notifications'
import type { Rpc } from '../rpc'
import type { Transport } from '@shared/transport'

/** Anything the detail pane can show. Panels produce these; `Detail` renders
 *  them; neither knows about the other's internals. */
export type Target =
  | { kind: 'terminal'; pty: number }
  | { kind: 'history'; key: string }
  | { kind: 'file'; path: string }
  | { kind: 'diff'; repo: string; path: string; staged: boolean }
  | { kind: 'commit'; repo: string; hash: string; subject: string }
  | { kind: 'pr'; repo: string; number: number; title: string }
  | { kind: 'text'; title: string; subtitle?: string; body: string; mono?: boolean }
  /** A body the *detail pane* fetches, rather than the row that opened it.
   *
   *  The difference is the whole point: a row that awaits an RPC before calling
   *  `open` looks broken, because nothing at all happens until the round trip
   *  finishes. These open instantly onto a loading frame and fill in. */
  | { kind: 'research'; projectId: string; id: string; title: string }
  | { kind: 'doc'; path: string; roots: string[]; title: string }

export function targetKey(t: Target): string {
  switch (t.kind) {
    case 'terminal':
      return `terminal:${t.pty}`
    case 'history':
      return `history:${t.key}`
    case 'file':
      return `file:${t.path}`
    case 'diff':
      return `diff:${t.repo}:${t.path}:${t.staged}`
    case 'commit':
      return `commit:${t.repo}:${t.hash}`
    case 'pr':
      return `pr:${t.repo}:${t.number}`
    case 'text':
      return `text:${t.title}`
    case 'research':
      return `research:${t.projectId}:${t.id}`
    case 'doc':
      return `doc:${t.path}`
  }
}

export interface PanelCtx {
  rpc: Rpc
  transport: Transport
  /** Projects the IDE currently has open, in its own order. */
  projects: Project[]
  /** The project the shell is pointed at. Undefined only before the first
   *  snapshot lands. */
  project?: Project
  /** Every scoped root, for the commands that take a root list. */
  roots: string[]
  /** Fused agent rows — digests + live PTYs + usage, from shared/model. */
  rows: AgentRow[]
  stats: Map<number, Stat>
  pending: PendingItem[]
  clis: RemoteCli[]
  /** What the detail pane is showing, so a list can mark its own row. */
  openKey?: string
  open: (t: Target) => void
  /** Start a terminal running `command` in `cwd` (undefined = a plain shell). */
  spawn: (
    cwd: string,
    command?: string,
    options?: { agent?: string; profile?: string },
  ) => void
}

/** A repo path for the git-family commands: any directory inside the repo does,
 *  since Rust resolves the toplevel itself. */
export function repoOf(ctx: PanelCtx): string | undefined {
  return ctx.project?.components?.[0]?.path
}

export interface PanelDef {
  id: string
  title: string
  Icon: (p: { s?: number }) => ReactNode
  /** `project` panels are hidden until a project is selected and re-query when
   *  it changes; `global` ones span every open project. */
  scope: 'global' | 'project'
  /** A count for the rail, derived only from what the snapshot already carries.
   *  Panels whose data needs a round trip have none — a badge that costs a
   *  request per panel per poll is how a phone's battery disappears. */
  badge?: (ctx: PanelCtx) => number
  /** Whether the badge should read as urgent (a colour, not just a number). */
  urgent?: (ctx: PanelCtx) => boolean
  List: (props: { ctx: PanelCtx }) => ReactNode
}

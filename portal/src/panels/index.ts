// Remote's feature registry. Compact mode reads this order; wide mode places
// the same panels through WIDE_RAIL_GROUPS below.
//
// Adding a remote module means adding its panel here, then choosing its wide
// group. Compact leads with notifications because that is why you pick up the
// phone; wide follows the desktop's grouped activity rail instead.

import { agentsPanel, serversPanel, terminalsPanel } from './agents'
import { companionPanel } from './companion'
import { notificationsPanel, usagePanel } from './alerts'
import { changesPanel, filesPanel } from './code'
import { instructionsPanel, researchPanel, ticketsPanel, toolsPanel } from './knowledge'
import { gitPanel, prsPanel } from './vcs'
import type { PanelDef } from './types'

export const PANELS: PanelDef[] = [
  notificationsPanel,
  companionPanel,
  agentsPanel,
  terminalsPanel,
  filesPanel,
  changesPanel,
  gitPanel,
  prsPanel,
  serversPanel,
  ticketsPanel,
  researchPanel,
  instructionsPanel,
  toolsPanel,
  usagePanel,
]

/** Home plus these three panels and More fills the phone's five destinations. */
export const COMPACT_PRIMARY = ['notifications', 'agents', 'changes']

/** Wide Remote uses the desktop rail's information architecture. The panel
 * renderers stay remote-specific; only their placement is shared vocabulary. */
export const WIDE_RAIL_GROUPS = [
  { id: 'project', label: 'Project', panels: ['files', 'servers'] },
  { id: 'review', label: 'Source control & Review', panels: ['changes', 'git', 'prs', 'tickets'] },
  { id: 'agents', label: 'Agents', panels: ['companion', 'agents', 'research', 'instructions'] },
  { id: 'runtime', label: 'Runtime', panels: ['terminals'] },
] as const

export const WIDE_RAIL_FOOTER = ['tools', 'usage'] as const

export function panelById(id: string): PanelDef | undefined {
  return PANELS.find((p) => p.id === id)
}

export type { PanelCtx, PanelDef, Target } from './types'

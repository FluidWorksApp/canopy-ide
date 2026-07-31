// The rail, in order.
//
// Both shells render this list and nothing else: the wide one turns it into an
// icon rail beside a list pane, the compact one into a bottom tab bar plus a
// "More" sheet. Adding a remote module means adding its panel here — neither
// shell has a name of a feature anywhere in it.
//
// The order is the desktop's rail order, because muscle memory is the whole
// point of a rail: Notifications first (it is why you picked the phone up),
// then the working surfaces, then the reference ones.

import { agentsPanel, serversPanel, terminalsPanel } from './agents'
import { notificationsPanel, usagePanel } from './alerts'
import { changesPanel, filesPanel } from './code'
import { instructionsPanel, researchPanel, ticketsPanel, toolsPanel } from './knowledge'
import { gitPanel, prsPanel } from './vcs'
import type { PanelDef } from './types'

export const PANELS: PanelDef[] = [
  notificationsPanel,
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

/** What a phone shows without opening the More sheet. Four plus More is the
 *  most a thumb reaches comfortably, and these four are what someone away from
 *  their desk actually opens. */
export const COMPACT_PRIMARY = ['notifications', 'agents', 'changes', 'files']

export function panelById(id: string): PanelDef | undefined {
  return PANELS.find((p) => p.id === id)
}

export type { PanelCtx, PanelDef, Target } from './types'

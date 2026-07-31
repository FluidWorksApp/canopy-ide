// The one place a module is switched on. Imports are explicit — a glob would
// hide a module that was written and never registered, and registry.test.ts
// checks this list against the directory for exactly that reason.

import type { RemoteManifest } from '../registry'
import { Registry } from '../registry'
import agents from './agents'
import browser from './browser'
import changes from './changes'
import core from './core'
import files from './files'
import git from './git'
import instructions from './instructions'
import notifications from './notifications'
import prs from './prs'
import research from './research'
import servers from './servers'
import stats from './stats'
import terminals from './terminals'
import tickets from './tickets'
import tools from './tools'

export const MANIFESTS: RemoteManifest[] = [
  agents,
  browser,
  changes,
  core,
  files,
  git,
  instructions,
  notifications,
  prs,
  research,
  servers,
  stats,
  terminals,
  tickets,
  tools,
]

export const registry = new Registry(MANIFESTS)

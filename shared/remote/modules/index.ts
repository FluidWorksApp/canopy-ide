// The one place a module is switched on. Imports are explicit — a glob would
// hide a module that was written and never registered, and registry.test.ts
// checks this list against the directory for exactly that reason.

import type { RemoteManifest } from '../registry'
import { Registry } from '../registry'
import agents from './agents'
import browser from './browser'
import core from './core'
import terminals from './terminals'

export const MANIFESTS: RemoteManifest[] = [agents, browser, core, terminals]

export const registry = new Registry(MANIFESTS)

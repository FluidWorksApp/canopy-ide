import type { RemoteManifest } from '../registry'

// The research store: what has been investigated and what shipped from it.
// Read-only — `research_write` is how an agent records a finding, and a finding
// recorded from a phone with no repo under it would have nothing to point at.
const research: RemoteManifest = {
  id: 'research',
  title: 'Research',
  scope: 'project',
  capability: { level: 'view' },
  kinds: ['entry'],
  commands: [
    { name: 'research_list', scope: 'view' },
    { name: 'research_get', scope: 'view' },
  ],
  publish: null,
}

export default research

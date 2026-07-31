import type { RemoteManifest } from '../registry'

// The files every agent reads before it sees any code — the project's, the
// user's, and the skill packs. Worth reaching remotely for the same reason it
// has a tab: when an agent behaves oddly, this is the first thing to check.
const instructions: RemoteManifest = {
  id: 'instructions',
  title: 'Instructions',
  scope: 'project',
  capability: { level: 'view' },
  kinds: ['doc'],
  commands: [
    { name: 'instructions_scan', scope: 'view' },
    { name: 'instructions_read', scope: 'view' },
  ],
  publish: null,
}

export default instructions

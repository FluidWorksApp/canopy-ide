import type { RemoteManifest } from '../registry'

// Issues from GitHub. Linear is deliberately not here: `linear_issues` takes the
// API key as an argument, so granting it would mean the phone holding the key.
// That is the `sensitive` line, and it sits on the desktop side of it.
const tickets: RemoteManifest = {
  id: 'tickets',
  title: 'Issues',
  scope: 'project',
  capability: { level: 'view' },
  kinds: ['ticket'],
  commands: [{ name: 'gh_issue_list', scope: 'view' }],
  publish: null,
}

export default tickets

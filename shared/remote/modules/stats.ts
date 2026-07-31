import type { RemoteManifest } from '../registry'

// Plan limits and spend. `plan_usage` is the one that matters away from the
// desk: it is the answer to "can I keep going or am I about to hit the cap?",
// and it vanishes from the desktop status bar exactly when you are not there.
const stats: RemoteManifest = {
  id: 'stats',
  title: 'Usage',
  scope: 'global',
  capability: { level: 'view' },
  kinds: ['usage'],
  commands: [{ name: 'plan_usage', scope: 'view' }],
  publish: null,
}

export default stats

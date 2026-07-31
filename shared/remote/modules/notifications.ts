import type { RemoteManifest } from '../registry'

// Every agent that is blocked on you, surfaced as a card and — once the browser
// grants permission — as a real OS notification on the phone.
//
// No commands: the `agent:event` stream the server already forwards to every
// socket is the whole source, and `derivePending` in shared/notifications.ts
// turns it into cards identically on both shells. Answering happens by writing
// to the agent's PTY, which the terminals module already grants.
const notifications: RemoteManifest = {
  id: 'notifications',
  title: 'Notifications',
  scope: 'global',
  capability: { level: 'full' },
  kinds: ['alert'],
  publish: null,
}

export default notifications

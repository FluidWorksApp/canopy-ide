import type { RemoteManifest } from '../registry'

// Digests are machine-global and live in Rust, so an agent is visible remotely
// whether or not the desktop currently has a tab open on it.
const agents: RemoteManifest = {
  id: 'agents',
  title: 'Agents',
  scope: 'project',
  capability: { level: 'full' },
  kinds: ['agent'],
  commands: [
    { name: 'session_digests', scope: 'view' },
    { name: 'agent_usage', scope: 'view' },
    { name: 'session_forget', scope: 'drive' },
  ],
  streams: ['pty'],
  publish: null,
}

export default agents

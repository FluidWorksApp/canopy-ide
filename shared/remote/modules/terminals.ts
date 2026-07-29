import type { RemoteManifest } from '../registry'

// Every live PTY is already enumerable from Rust — id, title, cwd, grid, and a
// scrollback ring for catch-up — so there is nothing for the desktop to mirror.
const terminals: RemoteManifest = {
  id: 'terminals',
  title: 'Terminals',
  scope: 'project',
  capability: { level: 'full' },
  kinds: ['terminal'],
  commands: [
    { name: 'pty_spawn_detached', scope: 'drive' },
    { name: 'pty_resize', scope: 'drive' },
    { name: 'pty_kill', scope: 'drive' },
  ],
  streams: ['pty'],
  publish: null,
}

export default terminals

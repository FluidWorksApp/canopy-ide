import type { RemoteManifest } from '../registry'

// Dev servers and one-off runs. No commands: a run IS a PTY, and the snapshot
// already carries every live PTY with the ports its process tree is listening
// on (`pty:stats`). The Rust-first rule says a module whose facts the core
// already knows publishes nothing — so this one is a manifest, a stream, and no
// mirror at all.
const servers: RemoteManifest = {
  id: 'servers',
  title: 'Servers',
  scope: 'project',
  capability: { level: 'full' },
  kinds: ['run'],
  streams: ['pty'],
  publish: null,
}

export default servers

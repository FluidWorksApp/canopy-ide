import type { RemoteManifest } from '../registry'

// The one that cannot make the trip, declared rather than omitted. A missing
// surface reads as a bug; this renders as a card that says why. It becomes
// `view` the day a browserFrame stream provider is registered — a change in
// Rust and this line, and nowhere in the shell.
const browser: RemoteManifest = {
  id: 'browser',
  title: 'Browser',
  scope: 'project',
  capability: {
    level: 'none',
    reason:
      'Remote preview forwarding is not connected yet. Embedded and Playwright previews currently use host-local addresses.',
  },
  kinds: ['page'],
}

export default browser

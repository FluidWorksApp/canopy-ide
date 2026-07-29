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
      'The in-app browser is a native view the compositor draws over the window — there is no picture of it to send.',
  },
  kinds: ['page'],
}

export default browser

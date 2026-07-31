import type { RemoteManifest } from '../registry'

// Projects are the addressing space every other module parents its nodes to,
// which is the only reason this one is called core. It is still an ordinary
// module: the spine has no idea what a project is.
const core: RemoteManifest = {
  id: 'core',
  title: 'Projects',
  scope: 'global',
  capability: { level: 'full' },
  kinds: ['project'],
  commands: [{ name: 'store_load', scope: 'view' }],
  publish: null,
}

export default core

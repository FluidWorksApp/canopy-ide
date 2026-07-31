import type { RemoteManifest } from '../registry'

// MCP servers the agents can reach, from every CLI's config. Discovery only:
// `mcp_call_tool` would let a phone invoke arbitrary tools with the desktop's
// credentials, which is the whole attack surface of every server at once.
const tools: RemoteManifest = {
  id: 'tools',
  title: 'Tools',
  scope: 'project',
  capability: { level: 'view' },
  kinds: ['server'],
  commands: [{ name: 'mcp_servers', scope: 'view' }],
  publish: null,
}

export default tools

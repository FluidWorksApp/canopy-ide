#!/usr/bin/env node
// Service entry: reads the environment and listens on loopback for Caddy.
import { createEdge } from './edge.mjs';

const edge = createEdge({
  secret: process.env.CANOPY_REMOTE_EDGE_SECRET,
  domain: process.env.CANOPY_REMOTE_DOMAIN || 'remote.canopyide.dev',
  authOrigin: process.env.CANOPY_REMOTE_AUTH_ORIGIN || 'https://canopyide.dev',
  log: (...args) => console.log(new Date().toISOString(), ...args),
});
const port = Number(process.env.PORT || 8080);
const host = process.env.CANOPY_REMOTE_EDGE_HOST || '127.0.0.1';
const address = await edge.listen(port, host);
console.log(`canopy-remote-edge listening on ${address.address}:${address.port}`);
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => { edge.close().finally(() => process.exit(0)); });
}

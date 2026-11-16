// Where a workspace lives. Defaults are the workspace image's layout; the
// process backend (process-workspaces.mjs) points them at the user's own folders.
import path from 'node:path';

const env = process.env;
const absolute = (value, fallback) => (value && path.isAbsolute(value) ? path.resolve(value) : fallback);
const port = (value, fallback) => { const n = Number(value); return Number.isInteger(n) && n > 0 && n < 65536 ? n : fallback; };

export const WORKSPACE_ROOT = absolute(env.CANOPY_WORKSPACE_ROOT, '/workspace');
export const AGENT_HOME = absolute(env.CANOPY_AGENT_HOME, '/home/agent');
export const AGENT_USER = env.CANOPY_AGENT_USER || 'agent';
// Literal, not this file's folder: Docker hosts load some of these modules from /opt/canopy-host.
export const CANOPY_CODE = absolute(env.CANOPY_CODE_DIR, '/opt/canopy');
export const RUNNER_PORT = port(env.CANOPY_RUNNER_PORT, 8080);
export const NATIVE_PORT = port(env.CANOPY_NATIVE_PORT, 8081);
// The image publishes these ports to the host; a process workspace keeps them on loopback.
export const RUNNER_BIND = env.CANOPY_RUNNER_BIND || '0.0.0.0';
export const RUNNER_URL = `http://127.0.0.1:${RUNNER_PORT}`;

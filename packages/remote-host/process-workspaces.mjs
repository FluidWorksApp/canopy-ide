// Workspaces as plain processes: runner.mjs runs as the installing user, with no
// Docker, image or root. Same open() result as DockerWorkspaces, so the gateway
// is unchanged. No container isolation: agents run with this user's rights.
import { spawn as childSpawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CODE_DIR = path.dirname(fileURLToPath(import.meta.url));

export function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

export class ProcessWorkspaces {
  constructor({ secret, home = os.homedir(), user = os.userInfo().username, spawn = childSpawn, fetchImpl = fetch, port = freePort, readyMs = 20000, log = console }) {
    if (!secret || secret.length < 32) throw new Error('Host secret required');
    Object.assign(this, { secret, home, user, spawn, fetchImpl, port, readyMs, log });
    this.running = new Map();
    this.children = new Map();
  }

  token(id) { return createHmac('sha256', this.secret).update(`workspace:${id}`).digest('hex'); }

  root(workspace) { return path.resolve(workspace.root ?? path.join(this.home, 'work')); }

  async open(workspace) {
    let entry = this.running.get(workspace.id);
    if (!entry) { entry = this.start(workspace); this.running.set(workspace.id, entry); }
    try { return await entry; }
    catch (error) { if (this.running.get(workspace.id) === entry) this.running.delete(workspace.id); throw error; }
  }

  async start(workspace) {
    const root = this.root(workspace), token = this.token(workspace.id);
    await mkdir(root, { recursive: true });
    const [runnerPort, nativePort] = [await this.port(), await this.port()];
    const child = this.spawn(process.execPath, [path.join(CODE_DIR, 'runner.mjs')], {
      cwd: root, stdio: ['ignore', 'inherit', 'inherit'],
      env: {
        ...process.env, CANOPY_RUNNER_TOKEN: token, CANOPY_WORKSPACE_ID: workspace.id, CANOPY_ACCOUNTS: (workspace.accounts ?? []).join(','),
        CANOPY_WORKSPACE_ROOT: root, CANOPY_AGENT_HOME: this.home, CANOPY_AGENT_USER: this.user, CANOPY_CODE_DIR: CODE_DIR,
        CANOPY_RUNNER_PORT: String(runnerPort), CANOPY_NATIVE_PORT: String(nativePort), CANOPY_RUNNER_BIND: '127.0.0.1',
      },
    });
    this.children.set(workspace.id, child);
    const exited = new Promise(resolve => child.once('exit', code => resolve(code)));
    void exited.then(code => {
      // The next open() starts a fresh runner.
      if (this.children.get(workspace.id) === child) { this.children.delete(workspace.id); this.running.delete(workspace.id); }
      this.log.warn?.(`Workspace ${workspace.id} runner exited (${code})`);
    });
    const url = `http://127.0.0.1:${runnerPort}`, nativeUrl = `http://127.0.0.1:${nativePort}`;
    const deadline = Date.now() + this.readyMs;
    for (;;) {
      const done = await Promise.race([exited.then(code => ({ code })), this.ready(url, token).then(ok => ({ ok }))]);
      if (done.code !== undefined) throw new Error(`Workspace runner exited during start (${done.code})`);
      if (done.ok) break;
      if (Date.now() > deadline) { child.kill(); throw new Error('Workspace runner did not start'); }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    return { url, nativeUrl, token };
  }

  async ready(url, token) {
    try { const response = await this.fetchImpl(`${url}/sessions`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1000) }); return response.ok; }
    catch { return false; }
  }

  close() {
    for (const child of this.children.values()) child.kill();
    this.children.clear();
    this.running.clear();
  }
}

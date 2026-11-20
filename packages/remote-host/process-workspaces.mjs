// Workspaces as plain processes: runner.mjs runs as the installing user, with no
// Docker, image or root. Same open() result as DockerWorkspaces, so the gateway
// is unchanged. No container isolation: agents run with this user's rights.
import { execFile, spawn as childSpawn } from 'node:child_process';
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
    // What session-resume.mjs watches: each open workspace's runner, and when it started.
    this.runtimes = new Map();
    this.started = new Map();
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
    const startedAt = new Date().toISOString();
    const exited = new Promise(resolve => child.once('exit', code => resolve(code)));
    void exited.then(code => {
      // The next open() starts a fresh runner.
      if (this.children.get(workspace.id) === child) { this.children.delete(workspace.id); this.running.delete(workspace.id); this.runtimes.delete(workspace.id); this.started.delete(workspace.id); }
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
    const runtime = { url, nativeUrl, token };
    this.runtimes.set(workspace.id, { workspace, runtime });
    this.started.set(workspace.id, startedAt);
    return runtime;
  }

  /** The runner as session-resume.mjs reads a container: running, and since
   *  when. A new runner (the host restarted) is what it treats as a restart.
   *  Not `inspectRuntime`: that would also add a per-runtime machine section. */
  runnerState(workspace) {
    const startedAt = this.started.get(workspace.id);
    return startedAt && this.children.has(workspace.id) ? { State: { Running: true, Paused: false, Restarting: false, StartedAt: startedAt } } : null;
  }

  /** This machine's process table, in session-resume.mjs's PROCESS_SCRIPT format. */
  listProcesses(script) {
    return new Promise((resolve, reject) => execFile('/bin/sh', ['-c', script], { maxBuffer: 16 * 1024 * 1024, timeout: 10000 }, (error, stdout) => error ? reject(error) : resolve(stdout)));
  }

  async ready(url, token) {
    try { const response = await this.fetchImpl(`${url}/sessions`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1000) }); return response.ok; }
    catch { return false; }
  }

  close() {
    for (const child of this.children.values()) child.kill();
    this.children.clear();
    this.running.clear();
    this.runtimes.clear();
    this.started.clear();
  }
}

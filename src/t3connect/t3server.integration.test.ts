// @vitest-environment node
// Against a real T3 Code server: skipped unless T3_BIN names its binary, e.g.
//   T3_BIN=~/.t3/runtime/versions/0.1.7/t3 npx vitest run src/t3connect/t3server.integration.test.ts
// It starts `T3_BIN serve` on a temporary base dir (and a temporary HOME, so
// nothing reads or writes the user's own ~/.t3) and a spare loopback port,
// pairs with `T3_BIN pair`, redeems the link with the same HTTP calls the
// Rust side makes (http.ts), opens the RPC socket with rpc.ts, and lists
// projects and files and drives a terminal. The server is killed at the end,
// pass or fail. T3_RECORD_FRAMES=path writes every socket frame there.
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { T3_CANOPY_SCOPES } from "./contracts";
import {
  exchangePairingCredential,
  fetchEnvironmentDescriptor,
  fetchSessionState,
  issueWebSocketTicket,
  rpcSocketUrl,
} from "./http";
import { CANOPY_TERMINAL_THREAD_ID, listProjects, t3 } from "./methods";
import { parseT3PairingLink } from "./pairing";
import { RpcError, T3RpcClient } from "./rpc";

const BIN = process.env.T3_BIN?.replace(/^~(?=\/)/, process.env.HOME ?? "~");
const RECORD = process.env.T3_RECORD_FRAMES;

function sparePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function run(bin: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    execFile(bin, args, { env, timeout: 60_000 }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/** `t3 pair --json` as the task describes it; 0.1.7's `pair` prints text
 *  instead ("Pairing URL: …"), so fall back to reading that line. */
async function pairingLink(bin: string, baseDir: string, env: NodeJS.ProcessEnv): Promise<{ link: string; how: string }> {
  const json = await run(bin, ["pair", "--base-dir", baseDir, "--json", "--label", "canopy-test", "--ttl", "5m"], env);
  if (json.code === 0) {
    try {
      const parsed = JSON.parse(json.stdout) as Record<string, unknown>;
      const link = [parsed.pairingUrl, parsed.url, parsed.link].find(value => typeof value === "string");
      if (typeof link === "string") return { link, how: "pair --json" };
    } catch { /* not JSON: fall through */ }
  }
  const text = await run(bin, ["pair", "--base-dir", baseDir, "--label", "canopy-test", "--ttl", "5m"], env);
  const match = /Pairing URL:\s*(\S+)/.exec(text.stdout);
  if (!match) throw new Error(`t3 pair gave no link.\n--json: ${json.code} ${json.stderr.slice(0, 400)}\ntext: ${text.code} ${text.stdout.slice(0, 400)} ${text.stderr.slice(0, 400)}`);
  return { link: match[1], how: `pair (text; --json exited ${json.code}: ${json.stderr.trim().split("\n")[0] ?? ""})` };
}

/** A WebSocket that also writes every frame to T3_RECORD_FRAMES. */
function recordingWebSocket(path: string): typeof WebSocket {
  return class extends WebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      this.addEventListener("message", event => appendFileSync(path, `< ${String(event.data)}\n`));
    }
    override send(data: Parameters<WebSocket["send"]>[0]) {
      appendFileSync(path, `> ${String(data)}\n`);
      super.send(data);
    }
  };
}

describe.skipIf(!BIN)("T3 Code server (T3_BIN)", () => {
  let server: ChildProcess | undefined;
  let root = "";
  let baseDir = "";
  let projectDir = "";
  let env: NodeJS.ProcessEnv = {};
  let httpBase = "";
  let serverLog = "";

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "canopy-t3-"));
    baseDir = join(root, "base");
    projectDir = join(root, "project");
    const home = join(root, "home");
    for (const dir of [baseDir, projectDir, home, join(projectDir, "src")]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(projectDir, "README.md"), "# Canopy test project\n");
    writeFileSync(join(projectDir, "src", "hello.ts"), "export const hello = 'world';\n");
    const port = await sparePort();
    env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share"), XDG_STATE_HOME: join(home, ".local/state"), T3CODE_HOME: baseDir };
    if (RECORD) writeFileSync(RECORD, "");
    server = spawn(BIN!, ["serve", "--base-dir", baseDir, "--port", String(port), "--host", "127.0.0.1", "--no-browser", projectDir], {
      cwd: projectDir, env, stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout?.on("data", chunk => { serverLog += String(chunk); });
    server.stderr?.on("data", chunk => { serverLog += String(chunk); });
    httpBase = `http://127.0.0.1:${port}/`;
    const deadline = Date.now() + 90_000;
    for (;;) {
      if (server.exitCode !== null) throw new Error(`t3 serve exited ${server.exitCode}:\n${serverLog.slice(-2000)}`);
      try {
        await fetchEnvironmentDescriptor(httpBase);
        break;
      } catch {
        if (Date.now() > deadline) throw new Error(`t3 serve never answered:\n${serverLog.slice(-2000)}`);
        await new Promise(resolve => setTimeout(resolve, 300));
      }
    }
  }, 120_000);

  afterAll(async () => {
    if (server && server.exitCode === null) {
      const exited = new Promise(resolve => server!.once("exit", resolve));
      server.kill("SIGTERM");
      const forced = setTimeout(() => server?.kill("SIGKILL"), 5_000);
      await exited;
      clearTimeout(forced);
    }
    if (root) rmSync(root, { recursive: true, force: true });
  }, 30_000);

  it("pairs, opens the socket, lists projects and files, and drives a terminal", async () => {
    const log = (line: string) => console.log(`[t3] ${line}`);
    const descriptor = await fetchEnvironmentDescriptor(httpBase);
    log(`descriptor: ${descriptor.label} env=${descriptor.environmentId} version=${descriptor.serverVersion} protocol=${descriptor.orchestrationProtocolVersion}`);
    expect(descriptor.environmentId).toBeTruthy();

    const { link, how } = await pairingLink(BIN!, baseDir, env);
    log(`pairing link via ${how}: ${link.replace(/token=[^&]+/, "token=…")}`);
    const target = parseT3PairingLink(link);
    expect(new URL(target.httpBaseUrl).port).toBe(new URL(httpBase).port);
    // Check the descriptor before spending the code, as T3's onboarding does.
    expect((await fetchEnvironmentDescriptor(target.httpBaseUrl)).environmentId).toBe(descriptor.environmentId);

    const token = await exchangePairingCredential({ httpBaseUrl: target.httpBaseUrl, credential: target.credential, scopes: T3_CANOPY_SCOPES, clientLabel: "Canopy test", clientOs: "Linux" });
    log(`token: type=${token.token_type} expires_in=${token.expires_in} scope="${token.scope}"`);
    expect(token.token_type).toBe("Bearer");
    expect(token.scope.split(" ").sort()).toEqual([...T3_CANOPY_SCOPES].sort());
    // A pairing code works once.
    await expect(exchangePairingCredential({ httpBaseUrl: target.httpBaseUrl, credential: target.credential, scopes: T3_CANOPY_SCOPES })).rejects.toThrow();

    const session = await fetchSessionState(target.httpBaseUrl, token.access_token);
    log(`session: authenticated=${session.authenticated} permissions=${(session.permissions ?? session.scopes ?? []).join(",")}`);
    expect(session.authenticated).toBe(true);

    const ticket = await issueWebSocketTicket(target.httpBaseUrl, token.access_token);
    expect(ticket.ticket).toBeTruthy();
    const rpc = new T3RpcClient(rpcSocketUrl(target.httpBaseUrl, ticket.ticket, "Linux"), RECORD ? { WebSocket: recordingWebSocket(RECORD) } : {});
    try {
      await rpc.ready();
      const config = await t3.getConfig(rpc);
      expect(config.environment.environmentId).toBe(descriptor.environmentId);

      // Canopy's token cannot add projects (projects.mutate needs
      // orchestration:operate, which Canopy never asks for).
      const refused = await rpc.call("projects.mutate", { type: "project.create", commandId: crypto.randomUUID(), projectId: crypto.randomUUID(), title: "nope", workspaceRoot: projectDir }).catch(error => error);
      log(`projects.mutate with Canopy's scopes: ${refused instanceof RpcError ? refused.tag : refused}`);
      expect(refused).toBeInstanceOf(RpcError);
      expect((refused as RpcError).tag).toBe("EnvironmentAuthorizationError");

      // So the test adds the project the way T3's own app does, with a
      // second, full-scope pairing.
      const admin = parseT3PairingLink((await pairingLink(BIN!, baseDir, env)).link);
      const adminToken = await exchangePairingCredential({ httpBaseUrl: admin.httpBaseUrl, credential: admin.credential });
      const adminRpc = new T3RpcClient(rpcSocketUrl(admin.httpBaseUrl, (await issueWebSocketTicket(admin.httpBaseUrl, adminToken.access_token)).ticket));
      try {
        await adminRpc.ready();
        await adminRpc.call("projects.mutate", { type: "project.create", commandId: crypto.randomUUID(), projectId: crypto.randomUUID(), title: "project", workspaceRoot: projectDir });
      } finally {
        adminRpc.close();
      }

      const projects = await listProjects(rpc);
      log(`projects: ${projects.map(p => `${p.title} @ ${p.workspaceRoot}`).join("; ")}`);
      const project = projects.find(p => p.workspaceRoot === projectDir || p.workspaceRoot.endsWith("/project"));
      expect(project).toBeTruthy();
      const cwd = project!.workspaceRoot;

      const top = await t3.listEntries(rpc, { cwd, directoryPath: "" });
      log(`listEntries(""): ${top.entries.map(e => `${e.kind[0]}:${e.path}`).join(" ")}`);
      expect(top.entries).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: "README.md", kind: "file" }),
        expect.objectContaining({ path: "src", kind: "directory" }),
      ]));
      const nested = await t3.listEntries(rpc, { cwd, directoryPath: "src" });
      expect(nested.entries.map(e => e.path)).toContain("src/hello.ts");

      const read = await t3.readFile(rpc, { cwd, relativePath: "src/hello.ts" });
      expect(read.contents).toBe("export const hello = 'world';\n");
      await t3.writeFile(rpc, { cwd, relativePath: "src/hello.ts", contents: "export const hello = 'canopy';\n" });
      expect(readFileSync(join(projectDir, "src", "hello.ts"), "utf8")).toBe("export const hello = 'canopy';\n");
      const found = await t3.searchEntries(rpc, { cwd, query: "hello", limit: 10 });
      log(`searchEntries("hello"): ${found.entries.map(e => e.path).join(" ")}`);
      expect(found.entries.map(e => e.path)).toContain("src/hello.ts");

      // Not Canopy's rule to enforce, but worth knowing what the server allows:
      // a cwd that is not a project root (here its parent directory).
      const outside = await t3.readFile(rpc, { cwd: root, relativePath: "project/README.md" }).then(
        result => `answered (${result.byteLength} bytes)`,
        error => `refused (${error instanceof RpcError ? error.tag : String(error)})`,
      );
      log(`readFile with a non-project cwd: ${outside}`);

      const terminalId = "canopy-it";
      const opened = await t3.terminalOpen(rpc, { threadId: CANOPY_TERMINAL_THREAD_ID, terminalId, cwd, cols: 100, rows: 30 });
      log(`terminal.open: status=${opened.status} pid=${opened.pid}`);
      let output = "";
      let sawSnapshot = false;
      const sawMarker = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no marker in terminal output: ${JSON.stringify(output.slice(-500))}`)), 20_000);
        const attach = t3.terminalAttach(rpc, { threadId: CANOPY_TERMINAL_THREAD_ID, terminalId, cwd, cols: 100, rows: 30 }, event => {
          if (event.type === "snapshot") { sawSnapshot = true; output += event.snapshot.history; }
          if (event.type === "output") output += event.data;
          if (output.includes("CANOPY_T3_OK_42")) { clearTimeout(timer); attach.cancel(); resolve(); }
        });
        attach.done.catch(reject);
      });
      await t3.terminalResize(rpc, { threadId: CANOPY_TERMINAL_THREAD_ID, terminalId, cols: 120, rows: 40 });
      await t3.terminalWrite(rpc, { threadId: CANOPY_TERMINAL_THREAD_ID, terminalId, data: "echo CANOPY_T3_OK_$((40+2))\r" });
      await sawMarker;
      log(`terminal output carried the marker (snapshot first: ${sawSnapshot})`);
      expect(sawSnapshot).toBe(true);
      await t3.terminalClose(rpc, { threadId: CANOPY_TERMINAL_THREAD_ID, terminalId, deleteHistory: true });
      const afterClose = await t3.terminalWrite(rpc, { threadId: CANOPY_TERMINAL_THREAD_ID, terminalId, data: "x" }).catch(error => error);
      log(`terminal.write after close: ${afterClose instanceof RpcError ? afterClose.tag : afterClose}`);
      expect(afterClose).toBeInstanceOf(RpcError);
    } finally {
      rpc.close();
    }
  }, 120_000);
});

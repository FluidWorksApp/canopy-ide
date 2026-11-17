// Two real machines for the channel's tests, each a folder on this disk.
//
// The "workspace" one answers with the remote host's own code (its check
// runner and its upload protocol, from packages/remote-host), so the channel
// is tested against the contract a real workspace enforces: an upload that
// refuses to replace a file, a digest that must match, a path that must stay
// inside the workspace. The "desktop" one implements the contract of
// src-tauri/src/machine_channel.rs, which has its own tests in Rust.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, openSync, readSync, closeSync, statSync, realpathSync, renameSync, rmSync, appendFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ChannelMachine } from "./channel";

type Args = Record<string, unknown>;

function runCheck(args: Args): Promise<unknown> {
  const argv = args.argv as string[];
  const keep = Math.min(1024 * 1024, Math.max(1024, Number(args.keepBytes) || 64 * 1024));
  const head = args.head === true;
  const env: NodeJS.ProcessEnv = { ...process.env, CI: "1", NO_COLOR: "1", GIT_TERMINAL_PROMPT: "0" };
  for (const pair of (args.env as [string, string][] | undefined) ?? []) env[pair[0]] = pair[1];
  const started = Date.now();
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), { cwd: String(args.cwd), env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({ code: null, stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false, timedOut: false, durationMs: 0, spawnError: String(error) });
      return;
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, Number(args.timeoutMs) || 300_000);
    const cut = (chunks: Buffer[]) => {
      const all = Buffer.concat(chunks);
      const kept = all.length <= keep ? all : head ? all.subarray(0, keep) : all.subarray(all.length - keep);
      return { text: kept.toString("utf8"), truncated: all.length > keep };
    };
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false, timedOut: false, durationMs: 0, spawnError: `could not start \`${argv[0]}\`: ${error.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const o = cut(out);
      const e = cut(err);
      resolve({ code: timedOut ? null : code, stdout: o.text, stderr: e.text, stdoutTruncated: o.truncated, stderrTruncated: e.truncated, timedOut, durationMs: Date.now() - started, spawnError: null });
    });
  });
}

/** `root/rel`, refused when it is not inside `root` once links are resolved. */
function contained(root: string, rel: string, create = false): string {
  if (typeof rel !== "string" || !rel || rel.startsWith("/") || rel.split("/").includes("..")) throw new Error("path leaves its root");
  const base = realpathSync(root);
  const target = path.join(base, rel);
  const parent = path.dirname(target);
  if (create) mkdirSync(parent, { recursive: true });
  const real = realpathSync(parent);
  if (real !== base && !real.startsWith(base + path.sep)) throw new Error("path leaves its root");
  return path.join(real, path.basename(target));
}

function readRange(file: string, offset: number, length: number): { b64: string; size: number } {
  const size = statSync(file).size;
  const bytes = Buffer.alloc(Math.max(0, Math.min(length, size - offset)));
  const fd = openSync(file, "r");
  try {
    const read = bytes.length ? readSync(fd, bytes, 0, bytes.length, offset) : 0;
    return { b64: bytes.subarray(0, read).toString("base64"), size };
  } finally {
    closeSync(fd);
  }
}

export interface TestMachine extends ChannelMachine {
  /** Every command it was asked, in order. */
  calls: string[];
  /** The folder standing in for the machine's disk. */
  home: string;
  /** The folders of its saved projects' components. */
  projects: string[];
}

const originOf = (dir: string): string => {
  try {
    return execFileSync("git", ["-C", dir, "remote", "get-url", "origin"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
};

/** This Mac: the desktop host's commands. */
export function desktopMachine(name = "This Mac"): TestMachine {
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), "canopy-desktop-")));
  const calls: string[] = [];
  const projects: string[] = [];
  const invoke = async (command: string, args: Args = {}): Promise<unknown> => {
    calls.push(command);
    if (command === "receipt_run_check") return runCheck(args);
    if (command === "git_project_checkouts") {
      return projects.map((dir) => ({ dir, root: dir, rel: "", origin: originOf(dir), main: true })).filter((row) => row.origin);
    }
    if (command === "machine_file_read") {
      return readRange(contained(String(args.root), String(args.path)), Number(args.offset ?? 0), Math.min(Number(args.length ?? 0), 4 * 1024 * 1024));
    }
    if (command === "machine_file_write") {
      const target = contained(String(args.root), String(args.path), true);
      const part = `${target}.canopy-part`;
      if (args.abort === true) {
        rmSync(part, { force: true });
        return { written: 0 };
      }
      const offset = Number(args.offset);
      if (offset === 0) writeFileSync(part, "");
      const have = existsSync(part) ? statSync(part).size : -1;
      if (have !== offset) throw new Error(`write lost its place (have ${have} bytes, slice starts at ${offset})`);
      appendFileSync(part, Buffer.from(String(args.b64), "base64"));
      const written = statSync(part).size;
      if (args.done === true) {
        chmodSync(part, Number(args.mode ?? 0o644) & 0o777);
        renameSync(part, target);
      }
      return { written };
    }
    throw new Error(`the desktop does not serve ${command}`);
  };
  return { id: "local", name, desktop: true, home, calls, projects, invoke: invoke as ChannelMachine["invoke"] };
}

/** A Linux workspace: the remote host's own check runner and upload protocol. */
export async function workspaceMachine(name = "Build Box", id = "work-0a1b2c3d"): Promise<TestMachine> {
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), "canopy-workspace-")));
  const calls: string[] = [];
  const hostDir = path.resolve(__dirname, "../../packages/remote-host");
  const load = (file: string) => import(/* @vite-ignore */ path.join(hostDir, file));
  const { WorkspaceUploads } = await load("file-upload.mjs");
  const { receiptCheckStart, receiptCheckStatus } = await load("receipt-check.mjs");
  const uploads = new WorkspaceUploads(home);
  const scoped = async (value: string) => {
    const real = realpathSync(value);
    if (real !== home && !real.startsWith(home + path.sep)) throw new Error("Path outside selected workspace");
    return real;
  };
  const projects: string[] = [];
  const invoke = async (command: string, args: Args = {}): Promise<unknown> => {
    calls.push(command);
    if (command === "store_load") {
      return JSON.stringify({ projects: projects.map((dir, i) => ({ id: `p${i}`, name: `Project ${i}`, components: [{ id: `c${i}`, label: "root", path: dir }] })) });
    }
    if (command === "receipt_run_check") {
      // What NativeWorkspaceHost does with it: start a job, long-poll its answer.
      const { id: job } = receiptCheckStart(args, { scoped, home: process.env.HOME });
      for (;;) {
        const status = await receiptCheckStatus({ id: job, wait: 8000 });
        if (status.state === "done") return status.result;
        if (status.state === "failed") throw new Error(status.error);
      }
    }
    if (command === "fs_read_range") {
      return readRange(await scoped(String(args.path)), Number(args.offset ?? 0), Math.min(Number(args.length ?? 1048576), 1048576));
    }
    if (command.startsWith("fs_upload_")) return uploads.invoke(command, args);
    throw new Error(`Workspace host does not support ${command} yet`);
  };
  return { id, name, desktop: false, home, calls, projects, invoke: invoke as ChannelMachine["invoke"] };
}

export function dispose(...machines: TestMachine[]): void {
  for (const machine of machines) rmSync(machine.home, { recursive: true, force: true });
}

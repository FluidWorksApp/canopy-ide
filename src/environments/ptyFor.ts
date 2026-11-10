// A terminal on a machine other than the primary one (docs/multi-host-design.md,
// phase P2). `ptyIpcFor(env)` speaks the PTY commands through THAT environment's
// host instead of the window's global one, and names every terminal by a scoped
// id, so terminal 3 here and terminal 3 on the workstation cannot be confused.
//
// Additive and unused by default: nothing in the app calls this yet. The global
// `ipc.pty*` functions keep serving the primary host exactly as before.
import { decodePtyChunk, type PtyChunk, type PtyExit, type PtyGeometry, type PtySpawned, type SpawnResult } from "../ipc";
import type { Environment } from "./registry";
import { parseScopedKey, scopedKey, type EnvId, type Scoped } from "./scoped";

/** A terminal id that carries its machine. Branded, so a bare `number` (which is
 *  only unique on one host) no longer type-checks where one is required. */
export type ScopedPtyId = Scoped<number> & { readonly __brand: "ScopedPtyId" };

export const scopedPtyId = (env: EnvId, id: number): ScopedPtyId => ({ env, id }) as ScopedPtyId;

/** A single string for maps and storage, e.g. "remote:ws|3". */
export const ptyKey = (id: ScopedPtyId): string => scopedKey(id);

/** The id a key came from; null when it is not one or its id is not a number. */
export function parsePtyKey(key: string): ScopedPtyId | null {
  const parsed = parseScopedKey(key);
  if (!parsed) return null;
  const n = Number(parsed.id);
  return Number.isInteger(n) && n >= 0 ? scopedPtyId(parsed.env, n) : null;
}

export interface ScopedSpawn extends Omit<SpawnResult, "id"> {
  id: ScopedPtyId;
}

export interface ScopedPtyExit extends Omit<PtyExit, "id"> {
  id: ScopedPtyId;
}

export interface PtySpawnOptions {
  cols: number;
  rows: number;
  cwd?: string;
  shell?: string;
  highWater?: number;
  runCommand?: string;
  env?: [string, string][];
  projectId?: string;
  componentId?: string;
  workspacePath?: string;
}

export interface PtyArgvOptions {
  cwd?: string;
  argv: string[];
  env?: [string, string][];
  runId?: string;
  attemptId?: string;
  projectId?: string;
  componentId?: string;
  workspacePath?: string;
}

export interface ScopedPtySpawned extends Omit<PtySpawned, "id"> {
  id: ScopedPtyId;
}

/** What attaching to a surviving terminal returns, as `ptyAttachDesktop` does. */
export interface PtyAttached extends PtyGeometry {
  generation: number;
  replay_start: number;
  replay_end: number;
}

export interface EnvPtyIpc {
  readonly env: EnvId;
  spawn(opts: PtySpawnOptions, onData: (chunk: PtyChunk) => void): Promise<ScopedSpawn>;
  write(id: ScopedPtyId, data: string): Promise<void>;
  resize(id: ScopedPtyId, cols: number, rows: number): Promise<PtyGeometry>;
  kill(id: ScopedPtyId): Promise<void>;
  /** Exits of terminals on THIS environment only, with scoped ids. */
  onExit(cb: (e: ScopedPtyExit) => void): Promise<() => void>;
  /** A terminal started from an argv array, with no shell in the path. */
  spawnArgv(opts: PtyArgvOptions, onData: (chunk: PtyChunk) => void): Promise<ScopedSpawn>;
  /** Flow-control acknowledgement for `bytes` of `generation`'s stream. */
  ack(id: ScopedPtyId, generation: number, bytes: number): Promise<void>;
  /** Attach to a terminal that already exists on this environment. */
  attach(id: ScopedPtyId, after: number | null): Promise<PtyAttached>;
  setTitle(id: ScopedPtyId, title: string): Promise<void>;
  /** Terminals started on THIS environment, with scoped ids. */
  onSpawned(cb: (e: ScopedPtySpawned) => void): Promise<() => void>;
  /** The terminals this environment is running now, scoped. */
  sessions(): Promise<ScopedPtyId[]>;
  /** Use the window's renderer generation for this host (see PtyIpcOptions). */
  adoptRendererGeneration(generation: number): void;
}

/** Renderer registration, verified (docs/multi-host-design.md, P2 follow-up):
 *  `pty_renderer_register` bumps the desktop PtyManager's generation and detaches
 *  every desktop stream of the page before it, and the workspace adapter's
 *  `pty_renderer_register` itself calls the desktop's. So a second host must NOT
 *  register: it would invalidate the first host's streams. The window registers
 *  once (the primary does it) and every other host reuses that generation, which
 *  is what `adoptRendererGeneration` stores.
 */
export interface PtyIpcOptions {
  /** The window's renderer registration generation, shared by every host. The
   *  default (0) is refused by a host that requires a registered renderer. */
  rendererGeneration?: () => number;
}

/** Calling a PTY of another environment through this one's host would write to
 *  the wrong machine; refuse loudly rather than guess (design §6, risk 1). */
function own(env: EnvId, id: ScopedPtyId): number {
  if (id.env !== env) {
    throw new Error(`terminal ${id.id} belongs to ${id.env}, not ${env}`);
  }
  return id.id;
}

/** Mirrors the global ipc: a write, ack or kill racing the session's own exit
 *  rejects with "no pty session"; those callers want fire-and-forget. */
const gone = (p: Promise<unknown>): Promise<void> => p.then(() => undefined, () => undefined);

export function ptyIpcFor(environment: Pick<Environment, "id" | "host" | "readOnly">, options: PtyIpcOptions = {}): EnvPtyIpc {
  const { host } = environment;
  const env = environment.id;
  let adopted: number | null = null;
  const fromOptions = options.rendererGeneration ?? (() => 0);
  const generation = () => adopted ?? fromOptions();
  const refuseIfReadOnly = () => {
    if (environment.readOnly || host.readOnly) throw new Error(`${env} is view-only`);
  };
  return {
    env,
    async spawn(opts, onData) {
      refuseIfReadOnly();
      const channel = host.channel<ArrayBuffer | number[]>();
      channel.onmessage = (data) => onData(decodePtyChunk(data));
      const result = await host.invoke<SpawnResult>("pty_spawn", {
        ...opts,
        rendererGeneration: generation(),
        onData: channel,
      });
      return { ...result, id: scopedPtyId(env, result.id) };
    },
    async write(id, data) {
      refuseIfReadOnly();
      await gone(host.invoke<void>("pty_write", { id: own(env, id), data }));
    },
    resize(id, cols, rows) {
      return host.invoke<PtyGeometry>("pty_resize", { id: own(env, id), cols, rows });
    },
    async kill(id) {
      refuseIfReadOnly();
      await gone(host.invoke<void>("pty_kill", { id: own(env, id) }));
    },
    async spawnArgv(opts, onData) {
      refuseIfReadOnly();
      const channel = host.channel<ArrayBuffer | number[]>();
      channel.onmessage = (data) => onData(decodePtyChunk(data));
      const result = await host.invoke<SpawnResult>("pty_spawn_argv", {
        ...opts,
        rendererGeneration: generation(),
        onData: channel,
      });
      return { ...result, id: scopedPtyId(env, result.id) };
    },
    async ack(id, streamGeneration, bytes) {
      await gone(
        host.invoke<void>("pty_ack", {
          id: own(env, id),
          rendererGeneration: generation(),
          generation: streamGeneration,
          bytes,
        }),
      );
    },
    attach(id, after) {
      return host.invoke<PtyAttached>("pty_attach_desktop", {
        id: own(env, id),
        rendererGeneration: generation(),
        after,
      });
    },
    async setTitle(id, title) {
      await gone(host.invoke<void>("pty_set_title", { id: own(env, id), title }));
    },
    onSpawned(cb) {
      return host.listen<PtySpawned>("pty:spawned", (event) => {
        cb({ ...event.payload, id: scopedPtyId(env, event.payload.id) });
      });
    },
    async sessions() {
      const list = await host.invoke<{ id: number }[]>("pty_renderer_sessions", {
        rendererGeneration: generation(),
      });
      return list.map((s) => scopedPtyId(env, s.id));
    },
    adoptRendererGeneration(value) {
      adopted = value;
    },
    onExit(cb) {
      return host.listen<PtyExit>("pty:exit", (event) => {
        const exit = event.payload;
        cb({ ...exit, id: scopedPtyId(env, exit.id) });
      });
    },
  };
}

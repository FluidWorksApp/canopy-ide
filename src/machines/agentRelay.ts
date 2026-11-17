// The window's end of a machine's relay.
//
// An agent on this computer reaches the window through the desktop app. An
// agent on another machine cannot: the window is not there. Its host queues
// what the agent asked of the machine channel (packages/remote-host/
// machine-relay.mjs) and this collects it over the connection the window
// already has to that machine, carries it out, and posts the answer back.
//
// The host treats a window that stops asking as gone and tells its agents so,
// which is why the loop keeps asking while an op (a twenty-minute build) is
// still being carried out: ops are answered beside the loop, never inside it.

export interface RelayOp {
  id: string;
  machineOp: string;
  machineArgs: Record<string, unknown>;
  /** The agent's working directory on its machine. */
  cwd: string;
  ptyId: number | null;
}

/** A machine whose agents this window answers for. */
export interface RelaySource {
  /** The machine's id (its workspace id), which is where its ops come from. */
  id: string;
  name: string;
  invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
}

export interface RelayOptions {
  /** Carry out one op. What it resolves to is the agent's answer; what it
   *  throws is the agent's refusal. */
  handle: (op: RelayOp, source: RelaySource) => Promise<unknown>;
  /** How long one request waits on the host for an op. Under the 15 s every
   *  ordinary host command is given. */
  waitMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const WAIT_MS = 8_000;
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 20_000];

const message = (error: unknown): string => String((error as { message?: unknown })?.message ?? error).replace(/^Error:\s*/, "");

/** A host from before the relay: it will not grow one while this window is
 *  open, so there is nothing to keep asking for. The window's own workspace
 *  words it as an older host (remoteSupport.ts); a connected machine passes
 *  the host's own sentence through. */
const unsupported = (error: unknown): boolean => /does not support machine_relay_|running an older Canopy host/.test(String(error));

function parseOps(value: unknown): RelayOp[] {
  const list = (value as { ops?: unknown })?.ops;
  if (!Array.isArray(list)) return [];
  const out: RelayOp[] = [];
  for (const raw of list as Array<Record<string, unknown>>) {
    if (!raw || typeof raw.id !== "string" || typeof raw.machineOp !== "string" || typeof raw.cwd !== "string") continue;
    const args = raw.machineArgs;
    out.push({
      id: raw.id,
      machineOp: raw.machineOp,
      machineArgs: args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {},
      cwd: raw.cwd,
      ptyId: typeof raw.ptyId === "number" ? raw.ptyId : null,
    });
  }
  return out;
}

/** Answer for one machine until stopped. Returns the stop. */
export function relayFrom(source: RelaySource, options: RelayOptions): () => void {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const wait = options.waitMs ?? WAIT_MS;
  let stopped = false;

  const answer = async (op: RelayOp) => {
    let ok = true;
    let data: unknown;
    try {
      data = await options.handle(op, source);
    } catch (error) {
      ok = false;
      data = message(error);
    }
    // An answer that never arrives leaves the agent waiting out its deadline
    // with the work already done, so a dropped connection is retried.
    for (let attempt = 0; attempt < BACKOFF_MS.length; attempt++) {
      try {
        await source.invoke("machine_relay_result", { id: op.id, ok, data: data ?? null });
        return;
      } catch (error) {
        if (unsupported(error)) return;
        await sleep(BACKOFF_MS[attempt]);
      }
    }
  };

  void (async () => {
    let failures = 0;
    while (!stopped) {
      try {
        const ops = parseOps(await source.invoke("machine_relay_poll", { wait }));
        failures = 0;
        if (stopped) {
          // Taken but not carried out: say so, so the agent is not left
          // waiting on a window that has let go of its machine.
          for (const op of ops) {
            void source.invoke("machine_relay_result", { id: op.id, ok: false, data: "The Canopy window let go of this machine before it could do that. Try again." }).catch(() => {});
          }
          return;
        }
        for (const op of ops) void answer(op);
      } catch (error) {
        if (unsupported(error)) return;
        await sleep(BACKOFF_MS[Math.min(failures++, BACKOFF_MS.length - 1)]);
      }
    }
  })();

  return () => {
    stopped = true;
  };
}

/** The relays of every machine the window is on, kept in step with them. */
export class AgentRelays {
  private readonly options: RelayOptions;
  private readonly running = new Map<string, { source: RelaySource; stop: () => void }>();

  constructor(options: RelayOptions) {
    this.options = options;
  }

  /** The machines to answer for now: new ones start, missing ones stop. A
   *  machine reconnected under the same id gets a loop on its new connection. */
  set(sources: RelaySource[]): void {
    const wanted = new Map(sources.map((source) => [source.id, source]));
    for (const [id, entry] of this.running) {
      const next = wanted.get(id);
      if (next && next.invoke === entry.source.invoke) continue;
      entry.stop();
      this.running.delete(id);
    }
    for (const [id, source] of wanted) {
      if (this.running.has(id)) continue;
      this.running.set(id, { source, stop: relayFrom(source, this.options) });
    }
  }

  ids(): string[] {
    return [...this.running.keys()];
  }

  stop(): void {
    for (const entry of this.running.values()) entry.stop();
    this.running.clear();
  }
}

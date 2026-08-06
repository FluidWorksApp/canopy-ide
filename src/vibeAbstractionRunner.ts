import { renderPtyText } from "./ptyText";
import { redactSecrets } from "./vibeSecretScan";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const RAW_OUTPUT_CAP = 128 * 1024;
const RENDERED_OUTPUT_CAP = 24_000;

export interface AbstractionPtyExit {
  id: number;
  exit_code: number | null;
}

export interface AbstractionRunnerDeps {
  /** This boundary is argv-native on purpose. Implementations must not invoke a shell. */
  ptySpawnDetached(opts: { cwd: string; argv: string[] }): Promise<{ id: number }>;
  onPtyExit(listener: (event: AbstractionPtyExit) => void): Promise<() => void>;
  ptyOutput(id: number, max?: number): Promise<string | null>;
  ptyKill(id: number): Promise<void>;
  timeoutMs?: number;
}

export interface AbstractionRunResult {
  ok: boolean;
  exitCode: number | null;
  output: string;
  timedOut: boolean;
}

/** Execute a managed-abstraction plan without ever converting its argv to shell text. */
export async function runAbstractionPlan(
  argv: string[],
  cwd: string,
  deps: AbstractionRunnerDeps,
): Promise<AbstractionRunResult> {
  let target: number | null = null;
  const early: AbstractionPtyExit[] = [];
  let finish!: (event: AbstractionPtyExit | null) => void;
  const exited = new Promise<AbstractionPtyExit | null>((resolve) => {
    finish = resolve;
  });

  const unlisten = await deps.onPtyExit((event) => {
    if (target == null) early.push(event);
    else if (event.id === target) finish(event);
  });

  try {
    const spawned = await deps.ptySpawnDetached({ cwd, argv });
    target = spawned.id;
    const already = early.find((event) => event.id === target);
    if (already) finish(already);

    const timeout = globalThis.setTimeout(
      () => finish(null),
      deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    const result = await exited;
    globalThis.clearTimeout(timeout);

    if (!result) await deps.ptyKill(target);
    const raw = (await deps.ptyOutput(target, RAW_OUTPUT_CAP)) ?? "";
    const rendered = await renderPtyText(raw, { maxChars: RENDERED_OUTPUT_CAP });
    const output = redactSecrets(rendered);

    return {
      ok: result?.exit_code === 0,
      exitCode: result?.exit_code ?? null,
      output,
      timedOut: result == null,
    };
  } finally {
    unlisten();
  }
}

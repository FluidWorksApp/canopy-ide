// Moves a running agent to another account inside its own terminal. Only the
// agent stops: the shell, tab and scrollback stay, so a failure at any step can
// put the conversation back on its original account in the same place.

export interface HandoverSide { line: string; profile: string }

export interface HandoverEffects {
  stop(): Promise<void>;
  /** Makes the conversation available to the target account. */
  transfer(): Promise<void>;
  write(line: string): Promise<void>;
  running(): Promise<boolean>;
  sleep(ms: number): Promise<void>;
  log(step: string, detail?: string): void;
}

export type HandoverResult =
  | { outcome: "moved" }
  | { outcome: "started-fresh" }
  | { outcome: "restored"; reason: string }
  | { outcome: "failed"; reason: string };

/** How long a CLI gets to take the terminal, then to keep it. A refused resume
 *  prints its error and returns to the shell well inside the second. */
export const START_MS = 5_000;
export const STAY_MS = 6_000;
const POLL_MS = 250;

/** Whether the launched CLI took the terminal and held on to it. */
export async function launched(effects: Pick<HandoverEffects, "running" | "sleep">): Promise<boolean> {
  let waited = 0;
  while (!(await effects.running())) {
    if (waited >= START_MS) return false;
    await effects.sleep(POLL_MS);
    waited += POLL_MS;
  }
  for (let held = 0; held < STAY_MS; held += POLL_MS) {
    await effects.sleep(POLL_MS);
    if (!(await effects.running())) return false;
  }
  return true;
}

const text = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Claude writes nothing until the first prompt, so there may be nothing to move. */
const nothingSaved = (reason: string) => reason.includes("Saved conversation not found");

export async function handOver(request: {
  target: HandoverSide;
  /** The same conversation on its current account: the way back. */
  original: HandoverSide;
  /** A new session on the target, for a tab with no conversation to carry. */
  fresh: HandoverSide;
}, effects: HandoverEffects): Promise<HandoverResult> {
  const { target, original, fresh } = request;
  const back = async (reason: string): Promise<HandoverResult> => {
    effects.log("restoring", reason);
    await effects.write(original.line);
    if (await launched(effects)) return { outcome: "restored", reason };
    effects.log("restore-failed", reason);
    return { outcome: "failed", reason };
  };
  try {
    effects.log("stopping");
    await effects.stop();
  } catch (error) {
    // Still running, or its state is unknown: the transcript must not be touched.
    effects.log("stop-failed", text(error));
    return { outcome: "failed", reason: text(error) };
  }
  try {
    effects.log("transferring");
    await effects.transfer();
  } catch (error) {
    const reason = text(error);
    if (!nothingSaved(reason)) return await back(reason).catch(e => ({ outcome: "failed", reason: text(e) }));
    effects.log("nothing-to-transfer");
    try {
      await effects.write(fresh.line);
      if (await launched(effects)) return { outcome: "started-fresh" };
      return { outcome: "failed", reason: `The CLI did not start on ${fresh.profile}` };
    } catch (failure) {
      return { outcome: "failed", reason: text(failure) };
    }
  }
  try {
    effects.log("launching", target.profile);
    await effects.write(target.line);
    if (await launched(effects)) {
      effects.log("moved", target.profile);
      return { outcome: "moved" };
    }
    return await back(`The conversation did not open on ${target.profile}`);
  } catch (error) {
    return { outcome: "failed", reason: text(error) };
  }
}

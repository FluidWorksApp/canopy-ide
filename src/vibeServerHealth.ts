export const VIBE_SERVER_CRASH_WINDOW_MS = 60_000;
export const VIBE_SERVER_CRASH_THRESHOLD = 3;
export const VIBE_SERVER_LOG_TAIL_CHARS = 8_000;

export interface VibeServerHealthState {
  targetKey: string | null;
  failures: number[];
  halted: boolean;
}

export interface VibeServerExitSample {
  at: number;
  exitCode: number | null;
  requested: boolean;
}

export type VibeServerHealthAction = "ignore" | "repair" | "crash-loop";

export const INITIAL_VIBE_SERVER_HEALTH: VibeServerHealthState = {
  targetKey: null,
  failures: [],
  halted: false,
};

export function resetVibeServerHealth(
  targetKey: string | null = null,
): VibeServerHealthState {
  return { targetKey, failures: [], halted: false };
}

export function judgeVibeServerExit(
  current: VibeServerHealthState,
  targetKey: string,
  sample: VibeServerExitSample,
): { state: VibeServerHealthState; action: VibeServerHealthAction } {
  const state =
    current.targetKey === targetKey ? current : resetVibeServerHealth(targetKey);
  if (sample.requested || sample.exitCode === 0) {
    return { state: resetVibeServerHealth(targetKey), action: "ignore" };
  }
  if (state.halted) return { state, action: "ignore" };

  const failures = [
    ...state.failures.filter(
      (failure) => sample.at - failure < VIBE_SERVER_CRASH_WINDOW_MS,
    ),
    sample.at,
  ];
  if (failures.length >= VIBE_SERVER_CRASH_THRESHOLD) {
    return {
      state: { targetKey, failures, halted: true },
      action: "crash-loop",
    };
  }
  return {
    state: { targetKey, failures, halted: false },
    action: "repair",
  };
}

export function vibeServerLogTail(
  text: string,
  maxChars = VIBE_SERVER_LOG_TAIL_CHARS,
): string {
  return text.slice(-maxChars);
}

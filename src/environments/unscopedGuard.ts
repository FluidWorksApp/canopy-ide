// Dev-mode guard for design §6, risk 1 (docs/multi-host-design.md): a call that
// is not bound to a machine reaches the PRIMARY one, so with a tab on another
// machine it would read or write the wrong host. Not wired by default: nothing
// calls `assertScopedCall` today, and production never throws from it.
import type { EnvId } from "./scoped";

export interface GuardOptions {
  /** The window's primary environment. */
  primary: EnvId;
  /** Throw (dev, tests) or only warn. Off by default so a missed call site is a
   *  visible log line, never a broken app. */
  strict?: boolean;
  warn?: (message: string) => void;
}

/** Say that `command` ran unscoped while the active tab belongs to another
 *  environment. Returns whether it was a mismatch. */
export function assertScopedCall(command: string, tabEnv: EnvId | undefined, options: GuardOptions): boolean {
  const env = tabEnv ?? options.primary;
  if (env === options.primary) return false;
  const message = `${command} ran on ${options.primary} while the active tab belongs to ${env}`;
  if (options.strict) throw new Error(message);
  (options.warn ?? ((m) => console.warn(m)))(message);
  return true;
}

/** Wrap an ipc-like function so each call is checked against the active tab's
 *  environment. Returns the function unchanged unless `enabled`, so wiring it
 *  in costs nothing in release builds. */
export function guardUnscoped<A extends unknown[], R>(
  command: string,
  fn: (...args: A) => R,
  activeEnv: () => EnvId | undefined,
  options: GuardOptions & { enabled: boolean },
): (...args: A) => R {
  if (!options.enabled) return fn;
  return (...args) => {
    assertScopedCall(command, activeEnv(), options);
    return fn(...args);
  };
}

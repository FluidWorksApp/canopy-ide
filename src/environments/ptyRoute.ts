// Terminals on another machine, addressed through the numeric ids the rest of the
// app already passes around (docs/multi-host-design.md, P3).
//
// A PTY id is only unique on one host: terminal 3 here and terminal 3 on a
// workstation are different processes. The app keeps ~880 references to
// `ptyId: number`, so instead of changing each one, a terminal that lives on a
// non-primary machine is given an ALIAS: a number above anything a host will
// hand out, unique per (machine, id). `ipc.pty*` looks the alias up and talks to
// that machine's host with the real id; every other id takes the unchanged
// primary path. Nothing here connects to anything.
import type { Host } from "../host/contract";
import { scopedKey, type EnvId } from "./scoped";

const ptyKey = (env: EnvId, id: number) => scopedKey({ env, id });

/** Real PTY ids are small counters; aliases start well above them and stay a
 *  safe JavaScript integer. */
export const PTY_ALIAS_BASE = 2 ** 40;

export interface PtyRoute {
  env: EnvId;
  /** The id the machine knows the terminal by. */
  id: number;
  host: Host;
  readOnly: boolean;
}

const byAlias = new Map<number, PtyRoute>();
const aliasByKey = new Map<string, number>();
let next = PTY_ALIAS_BASE;

export const isAliasPty = (id: number): boolean => id >= PTY_ALIAS_BASE;

/** The alias for a terminal on `env`, stable for the life of the page. */
export function aliasPty(env: EnvId, id: number, host: Host, readOnly: boolean): number {
  const key = ptyKey(env, id);
  const known = aliasByKey.get(key);
  if (known !== undefined) {
    byAlias.set(known, { env, id, host, readOnly });
    return known;
  }
  const alias = next++;
  aliasByKey.set(key, alias);
  byAlias.set(alias, { env, id, host, readOnly });
  return alias;
}

/** Where an id really lives; null for every id of the primary machine. */
export function routeOf(id: number): PtyRoute | null {
  return id >= PTY_ALIAS_BASE ? (byAlias.get(id) ?? null) : null;
}

/** The alias of a terminal already seen on `env`, if any. */
export const aliasOf = (env: EnvId, id: number): number | undefined => aliasByKey.get(ptyKey(env, id));

/** The machines that currently have terminals started from this window, one
 *  host each. Nothing is connected to read this. */
export function routedHosts(): { env: EnvId; host: Host }[] {
  const seen = new Map<EnvId, Host>();
  for (const route of byAlias.values()) if (!seen.has(route.env)) seen.set(route.env, route.host);
  return [...seen].map(([env, host]) => ({ env, host }));
}

/** Forget every terminal of a machine, when it is disconnected. */
export function forgetEnvironment(env: EnvId): void {
  for (const [alias, route] of byAlias) {
    if (route.env !== env) continue;
    byAlias.delete(alias);
    aliasByKey.delete(ptyKey(env, route.id));
  }
}

/** For tests. */
export function resetPtyRoutes(): void {
  byAlias.clear();
  aliasByKey.clear();
  next = PTY_ALIAS_BASE;
}

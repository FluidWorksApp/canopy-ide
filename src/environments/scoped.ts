// Ids that say which machine they belong to. A numeric terminal id or a project
// id is only unique on one host; with more than one live, "terminal 3" must name
// its environment too. Follows docs/multi-host-design.md §4.1.
//
// An id with no environment means the primary one (the host this window loaded
// with), so anything persisted before environments existed loads unchanged.

/** `targetKey(target)` from placement/types: "local", "remote:<id>", "t3:<id>". */
export type EnvId = string;

export interface Scoped<T extends string | number = string | number> {
  env: EnvId;
  id: T;
}

const JOIN = "|";

/** A single string for a scoped id, safe as a map key. The joiner is not `:`
 *  because an EnvId already contains one. */
export const scopedKey = (ref: Scoped): string => `${ref.env}${JOIN}${ref.id}`;

/** The scoped id a key came from. Null for anything that is not one. The id part
 *  comes back as text; callers that keep numbers convert them. */
export function parseScopedKey(key: string): Scoped<string> | null {
  // The first separator: an EnvId never contains one, but a local id might.
  const at = key.indexOf(JOIN);
  if (at <= 0 || at === key.length - 1) return null;
  return { env: key.slice(0, at), id: key.slice(at + 1) };
}

/** The environment a record belongs to: its own, else the primary. */
export const envOf = (record: { env?: EnvId }, primary: EnvId): EnvId => record.env ?? primary;

/** Scope an id, defaulting to the primary environment. */
export const scoped = <T extends string | number>(id: T, env: EnvId | undefined, primary: EnvId): Scoped<T> => ({
  env: env ?? primary,
  id,
});

/** Whether two ids are the same thing on the same machine. */
export const sameScoped = (a: Scoped, b: Scoped): boolean => a.env === b.env && a.id === b.id;

// Who the person at this computer is, as the team knows them: the signed-in
// Canopy account (`/api/me`). Its `id` is the same id team chat uses for a
// message's sender and `/api/teams` returns as `selfId`, so anything that
// asks "is this mine?" across machines — a layer owner, an approval, whose
// spend this is — compares ids, never a name somebody typed.
//
// Signed out (or offline before the first answer) is `null`; callers fall
// back to what they had before (the CLI profile for spend) or ask the person
// to sign in. Cached for the window and dropped on `canopy:account-changed`,
// the event every sign-in and sign-out raises.
import { invoke } from "@tauri-apps/api/core";

export interface TeamIdentity {
  id: string;
  name: string;
  email: string;
}

type Fetch = () => Promise<unknown>;

const defaultFetch: Fetch = () => invoke("canopy_account_request", { route: "/api/me", body: null });
let fetchMe: Fetch = defaultFetch;

let current: TeamIdentity | null = null;
let known = false;
let inflight: Promise<TeamIdentity | null> | null = null;
let epoch = 0;
const listeners = new Set<() => void>();

const emit = () => {
  for (const cb of listeners) {
    try {
      cb();
    } catch {
      // One listener's bug must not cost the others the change.
    }
  }
};

/** The shape `/api/me` answers with, read leniently: anything without an id
 *  is "not signed in", never a guess. */
export function parseIdentity(raw: unknown): TeamIdentity | null {
  const user = (raw as { user?: unknown } | null)?.user as Record<string, unknown> | undefined;
  if (!user || typeof user !== "object") return null;
  const id = typeof user.id === "string" ? user.id.trim() : "";
  if (!id || id.length > 256) return null;
  const email = typeof user.email === "string" ? user.email.trim() : "";
  const name = (typeof user.name === "string" && user.name.trim()) || email.split("@")[0] || "You";
  return { id, name: name.slice(0, 80), email };
}

/** The signed-in identity, fetched once per account. Never throws. */
export function teamIdentity(): Promise<TeamIdentity | null> {
  if (known) return Promise.resolve(current);
  if (inflight) return inflight;
  const at = epoch;
  inflight = fetchMe()
    .then(parseIdentity, () => null)
    .then((me) => {
      if (at === epoch) {
        current = me;
        known = true;
        emit();
      }
      return me;
    })
    .finally(() => {
      if (at === epoch) inflight = null;
    });
  return inflight;
}

/** What is known right now, without asking: for render paths. */
export function peekTeamIdentity(): TeamIdentity | null {
  return current;
}

export function subscribeTeamIdentity(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Whether `ownerId` (or, for older records with no id, `ownerName`) is the
 *  signed-in person. Names are a fallback only for records written before
 *  ownership carried an id. */
export function isMe(me: TeamIdentity | null, owner: { id?: string | null; name?: string | null }): boolean {
  if (!me) return false;
  if (owner.id) return owner.id === me.id;
  const name = owner.name?.trim().toLowerCase();
  return !!name && (name === me.name.trim().toLowerCase() || name === me.email.trim().toLowerCase());
}

function forget(): void {
  epoch++;
  current = null;
  known = false;
  inflight = null;
  emit();
}

if (typeof window !== "undefined") window.addEventListener("canopy:account-changed", forget);

/** Tests only: answer `/api/me` with `next` (null restores the real call). */
export function setTeamIdentityFetchForTests(next: Fetch | null): void {
  fetchMe = next ?? defaultFetch;
  forget();
}

/** The vault's end of the change channel.
 *
 *  Thinner than notes' or research's store on purpose: the vault has no cache
 *  to keep warm and nothing renders it but the settings surface. What it does
 *  have is a hazard that made a plain `registerStore -> refresh` wrong.
 *
 *  THE AUTO-LOCK COUPLING. `vault_status` calls `VaultState::key()`
 *  (src-tauri/src/vault.rs:361, :171-178), and `key()` sets
 *  `last_use = Some(Instant::now())` on its way out. So *asking whether the
 *  vault is unlocked is itself an act that postpones the auto-lock*. A handler
 *  that refreshed on every pulse would mean: anything that writes the vault
 *  keeps the vault unlocked. Today nothing writes it but the user's own panel,
 *  so the practical exposure is nil — but the whole point of this channel is
 *  that new writers arrive later and inherit the wiring, and this is the one
 *  store where inheriting it silently would weaken a security property.
 *
 *  So the pulse is only acted on when a surface is actually mounted AND it
 *  already believes the vault is unlocked. A locked vault learns nothing from
 *  a refresh (it would be told "still locked") and would pay for it with a
 *  postponed lock, so it does not ask. */

import { registerStore } from "./stores";

type Listener = () => void;

const listeners = new Set<Listener>();
let believedUnlocked = false;

/** Tell the store what the surface currently believes, so the handler can
 *  decide whether asking is worth postponing the auto-lock for. */
export function noteUnlocked(unlocked: boolean): void {
  believedUnlocked = unlocked;
}

/** Subscribe a mounted surface to vault changes. Returns its unsubscribe. */
export function subscribeVault(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0) believedUnlocked = false;
  };
}

const onVaultChanged = () => {
  // Nothing is showing the vault, or it is locked: either way, asking would
  // cost an auto-lock postponement and buy nothing.
  if (listeners.size === 0 || !believedUnlocked) return;
  for (const fn of listeners) fn();
};

registerStore("vault", onVaultChanged);

/** Test seam. `stores.ts`'s reset clears the routing table this module filled
 *  at import, and a test cannot re-import a module to get that back. */
export function resetVaultStoreForTest(): void {
  listeners.clear();
  believedUnlocked = false;
  registerStore("vault", onVaultChanged);
}

// When a run in the RUNS rail is finished with, and should take itself away.
//
// Run tabs outlive their process on purpose: a dev server that died, a build
// that failed, a test run you want to scroll back through — all of those are
// output you asked for, and a rail that swept them up the moment the process
// exited would be throwing away the answer. So the rail keeps everything.
//
// That is the wrong bargain for a chore. Updating a CLI, installing one, or
// installing a prerequisite is a job with exactly one interesting outcome —
// did it work — and the ✓ on the chip is that outcome in full. Nothing in the
// scrollback of a successful `npm i -g` is worth a click, yet the chip sat
// there until someone closed it by hand, so the rail slowly filled with
// finished errands and the one live server got harder to pick out.
//
// A chore that *failed* is the opposite: the scrollback is the whole point, and
// it stays until the user is done with it.

/** The fields the policy reads. Kept structural so the tests don't need a whole
 *  tab, and so this module stays independent of the tab union. */
export interface ReapableRun {
  /** Lives in the RUNS rail. */
  run?: boolean;
  /** An errand rather than a server: launched by the app to install or update
   *  something, with no output worth keeping once it succeeds. */
  chore?: boolean;
  exited?: boolean;
  exitCode?: number | null;
}

/** How long a finished chore stays on screen before it goes.
 *
 *  Not zero: the chip flicking from spinner to gone reads as a run that
 *  vanished rather than one that finished, and the ✓ is the only receipt this
 *  job ever produces. Long enough to register out of the corner of an eye,
 *  short enough that nobody is waiting on it. */
export const CHORE_REAP_MS = 4000;

/** Does this run close itself now that it has exited with `code`?
 *
 *  A null code — killed by a signal, or an ending the pty couldn't report — is
 *  not a success: it is the ending most worth leaving on screen. */
export function reapsOnExit(tab: ReapableRun, code: number | null): boolean {
  return Boolean(tab.run && tab.chore) && code === 0;
}

/** Re-asked when the timer fires, against the tab as it stands then.
 *
 *  The gap matters: "Run again" inside those few seconds puts a live process on
 *  the same tab, and reaping on the strength of the earlier exit would close a
 *  run that is underway. The tab has to still be sitting on the success that
 *  scheduled this. */
export function stillReapable(tab: ReapableRun | undefined): boolean {
  return Boolean(tab?.run && tab.chore && tab.exited) && tab?.exitCode === 0;
}

/** Arm the self-close for a run that has just exited, if it is one that closes
 *  itself. Handed the map of pending timers so a re-run inside the window
 *  replaces its predecessor rather than stacking a second one, and so the view
 *  can drop them all when it goes away. */
export function scheduleReap(
  tabId: string,
  code: number | null,
  tab: ReapableRun,
  timers: Map<string, number>,
  lookup: (id: string) => ReapableRun | undefined,
  close: (id: string) => void,
): void {
  if (!reapsOnExit(tab, code)) return;
  const pending = timers.get(tabId);
  if (pending != null) clearTimeout(pending);
  timers.set(
    tabId,
    setTimeout(() => {
      timers.delete(tabId);
      if (stillReapable(lookup(tabId))) close(tabId);
    }, CHORE_REAP_MS) as unknown as number,
  );
}

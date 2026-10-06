import { useCallback, useEffect, useRef, useState } from "react";
import {
  AGENT_CLIS_CHANGED_EVENT,
  CLI_INSTALLS_CHANGED_EVENT,
  checkCliUpdates,
  checkInstalledPrereqs,
  probeInstalledClis,
} from "../../../projects";
import type { CliUpdate } from "../../../projects";

/** Waits before re-asking after a probe that could not answer. The last delay
 *  repeats, so a machine whose shell keeps failing is asked twice a minute
 *  rather than never again. */
const PROBE_RETRY_MS = [2_000, 5_000, 15_000, 30_000];

export function useCliLauncher() {
  const [installed, setInstalled] = useState<Record<string, boolean>>({});
  // Foundations (Git, Node/npm) the CLI installers depend on. Probed alongside
  // the CLIs, so an install run tab's exit re-checks these too.
  const [prereqs, setPrereqs] = useState<Record<string, boolean>>({});
  const installedRef = useRef(installed);
  installedRef.current = installed;
  const getInstalled = useCallback(() => installedRef.current, []);
  const [cliUpdates, setCliUpdates] = useState<Record<string, CliUpdate>>({});

  // Re-probed whenever it could have changed: an install run finishing, or
  // the launcher opening. A one-shot probe at mount meant a finished install
  // still showed — and re-ran — the installer on every click.
  //
  // A probe that could not answer (null) keeps the last known state and tries
  // again shortly. Writing its silence into state is what put "install" badges
  // and a missing-Git banner on a machine that has all of them.
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryAttempt = useRef(0);
  const refreshRef = useRef<() => Promise<Record<string, boolean>>>(
    async () => installedRef.current,
  );
  const scheduleRetry = useCallback((failed: boolean) => {
    if (!failed) {
      retryAttempt.current = 0;
      return;
    }
    if (retryTimer.current) return;
    const delay = PROBE_RETRY_MS[Math.min(retryAttempt.current, PROBE_RETRY_MS.length - 1)];
    retryAttempt.current += 1;
    retryTimer.current = setTimeout(() => {
      retryTimer.current = null;
      void refreshRef.current();
    }, delay);
  }, []);
  useEffect(
    () => () => {
      if (retryTimer.current) clearTimeout(retryTimer.current);
      retryTimer.current = null;
    },
    [],
  );
  const refreshInstalled = useCallback(async () => {
    const [next, nextPrereqs] = await Promise.all([
      probeInstalledClis(),
      checkInstalledPrereqs(),
    ]);
    if (nextPrereqs) setPrereqs(nextPrereqs);
    if (next) setInstalled(next);
    scheduleRetry(!next || !nextPrereqs);
    return next ?? installedRef.current;
  }, [scheduleRetry]);
  refreshRef.current = refreshInstalled;
  const getInstalledForLaunch = useCallback(async () => {
    try {
      // Launch-time truth wins over the render cache: PATH and external
      // installers can change without emitting one of Canopy's events.
      return await refreshInstalled();
    } catch {
      return installedRef.current;
    }
  }, [refreshInstalled]);

  // Version probing runs `<bin> --version` per CLI plus (at most 6-hourly) a
  // registry fetch — slower than which_check, so it rides in the background
  // and the launcher renders whatever the last probe knew.
  const refreshUpdates = useCallback(
    () => void checkCliUpdates().then(setCliUpdates),
    [],
  );

  // Opening a project deliberately opens nothing: the empty state is the
  // launcher, so you pick the shell or agent you actually want rather than
  // being handed a shell you didn't ask for.
  useEffect(() => {
    refreshInstalled();
    refreshUpdates();
  }, [refreshInstalled, refreshUpdates]);

  // Two machine-wide changes, one response. Rebinding a CLI to the binary this
  // machine actually has (Settings → Agents) changes what there is to probe;
  // an install or update run finishing changes the answer. Without this, the
  // row that sent the user to Settings — or the card they just installed from
  // another project — goes on offering to install until the launcher is
  // reopened, which reads as the thing they did not having worked.
  useEffect(() => {
    const onChanged = () => {
      refreshInstalled();
      refreshUpdates();
    };
    window.addEventListener(AGENT_CLIS_CHANGED_EVENT, onChanged);
    window.addEventListener(CLI_INSTALLS_CHANGED_EVENT, onChanged);
    return () => {
      window.removeEventListener(AGENT_CLIS_CHANGED_EVENT, onChanged);
      window.removeEventListener(CLI_INSTALLS_CHANGED_EVENT, onChanged);
    };
  }, [refreshInstalled, refreshUpdates]);

  return {
    installed,
    prereqs,
    getInstalled,
    getInstalledForLaunch,
    cliUpdates,
    refreshInstalled,
    refreshUpdates,
  };
}

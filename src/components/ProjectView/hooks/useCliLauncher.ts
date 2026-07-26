import { useCallback, useEffect, useRef, useState } from "react";
import {
  AGENT_CLIS_CHANGED_EVENT,
  CLI_INSTALLS_CHANGED_EVENT,
  checkCliUpdates,
  checkInstalledClis,
  checkInstalledPrereqs,
} from "../../../projects";
import type { CliUpdate } from "../../../projects";

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
  const refreshInstalled = useCallback(() => {
    void checkInstalledClis().then(setInstalled);
    void checkInstalledPrereqs().then(setPrereqs);
  }, []);

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

  return { installed, prereqs, getInstalled, cliUpdates, refreshInstalled, refreshUpdates };
}

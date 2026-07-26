import { useCallback, useEffect, useRef, useState } from "react";
import {
  AGENT_CLIS_CHANGED_EVENT,
  checkCliUpdates,
  checkInstalledClis,
  checkInstalledPrereqs,
} from "../../../projects";
import type { CliUpdate } from "../../../projects";

export function useCliLauncher() {
  const [installed, setInstalled] = useState<Record<string, boolean>>({});
  const [prereqs, setPrereqs] = useState<Record<string, boolean>>({});
  const installedRef = useRef(installed);
  installedRef.current = installed;
  const [cliUpdates, setCliUpdates] = useState<Record<string, CliUpdate>>({});

  const refreshInstalled = useCallback(() => {
    void checkInstalledClis().then(setInstalled);
    void checkInstalledPrereqs().then(setPrereqs);
  }, []);

  const refreshUpdates = useCallback(
    () => void checkCliUpdates().then(setCliUpdates),
    [],
  );

  useEffect(() => {
    refreshInstalled();
    refreshUpdates();
  }, [refreshInstalled, refreshUpdates]);

  useEffect(() => {
    const onChanged = () => {
      refreshInstalled();
      refreshUpdates();
    };
    window.addEventListener(AGENT_CLIS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(AGENT_CLIS_CHANGED_EVENT, onChanged);
  }, [refreshInstalled, refreshUpdates]);

  return { installed, prereqs, installedRef, cliUpdates, refreshInstalled, refreshUpdates };
}

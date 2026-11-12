import { useCallback, useEffect, useState } from "react";
import { invokeDesktop } from "../host";

/** Saved as `terminal.keepRunningAfterQuit` by the backend, which reads it at
 *  startup (the webview's localStorage is out of its reach). `supported` is
 *  false where there is no terminal host (Windows). */
export interface HostSetting {
  supported: boolean;
  on: boolean;
  forced: boolean | null;
}

export interface KeepTerminalsDeps {
  load: () => Promise<HostSetting>;
  save: (on: boolean) => Promise<unknown>;
}

const defaultDeps: KeepTerminalsDeps = {
  load: () => invokeDesktop<HostSetting>("pty_host_setting"),
  save: (on) => invokeDesktop("pty_host_set_setting", { on }),
};

/** State for the Settings → Terminal row "Keep terminals running after quit".
 *  `visible` is false until the backend says the platform can host terminals,
 *  so the row is absent on Windows and on a host with no such command. A change
 *  is saved at once but applies after restart; a failed save puts the switch
 *  back and says why. */
export function useKeepTerminalsRunning(deps: KeepTerminalsDeps = defaultDeps) {
  const [state, setState] = useState<HostSetting | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    deps.load().then(
      (s) => live && setState(s),
      () => live && setState(null),
    );
    return () => {
      live = false;
    };
  }, [deps]);

  const set = useCallback(
    (on: boolean) => {
      setError(null);
      setState((s) => (s ? { ...s, on } : s));
      deps.save(on).catch((e) => {
        setState((s) => (s ? { ...s, on: !on } : s));
        setError(e instanceof Error ? e.message : String(e));
      });
    },
    [deps],
  );

  return { visible: state?.supported === true, on: state?.on ?? false, error, set };
}

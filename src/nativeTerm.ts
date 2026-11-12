// The native terminal window (beta): a separate window process Canopy launches
// from its bundled `canopy-term-app`. Only the desktop app on a build that
// ships it has one, so the entries that open it are drawn only when this says
// so, never disabled.
import { useEffect, useState } from "react";
import { invoke, isRemoteHost, isWorkspaceHost } from "./host";

/** Whether this window can open a native terminal. False on a remote or
 *  workspace host (its folders are not on this computer), in dev builds and on
 *  Windows (no binary), and until the answer arrives. */
export async function nativeTermAvailable(): Promise<boolean> {
  if (isRemoteHost() || isWorkspaceHost()) return false;
  try {
    return (await invoke<boolean>("native_term_available")) === true;
  } catch {
    return false;
  }
}

export function useNativeTermAvailable(): boolean {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    let live = true;
    void nativeTermAvailable().then((v) => live && setAvailable(v));
    return () => {
      live = false;
    };
  }, []);
  return available;
}

/** Opens a native terminal window in `cwd`. Rejects with the reason. */
export function openNativeTerminal(cwd: string): Promise<void> {
  return invoke<void>("native_term_open", { cwd });
}

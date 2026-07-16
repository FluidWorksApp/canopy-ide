// Self-update via the Tauri updater plugin.
//
// Sparkle-equivalent, but one mechanism for all three platforms: macOS gets a
// signed .app.tar.gz, Windows an NSIS installer, Linux an AppImage. Every
// artifact is minisign-verified against the pubkey baked into tauri.conf.json
// before a byte of it is executed, so a compromised release host still can't
// ship code to installed copies.
//
// Deliberately NOT automatic. This IDE holds live agent sessions and unsaved
// buffers in PTYs; relaunching under someone mid-task would destroy work that
// only exists in a terminal scrollback. We check, we tell, they choose.
//
// Linux note: only the AppImage can self-update. .deb/.rpm installs return no
// update — their package manager owns that, and fighting it corrupts installs.
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export interface UpdateInfo {
  version: string;
  notes?: string;
  date?: string;
}

let pending: Update | null = null;

/** Returns the available update, or null when current / unsupported install. */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  const update = await check();
  if (!update) return null;
  pending = update;
  return { version: update.version, notes: update.rawJson?.notes as string | undefined, date: update.date };
}

/**
 * Download, verify and install the pending update, then relaunch.
 * `onProgress` reports 0..1 — updates are ~15-20MB (no delta support), which is
 * long enough on a slow link that silence reads as a hang.
 */
export async function installUpdate(onProgress?: (fraction: number) => void): Promise<void> {
  if (!pending) throw new Error("no update pending — check first");
  let total = 0;
  let got = 0;
  await pending.downloadAndInstall((event) => {
    if (event.event === "Started") {
      total = event.data.contentLength ?? 0;
    } else if (event.event === "Progress") {
      got += event.data.chunkLength;
      if (total > 0) onProgress?.(Math.min(1, got / total));
    } else if (event.event === "Finished") {
      onProgress?.(1);
    }
  });
  // Only reached if install succeeded; a failed verify throws above.
  await relaunch();
}

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

/** `auto` installs in place; `manual` can only point at the downloads page
 *  (.deb/.rpm — see the Linux note above). */
export type UpdateAvailability =
  | { kind: "auto"; info: UpdateInfo }
  | { kind: "manual"; info: UpdateInfo }
  | null;

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

function newerThan(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

/**
 * Update check that also covers installs the plugin can't serve.
 *
 * The plugin reports "no update" both when we're current AND on .deb/.rpm
 * installs it refuses to touch — indistinguishable from here. So on Linux a
 * quiet plugin answer gets a second opinion from the GitHub API (api.github.com
 * sends CORS headers; the release-asset URLs don't, so this is the only feed a
 * webview fetch can read). A version we can see but not install becomes a
 * `manual` availability: notify, and point at the downloads page.
 */
export async function checkForUpdateAnyChannel(): Promise<UpdateAvailability> {
  let pluginFailed = false;
  try {
    const u = await checkForUpdate();
    if (u) return { kind: "auto", info: u };
  } catch {
    pluginFailed = true; // unsupported install type — fall through to the feed
  }
  if (!pluginFailed && !/Linux/.test(navigator.userAgent)) return null;
  try {
    const res = await fetch(
      "https://api.github.com/repos/FluidWorksApp/canopy-ide/releases/latest",
      { headers: { Accept: "application/vnd.github+json" } },
    );
    if (!res.ok) return null;
    const rel = (await res.json()) as { tag_name?: string; published_at?: string };
    const latest = rel.tag_name?.replace(/^v/, "");
    const { getVersion } = await import("@tauri-apps/api/app");
    const current = await getVersion();
    if (latest && newerThan(latest, current)) {
      return { kind: "manual", info: { version: latest, date: rel.published_at } };
    }
  } catch {
    // offline or rate-limited — a background check just stays quiet
  }
  return null;
}

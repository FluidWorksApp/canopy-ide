// One subscription to the clipboard watcher, shared by everything that wants
// clips — which today is the ⌘K source and Settings.
//
// The same shape as prWatchStore, for the same reason: the palette asks its
// sources on every keystroke, and a source that made an IPC call per keystroke
// would be a round trip per character for a list of at most a couple of hundred
// short strings. So the list is fetched once, kept here, and refreshed when
// Rust says it changed (`clipboard:changed`) rather than on a timer.
//
// Previews only. `ipc.clipboardRead` is the one call that returns whole clip
// text, and it is made on Enter — the text of everything you have copied today
// does not belong in a module-level cache in the webview.
import * as ipc from "./ipc";
import { getSettings, SETTINGS_CHANGE_EVENT } from "./settings";

let clips: ipc.Clip[] = [];
let started = false;
/** The rules we last told Rust about, so identical calls are free. */
let declared = "";
/** Project id from the last `sync`, so a settings change can re-declare
 *  without the caller having to hand it over again. */
let project = "";
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function reload() {
  void ipc
    .clipboardRecent()
    .then((rows) => {
      clips = rows;
      emit();
    })
    .catch(() => {
      // A store that can't be opened (a newer Canopy wrote it, no home dir)
      // costs rows and nothing else — the palette's other sources are fine.
      clips = [];
      emit();
    });
}

/** Register the window-global listeners once. */
function start() {
  if (started) return;
  started = true;
  void ipc.onClipboardChanged(reload);
  void ipc.onClipboardBlocked(() => {
    // macOS is set to always deny this app the pasteboard, so nothing more is
    // coming. Reflect that in the setting rather than leaving a switch on that
    // does nothing.
    declared = "";
    clips = [];
    emit();
  });
  // Settings own the rules, so the store watches for them itself rather than
  // making every caller remember to re-declare. Switching the feature on in
  // Settings has to start the watcher then, not at the next project switch.
  if (typeof window !== "undefined") {
    window.addEventListener(SETTINGS_CHANGE_EVENT, () => sync(project));
  }
}

/** Push the current settings and active project at the watcher, and pull the
 *  list if the feature is on. Cheap to call on every settings or project
 *  change: an unchanged declaration never reaches IPC. */
export function sync(projectId: string): void {
  start();
  project = projectId;
  const s = getSettings();
  const opts: ipc.ClipboardWatchOptions = {
    enabled: s.clipboardHistory,
    persist: s.clipboardPersist,
    keep: s.clipboardKeep,
    retentionDays: s.clipboardRetentionDays,
    skipSecrets: s.clipboardSkipSecrets,
    project: projectId,
  };
  const key = JSON.stringify(opts);
  if (key === declared) return;
  declared = key;
  void ipc.clipboardWatchSet(opts).then(
    () => {
      if (opts.enabled) reload();
      else {
        // Switched off: drop what's on screen now rather than leaving a stale
        // list that looks like it is still filling up.
        clips = [];
        emit();
      }
    },
    () => {},
  );
}

/** The clips, newest first. Empty until `sync` has run with the feature on. */
export const getSnapshot = (): ipc.Clip[] => clips;

export function subscribe(fn: () => void): () => void {
  start();
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Drop one clip, from a row's own action. */
export function forget(id: number): void {
  void ipc.clipboardForget(id).then(reload, () => {});
}

/** Empty the history (Settings). */
export function clear(): void {
  void ipc.clipboardClear().then(reload, () => {});
}

/** Ask for the list again — Settings, after a change it made itself. */
export const refresh = reload;

/** Test seam: drop everything, including the once-only listener flag. */
export function __reset(): void {
  clips = [];
  listeners.clear();
  started = false;
  declared = "";
}

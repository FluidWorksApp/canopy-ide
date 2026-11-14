// Finds and loads each open project's tab icon (projectIcon.ts) and hands the
// title bar a stable id → data: URL map. Only "auto" projects and projects
// whose choice is one of their own files are looked up here; a built-in glyph,
// an inline image or "none" needs no file access and is drawn by the tab.
import { useEffect, useRef, useState } from "react";
import * as ipc from "./ipc";
import type { Project } from "./projects";
import {
  cachedIcon,
  detectProjectIcons,
  iconSignature,
  loadBestIcon,
  loadIconFile,
  normalizeProjectIcon,
  rememberIcon,
  type IconFs,
} from "./projectIcon";

export const ipcIconFs: IconFs = {
  readDir: (path) => ipc.fsReadDir(path),
  statMany: (paths) => ipc.fsStatMany(paths),
  readFile: (path, maxBytes) => ipc.fsReadFile(path, maxBytes),
};

/** Resolve one project's file icon. `undefined` means "couldn't look" (keep
 *  whatever was shown); `null` means "looked, there is none". */
export async function resolveProjectIcon(
  project: Pick<Project, "components" | "icon">,
  fs: IconFs = ipcIconFs,
): Promise<string | null | undefined> {
  const choice = normalizeProjectIcon(project.icon);
  if (choice && choice.kind !== "path") return null;
  if (choice?.kind === "path") {
    // Its folder unreadable is "can't look" (scope not registered yet, host
    // away): keep what was shown. Listed but the file gone or not an image
    // is "no icon": the tab goes back to text.
    const cut = Math.max(choice.path.lastIndexOf("/"), choice.path.lastIndexOf("\\"));
    let names: Set<string>;
    try {
      names = new Set((await fs.readDir(choice.path.slice(0, cut) || "/")).map((e) => e.name));
    } catch {
      return undefined;
    }
    if (!names.has(choice.path.slice(cut + 1))) return null;
    return (await loadIconFile(choice.path, fs)) ?? null;
  }
  let candidates;
  try {
    candidates = await detectProjectIcons(project.components.map((c) => c.path), fs);
  } catch {
    return undefined;
  }
  return loadBestIcon(candidates, fs);
}

// One lookup at a time across every tab: a title bar of ten projects on a
// workspace host must not fire ninety directory reads at once.
let queue: Promise<unknown> = Promise.resolve();
const serial = <T,>(task: () => Promise<T>): Promise<T> => {
  const next = queue.then(task, task);
  queue = next.catch(() => {});
  return next;
};

export function useProjectIcons(
  projects: readonly Project[],
  asleep: Readonly<Record<string, unknown>>,
  fs: IconFs = ipcIconFs,
): Readonly<Record<string, string>> {
  const [icons, setIcons] = useState<Record<string, string>>({});
  /** project id → the setup (signature plus awake state) last looked up. */
  const done = useRef(new Map<string, string>());
  /** Setup → lookups that couldn't look, so a missing scope retries a few times. */
  const misses = useRef(new Map<string, number>());
  const mounted = useRef(true);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const set = (id: string, src: string | null) =>
      setIcons((prev) => {
        if ((prev[id] ?? null) === src) return prev;
        const next = { ...prev };
        if (src) next[id] = src;
        else delete next[id];
        return next;
      });
    for (const p of projects) {
      const choice = normalizeProjectIcon(p.icon);
      if (choice && choice.kind !== "path") {
        done.current.delete(p.id);
        set(p.id, null);
        continue;
      }
      const sig = iconSignature(p);
      const sleeping = p.id in asleep;
      const key = `${sig}|${sleeping ? "asleep" : "awake"}`;
      const prior = done.current.get(p.id);
      if (prior === key) continue;
      done.current.set(p.id, key);
      // Show what this setup last showed straight away. A changed setup
      // (other folders, another chosen file) starts from text until its
      // lookup lands; falling asleep or waking keeps what is on screen.
      const cached = cachedIcon(p.id, sig);
      if (cached !== undefined) set(p.id, cached);
      else if (prior !== undefined && prior.slice(0, prior.lastIndexOf("|")) !== sig) set(p.id, null);
      // A sleeping project's folders are out of scope until it wakes.
      if (sleeping) continue;
      void serial(() => resolveProjectIcon(p, fs)).then((src) => {
        if (!mounted.current || done.current.get(p.id) !== key) return;
        if (src === undefined) {
          // Couldn't look: the scope is registered asynchronously at startup,
          // or a workspace host is away. Retry a few times, then leave the
          // last known icon (or text) in place.
          const n = (misses.current.get(key) ?? 0) + 1;
          misses.current.set(key, n);
          if (n <= 3) {
            done.current.delete(p.id);
            setTimeout(() => mounted.current && setRetry((r) => r + 1), 2000 * n);
          }
          return;
        }
        misses.current.delete(key);
        rememberIcon(p.id, sig, src);
        set(p.id, src);
      });
    }
  }, [projects, asleep, fs, retry]);

  return icons;
}

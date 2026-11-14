// A project tab's icon: picked up from the project's own folders (a favicon or
// app icon it already ships), or chosen by the user in the Edit project dialog.
//
// Everything here goes through the existing scoped file commands (fs_read_dir,
// fs_stat_many, fs_read_file), so it works wherever those work — this Mac and a
// workspace host alike — and needs no native change. The bytes come back as a
// `data:` URL rendered only through <img>: an SVG from a project folder is
// untrusted, and an <img> never runs its scripts or lets it touch the page.
import type { Project } from "./projects";

/** The user's choice for a project's tab icon. Absent means "auto": use the
 *  best icon detected in the project's folders, or none if there isn't one. */
export type ProjectIcon =
  /** Text only, whatever the project ships. */
  | { kind: "none" }
  /** A built-in glyph from {@link BUILTIN_ICONS}. */
  | { kind: "emoji"; emoji: string }
  /** One specific file inside the project (a detected icon the user picked). */
  | { kind: "path"; path: string }
  /** An image the user picked from anywhere, stored small and inline. */
  | { kind: "image"; dataUrl: string };

/** The built-in choices. Plain emoji: no art copied from anywhere. */
export const BUILTIN_ICONS = [
  "🌲", "🚀", "⚡", "🔥", "💡", "📦", "🛠️", "🎨", "🧪", "📱", "🌐", "🤖", "💰", "📊", "🎮", "📝",
] as const;

/** Largest icon file we will read from a project. Favicons are a few KB; an
 *  app icon PNG can be a few hundred. Anything bigger is not a tab icon. */
export const MAX_ICON_BYTES = 512 * 1024;
/** Largest image kept inline in the project (a picked file, after shrinking). */
export const MAX_INLINE_ICON_BYTES = 96 * 1024;

/** Directories looked in, relative to each component root. Shallow on purpose:
 *  icons live in a handful of conventional places, and every one listed is a
 *  round trip on a workspace host. */
export const ICON_DIRS = [
  "",
  "public",
  "static",
  "app",
  "src/app",
  "assets",
  "src/assets",
  "public/icons",
  "src-tauri/icons",
] as const;

/** Path segments that mean "dependency or build output", never a source icon. */
const IGNORED_SEGMENTS = new Set([
  "node_modules", "dist", "build", "out", ".next", ".nuxt", ".output", ".svelte-kit",
  "target", "coverage", ".git", ".turbo", ".vercel", ".cache", "vendor", "Pods",
]);

const ICON_EXT = /\.(svg|png|ico|webp)$/i;
/** favicon.svg, favicon-32x32.png, icon.png, icon-192.png, apple-touch-icon.png… */
const ICON_NAME = /^(favicon|icon|apple-touch-icon|apple-icon|android-chrome)([-_.@][\w.@-]*)?\.(svg|png|ico|webp)$/i;

export interface IconCandidate {
  /** Absolute path, as handed to the file commands. */
  path: string;
  /** Path relative to its component root, forward slashes. */
  rel: string;
  /** Which component (in project order) it came from. */
  component: number;
  /** Bytes, when known. Unknown sizes are capped by the read itself. */
  size?: number;
  /** Named by a <link rel="icon"> in the component's root index.html. */
  fromHtml?: boolean;
}

const extOf = (rel: string) => (rel.match(/\.([a-z0-9]+)$/i)?.[1] ?? "").toLowerCase();
const dirOf = (rel: string) => (rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "");
const baseOf = (rel: string) => rel.slice(rel.lastIndexOf("/") + 1);

/** Does this file, found in `dir` (one of ICON_DIRS), look like an icon? */
export function isIconFile(dir: string, name: string): boolean {
  if (!ICON_EXT.test(name)) return false;
  // The Tauri icon folder holds nothing but icons, under size-named files.
  if (dir === "src-tauri/icons") return true;
  return ICON_NAME.test(name);
}

/** A size hint from the file name: "favicon-32x32.png" → 32, "icon-192.png" →
 *  192, "128x128@2x.png" → 256. apple-touch icons are 180 by convention. */
export function sizeHint(rel: string): number | undefined {
  const name = baseOf(rel).toLowerCase();
  const scale = /@2x/.test(name) ? 2 : /@3x/.test(name) ? 3 : 1;
  const square = name.match(/(\d{2,4})x(\d{2,4})/);
  if (square) return Number(square[1]) * scale;
  const single = name.match(/[-_](\d{2,4})(?=[-_.@])/);
  if (single) return Number(single[1]) * scale;
  if (name.startsWith("apple-touch-icon") || name.startsWith("apple-icon")) return 180;
  return undefined;
}

function score(c: IconCandidate): number {
  const ext = extOf(c.rel);
  const name = baseOf(c.rel).toLowerCase();
  // A favicon is the project's own answer to "what is my icon", so one found
  // by name or named by index.html beats any other icon in the folders.
  const favicon = name.startsWith("favicon") || c.fromHtml ? 10000 : 0;
  // Then format: a vector stays sharp at any size; a PNG beats the ICO most
  // favicons still ship, which often holds only a blurry 16px frame.
  const format = ext === "svg" ? 3000 : ext === "png" ? 2000 : ext === "webp" ? 1900 : 1000;
  const dir = dirOf(c.rel);
  const depth = dir ? dir.split("/").length : 0;
  let place: number;
  if (dir === "" || dir === "public" || dir === "static" || dir === "app" || dir === "src/app") place = 300;
  else if (dir === "assets" || dir === "src/assets" || dir === "public/icons") place = 200;
  else if (dir === "src-tauri/icons") place = 150;
  else place = 100 - depth * 20;
  // The project said so itself.
  if (c.fromHtml) place += 250;
  const naming = name.startsWith("favicon")
    ? 60
    : name.startsWith("icon")
      ? 50
      : name.startsWith("apple")
        ? 30
        : name.startsWith("android")
          ? 20
          : 0;
  let fit = 0;
  if (ext !== "svg") {
    // Tauri's unsized icon.png is the 512–1024px master the others are cut from.
    const px = sizeHint(c.rel) ?? (dir === "src-tauri/icons" ? 1024 : undefined);
    // A 14px slot on a 2x screen wants ~28–64 real pixels; anything from 32
    // to 256 scales down cleanly, tiny frames blur up, huge ones waste a read.
    if (px !== undefined) {
      if (px < 32) fit = -60;
      else if (px > 512) fit = -40;
      else fit = 40 - Math.abs(Math.log2(px / 96)) * 10;
    }
  }
  return favicon + format + place + naming + fit - c.component * 5;
}

/** Order candidate icons best-first — favicons (by name, or linked from
 *  index.html) first, then SVG over PNG over ICO, then root/public over deeper
 *  folders and sensibly sized PNGs over tiny or huge ones — dropping the ones that must not be used:
 *  anything under dependency or build output, anything not an icon format,
 *  and anything over {@link MAX_ICON_BYTES}. Pure; the order is total (ties
 *  break on the relative path) so the same folder always gives the same icon. */
export function rankIconCandidates(candidates: readonly IconCandidate[]): IconCandidate[] {
  const seen = new Set<string>();
  return candidates
    .filter((c) => {
      if (seen.has(c.path)) return false;
      seen.add(c.path);
      if (!ICON_EXT.test(c.rel)) return false;
      if (c.rel.split("/").some((segment) => IGNORED_SEGMENTS.has(segment) || segment === "..")) return false;
      if (c.size !== undefined && (c.size <= 0 || c.size > MAX_ICON_BYTES)) return false;
      return true;
    })
    .map((c) => ({ c, s: score(c) }))
    .sort((a, b) => b.s - a.s || (a.c.rel < b.c.rel ? -1 : a.c.rel > b.c.rel ? 1 : 0))
    .map(({ c }) => c);
}

/** The hrefs of `<link rel="icon">` (and "shortcut icon", "apple-touch-icon")
 *  in an HTML document, in document order. Mask icons are monochrome
 *  silhouettes meant for tinting, so they are skipped. */
export function iconLinkHrefs(html: string): string[] {
  const out: string[] = [];
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const attrs: Record<string, string> = {};
    for (const m of tag.matchAll(/([a-zA-Z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
      attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
    }
    const rel = (attrs.rel ?? "").toLowerCase().split(/\s+/);
    if (!rel.includes("icon") && !rel.includes("apple-touch-icon")) continue;
    if (attrs.href) out.push(attrs.href);
  }
  return out;
}

/** Where a link href can point inside the component, relative to its root.
 *  A root-absolute href ("/favicon.svg") is served from the public folder by
 *  most dev servers, or from the root itself; both are returned. Anything
 *  remote, inline or escaping the root gives nothing. */
export function resolveIconHref(href: string): string[] {
  const clean = href.trim().split(/[?#]/)[0];
  if (!clean || /^[a-z][a-z0-9+.-]*:/i.test(clean) || clean.startsWith("//")) return [];
  const absolute = clean.startsWith("/");
  const parts: string[] = [];
  for (const part of clean.replace(/^\/+/, "").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") return [];
    parts.push(part);
  }
  if (!parts.length) return [];
  let rel = parts.join("/");
  try {
    rel = decodeURIComponent(rel);
  } catch {
    return [];
  }
  return absolute ? [`public/${rel}`, rel] : [rel];
}

/** The image type of some bytes, by their content rather than their name, or
 *  null when they are not an image we show. */
export function sniffImageType(bytes: Uint8Array): string | null {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 6 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return "image/x-icon";
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  const head = new TextDecoder().decode(b.subarray(0, 2048)).replace(/^﻿/, "").trimStart();
  if (head.startsWith("<") && /<svg[\s>]/i.test(head)) return "image/svg+xml";
  return null;
}

export function bytesToDataUrl(bytes: Uint8Array, type: string): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return `data:${type};base64,${btoa(binary)}`;
}

const DATA_URL = /^data:image\/(png|svg\+xml|x-icon|vnd\.microsoft\.icon|webp|jpeg|gif);base64,[A-Za-z0-9+/]+=*$/;

/** A stored icon choice, checked. Anything malformed (a hand-edited or
 *  imported workspace file) reads as "auto", which is today's behaviour. */
export function normalizeProjectIcon(raw: unknown): ProjectIcon | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const v = raw as Record<string, unknown>;
  if (v.kind === "none") return { kind: "none" };
  if (v.kind === "emoji" && typeof v.emoji === "string" && v.emoji.trim() && v.emoji.length <= 8)
    return { kind: "emoji", emoji: v.emoji };
  if (v.kind === "path" && typeof v.path === "string" && v.path) return { kind: "path", path: v.path };
  if (v.kind === "image" && typeof v.dataUrl === "string" &&
    v.dataUrl.length <= MAX_INLINE_ICON_BYTES * 2 && DATA_URL.test(v.dataUrl))
    return { kind: "image", dataUrl: v.dataUrl };
  return undefined;
}

/** What a tab shows, given the user's choice and what detection found.
 *  The user's choice always wins; "auto" and a picked project file both show
 *  the loaded file (`loaded`), when there is one. */
export type TabIcon = { kind: "img"; src: string } | { kind: "emoji"; text: string } | null;
export function tabIconFor(icon: unknown, loaded: string | undefined): TabIcon {
  const choice = normalizeProjectIcon(icon);
  if (choice?.kind === "none") return null;
  if (choice?.kind === "emoji") return { kind: "emoji", text: choice.emoji };
  if (choice?.kind === "image") return { kind: "img", src: choice.dataUrl };
  return loaded && DATA_URL.test(loaded) ? { kind: "img", src: loaded } : null;
}

// ---------- reading from the project's folders ----------

export interface IconFs {
  readDir(path: string): Promise<{ name: string; path: string; is_dir: boolean }[]>;
  statMany(paths: string[]): Promise<{ path: string; size: number }[]>;
  readFile(path: string, maxBytes: number): Promise<Uint8Array>;
}

const joinPath = (root: string, rel: string) =>
  rel ? `${root.replace(/[\\/]+$/, "")}/${rel}` : root;

/** Every icon found in the project's folders, best-first. Each directory read
 *  is caught on its own: a folder that isn't there is the common case. Throws
 *  only when not one component root could be listed at all — that is "can't
 *  look" (out of scope, a host that's gone), which callers must not mistake
 *  for "has no icon". */
export async function detectProjectIcons(roots: readonly string[], fs: IconFs): Promise<IconCandidate[]> {
  const found: IconCandidate[] = [];
  let listedAny = false;
  let lastError: unknown = null;
  for (const [component, root] of roots.entries()) {
    const listed = new Map<string, Set<string>>();
    let top: { name: string; is_dir: boolean }[];
    try {
      top = await fs.readDir(root);
      listedAny = true;
    } catch (error) {
      lastError = error;
      continue;
    }
    listed.set("", new Set(top.filter((e) => !e.is_dir).map((e) => e.name)));
    // Only folders whose first step exists: on a workspace host every read is
    // a round trip, and most projects have two or three of these at most.
    const topDirs = new Set(top.filter((e) => e.is_dir).map((e) => e.name));
    await Promise.all(
      ICON_DIRS.filter((dir) => dir && topDirs.has(dir.split("/")[0])).map(async (dir) => {
        try {
          const entries = await fs.readDir(joinPath(root, dir));
          listed.set(dir, new Set(entries.filter((e) => !e.is_dir).map((e) => e.name)));
        } catch {
          // Not there: the common case.
        }
      }),
    );
    for (const [dir, names] of listed) {
      for (const name of names) {
        if (!isIconFile(dir, name)) continue;
        const rel = dir ? `${dir}/${name}` : name;
        found.push({ path: joinPath(root, rel), rel, component });
      }
    }
    if (listed.get("")?.has("index.html")) {
      try {
        const html = new TextDecoder().decode(await fs.readFile(joinPath(root, "index.html"), 256 * 1024));
        for (const href of iconLinkHrefs(html)) {
          for (const rel of resolveIconHref(href)) {
            const dir = dirOf(rel);
            let names = listed.get(dir);
            if (!names) {
              try {
                const entries = await fs.readDir(joinPath(root, dir));
                names = new Set(entries.filter((e) => !e.is_dir).map((e) => e.name));
              } catch {
                names = new Set();
              }
              listed.set(dir, names);
            }
            if (names.has(baseOf(rel))) found.push({ path: joinPath(root, rel), rel, component, fromHtml: true });
          }
        }
      } catch {
        // An unreadable index.html just means no hint from it.
      }
    }
  }
  if (!listedAny && roots.length) throw lastError ?? new Error("project folders could not be listed");
  // Prefer the html-linked copy of a path that was also found by name.
  const byPath = new Map<string, IconCandidate>();
  for (const c of found) {
    const prior = byPath.get(c.path);
    if (!prior || (c.fromHtml && !prior.fromHtml)) byPath.set(c.path, c);
  }
  const unique = [...byPath.values()];
  try {
    const sizes = new Map((await fs.statMany(unique.map((c) => c.path))).map((s) => [s.path, s.size]));
    for (const c of unique) c.size = sizes.get(c.path);
  } catch {
    // Sizes are an optimisation; the read below is capped regardless.
  }
  return rankIconCandidates(unique);
}

/** Read one icon file into a `data:` URL, typed by its bytes. Null when it
 *  is missing, too big, or not an image. */
export async function loadIconFile(path: string, fs: IconFs): Promise<string | null> {
  try {
    const bytes = await fs.readFile(path, MAX_ICON_BYTES);
    const type = sniffImageType(bytes);
    if (!type) return null;
    const url = bytesToDataUrl(bytes, type);
    return type === "image/svg+xml" || bytes.length <= 24 * 1024 ? url : (await shrinkImage(url)) ?? url;
  } catch {
    return null;
  }
}

/** The first candidate that actually loads. */
export async function loadBestIcon(candidates: readonly IconCandidate[], fs: IconFs): Promise<string | null> {
  for (const c of candidates.slice(0, 6)) {
    const url = await loadIconFile(c.path, fs);
    if (url) return url;
  }
  return null;
}

/** Redraw a raster image at `size` px as a PNG `data:` URL, so a 512px app
 *  icon costs a few KB to keep rather than a few hundred. Best-effort: null
 *  outside a real browser, or if the image won't decode. */
export function shrinkImage(src: string, size = 64): Promise<string | null> {
  return new Promise((resolve) => {
    if (typeof document === "undefined" || typeof Image === "undefined" || /jsdom/i.test(navigator.userAgent)) {
      resolve(null);
      return;
    }
    const img = new Image();
    const timer = setTimeout(() => resolve(null), 3000);
    img.onload = () => {
      clearTimeout(timer);
      try {
        const scale = Math.min(1, size / Math.max(img.naturalWidth || size, img.naturalHeight || size));
        const w = Math.max(1, Math.round((img.naturalWidth || size) * scale));
        const h = Math.max(1, Math.round((img.naturalHeight || size) * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) return resolve(null);
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/png"));
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => {
      clearTimeout(timer);
      resolve(null);
    };
    img.src = src;
  });
}

/** Turn a file the user picked (from anywhere on disk, via the webview's own
 *  file input) into an inline icon. Rasters are shrunk to 64px; an SVG is
 *  kept as is, and like every icon only ever drawn through <img>. */
export async function iconFromPickedFile(file: Blob): Promise<ProjectIcon> {
  if (file.size > 4 * 1024 * 1024) throw new Error("That image is too large.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = sniffImageType(bytes);
  if (!type) throw new Error("Not an image Canopy can show.");
  let url = bytesToDataUrl(bytes, type);
  if (type !== "image/svg+xml") url = (await shrinkImage(url)) ?? url;
  if (url.length > MAX_INLINE_ICON_BYTES * 2 || !DATA_URL.test(url)) throw new Error("That image is too large.");
  return { kind: "image", dataUrl: url };
}

// ---------- remembered results ----------
// A sleeping project's folders are out of scope until it wakes, and a
// workspace host can be slow to answer; the last icon a project showed is
// kept per viewer so its tab doesn't flicker back to text meanwhile. A
// convenience only — it is never the source of truth.

const CACHE_KEY = "canopy:project-icons:v1";
const CACHE_MAX_ENTRY = 64 * 1024;

type CacheEntry = { sig: string; src: string | null };

function readCache(): Record<string, CacheEntry> {
  try {
    const raw = JSON.parse(localStorage.getItem(CACHE_KEY) ?? "{}");
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

/** What to look for, as a string: changes whenever the folders or the choice
 *  change, so a stale remembered icon is never shown for a new setup. */
export function iconSignature(project: Pick<Project, "components" | "icon">): string {
  const choice = normalizeProjectIcon(project.icon);
  return JSON.stringify([project.components.map((c) => c.path), choice?.kind === "path" ? choice.path : null]);
}

export function cachedIcon(projectId: string, sig: string): string | null | undefined {
  const entry = readCache()[projectId];
  return entry && entry.sig === sig ? entry.src : undefined;
}

export function rememberIcon(projectId: string, sig: string, src: string | null): void {
  try {
    const cache = readCache();
    if (src && src.length > CACHE_MAX_ENTRY) delete cache[projectId];
    else cache[projectId] = { sig, src };
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    // Storage full or blocked: the icon is simply looked up again next time.
  }
}

// Real file-type icons, from the Material Icon Theme — the same icon set VS
// Code users see. Hand-picked emoji couldn't cover the long tail (a brown
// square for .js, a puzzle piece for every .json), and this ships 1250 SVGs
// with a 3,500-entry mapping maintained by that project.
//
// Everything is bundled locally: the SVGs become build assets, so the app stays
// fully offline. Folders deliberately keep our own yellow folder icon rather
// than Material's.
import manifest from "material-icon-theme/dist/material-icons.json";

// Eager, but `?url` means each entry is just a string — the SVG bytes stay in
// separate asset files (vite.config.ts opts them out of inlining), so the
// webview fetches only the handful a folder actually renders.
const files = import.meta.glob("/node_modules/material-icon-theme/icons/*.svg", {
  query: "?url",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** icon name ("javascript") -> asset URL */
const byName = new Map<string, string>();
for (const [path, url] of Object.entries(files)) {
  const name = path.slice(path.lastIndexOf("/") + 1, -".svg".length);
  byName.set(name, url);
}

interface Manifest {
  fileExtensions: Record<string, string>;
  fileNames: Record<string, string>;
  languageIds: Record<string, string>;
  file: string;
}
const m = manifest as unknown as Manifest;

const cache = new Map<string, string | undefined>();

/**
 * Icon URL for a file name, following the theme's own precedence:
 * exact file name first, then the longest matching extension (so `.test.ts`
 * beats `.ts`), then the generic file icon.
 */
export function fileIconUrl(fileName: string): string | undefined {
  const key = fileName.toLowerCase();
  const hit = cache.get(key);
  if (hit !== undefined || cache.has(key)) return hit;

  let icon = m.fileNames[key];
  if (!icon) {
    const parts = key.split(".");
    // "foo.spec.ts" -> try "spec.ts", then "ts"
    for (let i = 1; i < parts.length; i++) {
      const ext = parts.slice(i).join(".");
      if (m.fileExtensions[ext]) {
        icon = m.fileExtensions[ext];
        break;
      }
    }
  }
  const url = byName.get(icon ?? m.file) ?? byName.get("file");
  cache.set(key, url);
  return url;
}

// Window zoom: Cmd/Ctrl +/-/0 scales the whole webview, and the level is
// persisted so the app reopens at the user's last zoom. Backed by Tauri's
// native webview setZoom (a real compositor-level zoom, not a CSS transform),
// so text stays crisp and layout reflows naturally.

const KEY = "canopy.zoom";
export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 2.0;
export const STEP = 0.1;
const DEFAULT_ZOOM = 1.0;

/** Snap to one decimal so accumulated float error can't drift the level. */
function round(z: number): number {
  return Math.round(z * 10) / 10;
}

export function clampZoom(z: number): number {
  return round(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z)));
}

export function loadZoom(): number {
  const raw = Number(localStorage.getItem(KEY));
  return Number.isFinite(raw) && raw > 0 ? clampZoom(raw) : DEFAULT_ZOOM;
}

function saveZoom(z: number): void {
  localStorage.setItem(KEY, String(z));
}

/** Push a zoom level to the native webview. No-op outside Tauri (dev in a
 *  plain browser), where the API import fails — caught so it never throws.
 *  Returns whether the level actually reached the webview. */
export async function applyZoom(z: number): Promise<boolean> {
  try {
    const { getCurrentWebview } = await import("@tauri-apps/api/webview");
    await getCurrentWebview().setZoom(z);
    // Anything sized to match native chrome has to divide by this — the
    // webview zoom scales CSS px, but the macOS traffic lights are drawn by
    // AppKit in window points and don't scale with it. Only stamped once the
    // zoom really applied, so the compensation can't outrun the zoom itself.
    document.documentElement.style.setProperty("--zoom", String(z));
    return true;
  } catch {
    // Not running under Tauri (or the webview-zoom capability is missing from
    // an older src-tauri build) — leave --zoom unset so CSS falls back to 1.
    return false;
  }
}

/** Persist + apply a new level, returning the clamped value actually used. */
export function setZoom(z: number): number {
  const next = clampZoom(z);
  saveZoom(next);
  void applyZoom(next);
  return next;
}

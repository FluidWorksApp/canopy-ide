// Wallpaper: one image, copied into ~/.canopy/backgrounds/ (see fsx.rs),
// shown behind chrome (titlebar/rail/tab-bar/panel gutters), the welcome
// screen, the terminal, and the sidebar's own content (git panel, file tree)
// — everywhere index.css gates on html[data-canopy-bg="1"], plus Term.tsx
// for the one surface CSS alone can't reach (xterm renders to a canvas, not
// the DOM). Monaco is deliberately not in that list — this is meant to
// dress the shell and side frame, not the code editor itself, where the
// actual work happens. Blob URLs are used instead of the asset:// protocol
// so nothing needs a capabilities/CSP scope change for an arbitrary
// user-picked file outside any workspace root.
import * as ipc from "./ipc";
import { getSettings, updateSettings, THEME_CHANGE_EVENT } from "./settings";

let objectUrl: string | null = null;

/** How much of the theme's own solid color still shows on top of the
 *  wallpaper, 0..1 — one formula, used for the chrome dim overlay AND the
 *  terminal's background alpha (Term.tsx), so "Opacity" means one thing
 *  everywhere it applies. 100 (max opacity, image at its clearest) still
 *  keeps a 0.15 floor so chrome/terminal text stays readable against an
 *  arbitrary photo; 0 tops out at 0.80, not fully solid, so there's still a
 *  visible transition rather than a hard cutoff right at the bottom. */
export function backgroundDim(opacity: number): number {
  return 0.15 + (1 - opacity / 100) * 0.65;
}

function setCssVars(hasImage: boolean, opacity: number) {
  const root = document.documentElement;
  root.dataset.canopyBg = hasImage ? "1" : "";
  if (hasImage) {
    const dim = backgroundDim(opacity);
    // Blur eases off as the image gets clearer — less blur at high opacity
    // (you want to actually see it), more at low (fading out and softening
    // together reads as one "how present is this" dial, not two).
    const blur = dim * 14;
    root.style.setProperty("--chrome-bg-image", objectUrl ? `url("${objectUrl}")` : "none");
    root.style.setProperty("--chrome-bg-blur", `${blur.toFixed(1)}px`);
    root.style.setProperty("--chrome-bg-dim", dim.toFixed(2));
  } else {
    root.style.removeProperty("--chrome-bg-image");
    root.style.removeProperty("--chrome-bg-blur");
    root.style.removeProperty("--chrome-bg-dim");
  }
  // Term.tsx can't pick up a CSS custom property change on its own (xterm's
  // background is a JS-side theme option, not something painted by the DOM
  // it happens to sit in) — same live-update channel applyTheme() uses.
  window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT));
}

/** Load whatever background is currently on disk (if any) and apply it.
 *  Safe to call with nothing set — settings just say so and this is a no-op
 *  beyond clearing the CSS vars. Call once at boot. */
export async function loadBackground(): Promise<void> {
  const settings = getSettings();
  if (!settings.backgroundMime) {
    setCssVars(false, settings.backgroundOpacity);
    return;
  }
  try {
    const bytes = await ipc.backgroundBytes();
    // A fresh ArrayBuffer, not bytes.buffer directly: same reasoning as
    // viewers.tsx's useBlobUrl — the typed array's backing buffer type
    // (ArrayBufferLike) isn't narrow enough for BlobPart.
    const copy = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(copy).set(bytes);
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(new Blob([copy], { type: settings.backgroundMime }));
    setCssVars(true, settings.backgroundOpacity);
  } catch {
    // The file on disk is gone (e.g. someone cleared ~/.canopy/backgrounds by
    // hand) — fall back to "no background" rather than a broken image.
    updateSettings({ backgroundMime: null });
    setCssVars(false, settings.backgroundOpacity);
  }
}

/** Copy `path` in as the new background and apply it immediately. */
export async function setBackground(path: string): Promise<void> {
  const mime = await ipc.backgroundSet(path);
  updateSettings({ backgroundMime: mime });
  await loadBackground();
}

export async function clearBackground(): Promise<void> {
  await ipc.backgroundClear();
  updateSettings({ backgroundMime: null });
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  }
  setCssVars(false, getSettings().backgroundOpacity);
}

export function setBackgroundOpacity(opacity: number): void {
  const clamped = Math.max(0, Math.min(100, opacity));
  updateSettings({ backgroundOpacity: clamped });
  setCssVars(!!getSettings().backgroundMime, clamped);
}

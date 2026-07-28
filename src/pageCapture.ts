// Taking a picture of the previewed page, for handing to an agent or a task.
//
// Two modes, because a screenshot is either "what I'm looking at" or "this bit
// of it", and cropping afterwards in some other app defeats the point of the
// button. Both end in the same place: a PNG saved under the workspace, whose
// path an agent's own file tools can read (the same route SpotSearch's Run Task
// uses — see spotContext.capturePageContext).
//
// The pixels themselves come from whichever engine is behind the tab, so the
// caller supplies the shooter; everything here is engine-agnostic. Region mode
// is drawn INSIDE the page by the injected picker rather than as an overlay in
// this window, because under the webview engine the page is a native view
// composited above the whole window — an overlay in our DOM would be behind it.

/** Which pixels the Screenshot button grabs. Persisted (settings) so the
 *  button's one-click action is whatever the user chose last. */
export type CaptureMode = "visible" | "region";

export const CAPTURE_MODES: { id: CaptureMode; label: string; hint: string }[] =
  [
    { id: "visible", label: "Visible page", hint: "what's on screen" },
    { id: "region", label: "Select a region…", hint: "drag on the page" },
  ];

export const captureModeLabel = (m: CaptureMode): string =>
  CAPTURE_MODES.find((c) => c.id === m)?.label ?? m;

export interface CaptureRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** How many image pixels one CSS pixel of the page is worth.
 *
 *  The page reports a region in its own CSS pixels; the snapshot arrives at
 *  whatever size the platform produced (Retina backing scale, or downscaled by
 *  a `maxWidth`). Deriving the factor from the two widths covers both without
 *  the caller having to know which happened. */
export function pixelScale(pngWidth: number, cssWidth: number): number {
  if (!(pngWidth > 0) || !(cssWidth > 0)) return 1;
  return pngWidth / cssWidth;
}

/** A page-space rect in image pixels, clamped to the image. Returns null when
 *  nothing survives the clamp — a drag that ended outside the view, or one so
 *  small it is a stray click rather than a selection. */
export function scaleRect(
  rect: CaptureRect,
  scale: number,
  png: { width: number; height: number },
): CaptureRect | null {
  const x = Math.max(0, Math.round(rect.x * scale));
  const y = Math.max(0, Math.round(rect.y * scale));
  const w = Math.min(Math.round(rect.w * scale), png.width - x);
  const h = Math.min(Math.round(rect.h * scale), png.height - y);
  if (w < 2 || h < 2) return null;
  return { x, y, w, h };
}

/** The size a capture is stored at: big enough to read UI text in, small
 *  enough that a handful of them don't bloat the workspace. */
export const MAX_STORED_WIDTH = 1600;
/** The size the panel shows. Thumbnails are inline data URLs held in tab
 *  state, so they stay small on purpose. */
export const THUMB_WIDTH = 220;

/** Fit-to-width, never enlarging — a 400px-wide region should stay 400px. */
export function fitWidth(
  size: { width: number; height: number },
  max: number,
): { width: number; height: number } {
  if (size.width <= max || !(size.width > 0)) return size;
  return {
    width: max,
    height: Math.max(1, Math.round((size.height * max) / size.width)),
  };
}

const dataUrl = (base64Png: string) => `data:image/png;base64,${base64Png}`;

const loadImage = (base64Png: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () =>
      reject(new Error("the captured image could not be decoded"));
    img.src = dataUrl(base64Png);
  });

const toBase64 = (canvas: HTMLCanvasElement): string =>
  canvas.toDataURL("image/png").replace(/^data:image\/png;base64,/, "");

export interface CapturedImage {
  /** Base64 PNG, no data: prefix — what ipc.spotSaveContextImage wants. */
  png: string;
  width: number;
  height: number;
}

/** Crop to `rect` (page CSS pixels) and cap the result's width. `rect` absent
 *  means the whole image, which is what "visible page" is. */
export async function cropCapture(
  base64Png: string,
  rect: CaptureRect | null,
  cssWidth: number,
  maxWidth = MAX_STORED_WIDTH,
): Promise<CapturedImage> {
  const img = await loadImage(base64Png);
  const source = rect
    ? scaleRect(rect, pixelScale(img.naturalWidth, cssWidth), {
        width: img.naturalWidth,
        height: img.naturalHeight,
      })
    : { x: 0, y: 0, w: img.naturalWidth, h: img.naturalHeight };
  if (!source) throw new Error("that selection was too small to capture");
  const out = fitWidth({ width: source.w, height: source.h }, maxWidth);
  const canvas = document.createElement("canvas");
  canvas.width = out.width;
  canvas.height = out.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("this display can't render the capture");
  ctx.drawImage(
    img,
    source.x,
    source.y,
    source.w,
    source.h,
    0,
    0,
    out.width,
    out.height,
  );
  return { png: toBase64(canvas), width: out.width, height: out.height };
}

/** A small inline copy for the review panel. */
export async function thumbnail(
  base64Png: string,
  max = THUMB_WIDTH,
): Promise<string> {
  const img = await loadImage(base64Png);
  const out = fitWidth(
    { width: img.naturalWidth, height: img.naturalHeight },
    max,
  );
  const canvas = document.createElement("canvas");
  canvas.width = out.width;
  canvas.height = out.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return dataUrl(base64Png);
  ctx.drawImage(img, 0, 0, out.width, out.height);
  return canvas.toDataURL("image/png");
}

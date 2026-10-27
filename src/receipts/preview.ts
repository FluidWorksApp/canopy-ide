// Preview evidence for a receipt: the page the turn affected, before and after.
//
// Checks prove the code holds together; for a change someone will *look* at,
// the page is evidence too. When the project has a preview open (Canopy's
// preview browser, or Chrome streamed from a Linux workspace), the workspace
// photographs it as an agent's turn starts and again when the receipt is
// built, and reads the page's own text and controls both times. The receipt
// keeps both pictures; the brain — whose CLI takes no images — is told what
// changed from the page text and controls, never from a guess at the pixels.
//
// Which page: the one the agent itself drove, when it opened one; otherwise
// the preview the person has open in that project. No preview, no capture, and
// nothing on screen: the ops are quiet (no pip, no tab moved; see
// browserLocalOps.ts) and a project without a preview simply answers "none".

import { localBrowserOp, type LocalOpResult } from "../browserLocalOps";
import { onAgentTurnStart, type AgentTurnStart } from "../agentTurns";
import { getSettings } from "../settings";
import type { PreviewShot, ReceiptPreview } from "./types";

/** What the page said about itself (op "snapshot"), trimmed to what we diff. */
export interface PageRead {
  url: string;
  title: string;
  lines: string[];
  controls: string[];
}

export interface Capture {
  shot: PreviewShot | null;
  page: PageRead | null;
  /** Why there is no picture, when the page answered but the camera did not. */
  why?: string;
  at: number;
}

export interface PreviewDeps {
  op(op: "screenshot" | "snapshot", route: string, ptyId: number | null): Promise<LocalOpResult>;
  /** PNG (base64) → a small JPEG data URL; null when it can't be made. */
  shrink(png: string, width: number, height: number): Promise<{ image: string; width: number; height: number } | null>;
  enabled(): boolean;
  now(): number;
}

/** The largest a stored picture may be. Two of them live in a ledger entry
 *  whose ceiling is 256 KB, next to every check's output tail. */
export const SHOT_MAX_CHARS = 48 * 1024;
const SHOT_WIDTHS = [720, 560, 420];
const SHOT_QUALITIES = [0.72, 0.55, 0.4];

async function shrinkInDom(png: string): Promise<{ image: string; width: number; height: number } | null> {
  if (typeof document === "undefined") return null;
  const img = await new Promise<HTMLImageElement | null>((resolve) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => resolve(null);
    el.src = `data:image/png;base64,${png}`;
  });
  if (!img || !img.naturalWidth) return null;
  for (const max of SHOT_WIDTHS) {
    const width = Math.min(max, img.naturalWidth);
    const height = Math.max(1, Math.round((img.naturalHeight * width) / img.naturalWidth));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);
    for (const q of SHOT_QUALITIES) {
      const image = canvas.toDataURL("image/jpeg", q);
      if (image.length <= SHOT_MAX_CHARS) return { image, width, height };
    }
  }
  return null;
}

const defaultDeps: PreviewDeps = {
  op: (op, route, ptyId) => localBrowserOp(op, route, { ptyId, max: op === "snapshot" ? 120 : undefined }),
  shrink: (png) => shrinkInDom(png),
  enabled: () => getSettings().receiptMode !== "off",
  now: () => Date.now(),
};
let deps: PreviewDeps = defaultDeps;

/** Tests only. Null restores the real ones. */
export function setPreviewDepsForTests(next: Partial<PreviewDeps> | null): void {
  deps = next ? { ...deps, ...next } : defaultDeps;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The snapshot op's answer as lines and controls we can compare. */
export function readPage(data: unknown): PageRead | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const lines = [
    ...new Set(
      str(d.text)
        .split("\n")
        .map((l) => l.replace(/\s+/g, " ").trim())
        .filter((l) => l && !l.startsWith("…(page text truncated")),
    ),
  ].slice(0, 400);
  const controls = Array.isArray(d.elements)
    ? [
        ...new Set(
          d.elements
            .map((e) => {
              const o = (e && typeof e === "object" ? e : {}) as Record<string, unknown>;
              const label = str(o.text).replace(/\s+/g, " ").trim();
              const kind = str(o.role) || str(o.tag) || "control";
              return label ? `${kind} "${clip(label, 60)}"` : "";
            })
            .filter(Boolean),
        ),
      ].slice(0, 200)
    : [];
  return { url: str(d.url), title: str(d.title), lines, controls };
}

/** Photograph and read the preview for `route`. Null when no preview answered
 *  either way — nothing is open, so there is nothing to say. */
export async function capturePreview(route: string, ptyId: number | null): Promise<Capture | null> {
  if (!route) return null;
  const at = deps.now();
  // Read first: the snapshot is cheap and tells us whether a page is there.
  const read = await deps.op("snapshot", route, ptyId).catch(() => ({ ok: false, data: null }) as LocalOpResult);
  const page = read.ok ? readPage(read.data) : null;
  const pic = await deps.op("screenshot", route, ptyId).catch(() => ({ ok: false, data: null }) as LocalOpResult);
  let shot: PreviewShot | null = null;
  let why: string | undefined;
  if (pic.ok && pic.data && typeof pic.data === "object") {
    const d = pic.data as Record<string, unknown>;
    const png = str(d.image);
    const small = png ? await deps.shrink(png, Number(d.width) || 0, Number(d.height) || 0).catch(() => null) : null;
    if (small)
      shot = {
        ...small,
        url: str(d.url) || page?.url || "",
        ...(page?.title ? { title: clip(page.title, 200) } : {}),
        at,
      };
    else why = "The picture could not be made small enough to keep.";
  } else if (page) {
    why = typeof pic.data === "string" && pic.data ? clip(pic.data, 300) : "The preview could not be photographed.";
  }
  if (!shot && !page) return null;
  return { shot, page, at, ...(why ? { why } : {}) };
}

/** What changed between two reads of the page, in plain words. */
export function describeChange(before: PageRead | null, after: PageRead | null): string[] {
  if (!before || !after) return [];
  const out: string[] = [];
  if (before.url && after.url && before.url !== after.url) out.push(`The page moved from ${before.url} to ${after.url}.`);
  if (before.title !== after.title && (before.title || after.title))
    out.push(`The page title changed from "${clip(before.title, 80)}" to "${clip(after.title, 80)}".`);
  const was = new Set(before.lines);
  const now = new Set(after.lines);
  const added = after.lines.filter((l) => !was.has(l));
  const gone = before.lines.filter((l) => !now.has(l));
  const list = (xs: string[], n: number) =>
    xs
      .slice(0, n)
      .map((x) => `"${clip(x, 100)}"`)
      .join(", ") + (xs.length > n ? ` and ${xs.length - n} more` : "");
  if (added.length) out.push(`New text on the page: ${list(added, 5)}.`);
  if (gone.length) out.push(`Text no longer on the page: ${list(gone, 5)}.`);
  const hadControls = new Set(before.controls);
  const hasControls = new Set(after.controls);
  const newControls = after.controls.filter((c) => !hadControls.has(c));
  const lostControls = before.controls.filter((c) => !hasControls.has(c));
  if (newControls.length) out.push(`New controls: ${newControls.slice(0, 6).join(", ")}${newControls.length > 6 ? ` and ${newControls.length - 6} more` : ""}.`);
  if (lostControls.length)
    out.push(`Controls gone: ${lostControls.slice(0, 6).join(", ")}${lostControls.length > 6 ? ` and ${lostControls.length - 6} more` : ""}.`);
  return out;
}

/** The receipt's preview section from the two captures (either may be null). */
export function buildPreviewEvidence(before: Capture | null, after: Capture | null): ReceiptPreview | null {
  if (!before && !after) return null;
  const url = after?.shot?.url || after?.page?.url || before?.shot?.url || before?.page?.url || "";
  const changes = describeChange(before?.page ?? null, after?.page ?? null);
  const notes: string[] = [];
  if (!before) notes.push("No picture from before the turn: the preview was not open when it started, or this was a manual check.");
  else if (!before.shot && before.why) notes.push(`Before: ${before.why}`);
  if (!after) notes.push("The preview could not be read after the turn — it may have been closed.");
  else if (!after.shot && after.why) notes.push(`After: ${after.why}`);
  const where = url ? ` of ${url}` : "";
  let summary: string;
  if (before && after) {
    summary = changes.length
      ? `Preview${where} before and after the turn: ${changes.length === 1 ? "one visible change" : `${changes.length} visible changes`} in the page's text and controls.`
      : `Preview${where} before and after the turn: the page's text and controls read the same both times.`;
    if (!before.page || !after.page) summary = `Preview${where} before and after the turn; the page's text could not be read both times, so the pictures are not compared.`;
  } else if (after) summary = `Preview${where} as it looked after the turn.`;
  else summary = `Preview${where} as it looked before the turn.`;
  return {
    url,
    ...(before?.shot ? { before: before.shot } : {}),
    ...(after?.shot ? { after: after.shot } : {}),
    changes,
    summary,
    ...(notes.length ? { note: notes.join(" ") } : {}),
  };
}

// ------------------------------------------------------------ turn capture

/** Pictures taken as turns started, newest last, a few per session. */
const befores = new Map<string, Capture[]>();
const KEEP_PER_SESSION = 3;
const KEEP_SESSIONS = 24;
/** The snapshot is stamped when the hook batch is seen; allow for that. */
const START_SLACK_MS = 15_000;

export async function captureBefore(turn: Pick<AgentTurnStart, "sessionId" | "ptyId" | "cwd">): Promise<void> {
  if (!deps.enabled()) return;
  const cap = await capturePreview(turn.cwd, turn.ptyId);
  if (!cap) return;
  const list = befores.get(turn.sessionId) ?? [];
  list.push(cap);
  if (list.length > KEEP_PER_SESSION) list.splice(0, list.length - KEEP_PER_SESSION);
  befores.delete(turn.sessionId);
  befores.set(turn.sessionId, list);
  while (befores.size > KEEP_SESSIONS) befores.delete(befores.keys().next().value!);
}

/** The "before" for a turn that started at `startedAt`: the earliest picture
 *  taken from then on (two folded turns compare against the first start). */
function takeBefore(sessionId: string, startedAt: number | undefined): Capture | null {
  const list = befores.get(sessionId);
  if (!list?.length || startedAt == null) return null;
  const hit = list.find((c) => c.at >= startedAt - START_SLACK_MS) ?? null;
  befores.delete(sessionId);
  return hit;
}

/** Called by the receipt engine: the "after" picture, and the comparison with
 *  the turn's "before". Null when there is no preview to speak of. */
export async function previewEvidence(t: {
  sessionId: string;
  ptyId: number | null;
  cwd: string;
  startedAt?: number;
}): Promise<ReceiptPreview | null> {
  // Only where the app started it: a receipt built anywhere else (a test, a
  // window with no project views) has no preview to ask.
  if (!armed || !deps.enabled()) return null;
  const before = takeBefore(t.sessionId, t.startedAt);
  const after = await capturePreview(t.cwd, t.ptyId).catch(() => null);
  return buildPreviewEvidence(before, after);
}

let armed = false;

/** startReceiptEngine starts this: a "before" picture at every turn start. */
export function startPreviewEvidence(): () => void {
  armed = true;
  const off = onAgentTurnStart((turn) => void captureBefore(turn).catch(() => {}));
  return () => {
    armed = false;
    off();
  };
}

/** Tests only. */
export function resetPreviewEvidenceForTests(armedForTest = false): void {
  armed = armedForTest;
  befores.clear();
  deps = defaultDeps;
}

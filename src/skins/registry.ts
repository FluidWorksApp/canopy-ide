// The skin roster. One entry per skin, in picker order.
//
// This array is the only place that knows a skin exists. settings.ts derives
// the Theme union and the THEMES list from it, terminalThemes.ts reads `term`,
// monaco-setup.ts reads `monaco`, SettingsDialog reads `preview` — none of them
// switch on an id any more, so a skin can't be half-added.
//
// Adding one is a directory entry and a line here:
//   1. src/skins/<id>.ts    — this shape
//   2. src/skins/<id>.css   — the `:root[data-theme="<id>"]` token block
//   3. an @import in src/skins/skins.css
//   4. the import + array slot below
// skins.test.ts fails on anything missing.
import type { SkinDef } from "./types";
import { defaultSkin } from "./default";
import { gotham } from "./gotham";
import { daylight } from "./daylight";
import { vitrine } from "./vitrine";
import { ember } from "./ember";
import { slate } from "./slate";
import { voidSkin } from "./void";
import { beacon } from "./beacon";
import { parchment } from "./parchment";
import { meridian } from "./meridian";
import { phosphor } from "./phosphor";
import { dusk } from "./dusk";
import { orchard } from "./orchard";
import { plum } from "./plum";
import { pixel } from "./pixel";

export const SKINS = [
  defaultSkin,
  gotham,
  daylight,
  vitrine,
  // Dark neutrals, three temperatures.
  ember,
  slate,
  voidSkin,
  // Built for contrast.
  beacon,
  // Light.
  parchment,
  meridian,
  // Terminal phosphors.
  phosphor,
  dusk,
  // Saturated editorial.
  orchard,
  plum,
  // The 8-bit skin, registered as a real skin rather than a mode.
  pixel,
] as const satisfies readonly SkinDef[];

/** Every id in the roster. Not `string` — settings.ts builds the Theme union
 *  out of this, so a typo in a persisted value fails to compile. */
export type SkinId = (typeof SKINS)[number]["id"];

const BY_ID = new Map<string, SkinDef>(SKINS.map((s) => [s.id, s]));

/** The roster entry for an id. Falls back to Default rather than throwing:
 *  a settings blob written by a newer build (or a skin removed between
 *  releases) should recolour the app, not break it. */
export function skinDef(id: string): SkinDef {
  return BY_ID.get(id) ?? defaultSkin;
}

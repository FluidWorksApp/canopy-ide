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
import { lattice } from "./lattice";

export const SKINS = [
  // Gotham is the base skin: its palette is the `:root` contract in index.css,
  // so it has no token block of its own and everything below overrides it.
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
  // The two whose identity is material as much as palette, registered as real
  // skins because those overrides need a selector to hang off.
  lattice,
  pixel,
] as const satisfies readonly SkinDef[];

/** Every id in the roster. Not `string` — settings.ts builds the Theme union
 *  out of this, so a typo in a persisted value fails to compile. */
export type SkinId = (typeof SKINS)[number]["id"];

const BY_ID = new Map<string, SkinDef>(SKINS.map((s) => [s.id, s]));

/** The roster entry for an id. Falls back to the base skin rather than
 *  throwing: a settings blob written by a newer build — or naming a skin that
 *  has since been removed, which is every install still storing the retired
 *  "default" — should recolour the app, not break it. That fallback is why
 *  retiring a skin needs no migration: the stored value simply stops matching
 *  and Gotham answers instead. */
export function skinDef(id: string): SkinDef {
  return BY_ID.get(id) ?? gotham;
}

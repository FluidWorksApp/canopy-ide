// Which mascot Canopy wears.
//
// Ash is the first, not the only one — so the split here is between the
// *vocabulary*, which is Canopy's, and the *drawing*, which is the mascot's.
// Every surface asks for a state ("this agent is blocked", "nothing has needed
// you") and never for a face; the registry decides what that looks like. Adding
// a second mascot is a new entry here, a `case` in Mascot.tsx, and nothing else
// — no call site names Ash.
//
// Everything that isn't SVG lives here, the same way ash.ts sits under Ash.tsx.

import { ashGlyph, type AshState } from "./ash";
import { getSettings } from "./settings";

/** The state vocabulary, named for what it is rather than for whoever draws it.
 *  Ash's eight states are the vocabulary today; a mascot that cannot express
 *  one of them is not a mascot Canopy can use, which is the point of pinning
 *  the type here rather than letting each define its own. */
export type MascotState = AshState;

export type MascotId = "ash";

export const DEFAULT_MASCOT: MascotId = "ash";

export interface MascotDef {
  id: MascotId;
  label: string;
  /** One line under the name in the picker. */
  note: string;
}

export const MASCOTS: MascotDef[] = [
  {
    id: "ash",
    label: "Ash",
    note: "The Canopy mark, read as a face",
  },
];

/** The chosen mascot, falling back to the default when the stored id names one
 *  that no longer exists — a build that drops a mascot must not leave anyone
 *  with a blank space where a face was. */
export function currentMascot(): MascotId {
  const id = getSettings().mascot;
  return MASCOTS.some((m) => m.id === id) ? id : DEFAULT_MASCOT;
}

export function mascotDef(id: MascotId = currentMascot()): MascotDef {
  return MASCOTS.find((m) => m.id === id) ?? MASCOTS[0];
}

/** The mascot where SVG can't go — a notification title, a log line, a window
 *  title. Dispatches like the component does, so a second mascot brings its own
 *  two-character forms rather than borrowing Ash's. */
export function mascotGlyph(
  state: MascotState,
  id: MascotId = currentMascot(),
): string {
  switch (id) {
    case "ash":
    default:
      return ashGlyph(state);
  }
}

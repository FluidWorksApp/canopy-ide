// The mascot, drawn — whichever one is chosen.
//
// Every surface renders <Mascot state=… /> and none of them names Ash. That
// indirection is the whole feature: the setting can only mean something if no
// call site has already decided the answer. Geometry, tones and the size ladder
// stay with each mascot (ash.ts); the vocabulary and the choice live in
// ../mascots.
import { useSyncExternalStore } from "react";
import { currentMascot, type MascotId, type MascotState } from "../mascots";
import { SETTINGS_CHANGE_EVENT } from "../settings";
import type { AshTone } from "../ash";
import { Ash } from "./Ash";

export interface MascotProps {
  state: MascotState;
  /** Rendered box in px. Drives each mascot's own size ladder. */
  size?: number;
  /** Overrides the state's own colour, for a lifecycle Canopy reads
   *  differently from the face (a lost agent wears `sleeping` in warn). */
  tone?: AshTone;
  /** The agent's own colour, when one is talking. Beats `tone`. */
  hue?: string;
  title?: string;
  className?: string;
  /** Render a specific mascot rather than the chosen one — for the picker,
   *  which has to show all of them at once. */
  as?: MascotId;
}

function subscribe(cb: () => void) {
  window.addEventListener(SETTINGS_CHANGE_EVENT, cb);
  return () => window.removeEventListener(SETTINGS_CHANGE_EVENT, cb);
}

/** Switching mascot repaints every face at once, with no reload — the picker
 *  shows a live preview, and a change you have to restart to see is a change
 *  you can't judge. `currentMascot` reads a cached, identity-stable settings
 *  object, so this is safe on a render path. */
export function Mascot({ as, ...props }: MascotProps) {
  const chosen = useSyncExternalStore(subscribe, currentMascot, () => "ash" as const);
  switch (as ?? chosen) {
    case "ash":
    default:
      return <Ash {...props} />;
  }
}

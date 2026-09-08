export type SessionNameTheme =
  | "canopy"
  | "galaxy"
  | "wizardry"
  | "android"
  | "apple"
  | "retro"
  | "tabletop"
  | "cyber";

export interface SessionNameThemeDef {
  id: SessionNameTheme;
  label: string;
  note: string;
  /** The first few names are a truthful preview of the native generator. */
  preview: readonly string[];
}

/** Callsign vocabularies for new terminal sessions. The complete lists live in
 * the native PTY manager, where every launch path (including Remote and
 * detached tasks) receives a name. These samples deliberately mirror the
 * opening entries so Settings can preview a choice without starting a shell. */
export const SESSION_NAME_THEMES: readonly SessionNameThemeDef[] = [
  {
    id: "canopy",
    label: "Canopy",
    note: "Quiet elemental callsigns",
    preview: ["Ember", "Juniper", "Lumen", "Moss"],
  },
  {
    id: "galaxy",
    label: "Far galaxy",
    note: "Pilots, droids and distant worlds",
    preview: ["Astro", "Bespin", "Comet", "Droid"],
  },
  {
    id: "wizardry",
    label: "Wizard school",
    note: "Spells, familiars and old libraries",
    preview: ["Auror", "Basilisk", "Charm", "Fawkes"],
  },
  {
    id: "android",
    label: "Android releases",
    note: "The dessert-code-name years",
    preview: ["Cupcake", "Donut", "Eclair", "Froyo"],
  },
  {
    id: "apple",
    label: "Apple releases",
    note: "Big cats and California landmarks",
    preview: ["Cheetah", "Puma", "Jaguar", "Panther"],
  },
  {
    id: "retro",
    label: "Retro computing",
    note: "Machines, languages and pioneers",
    preview: ["Ada", "Altair", "Amiga", "Atari"],
  },
  {
    id: "tabletop",
    label: "Tabletop party",
    note: "Classes, quests and critical rolls",
    preview: ["Bard", "Cleric", "Druid", "Mage"],
  },
  {
    id: "cyber",
    label: "Neon future",
    note: "Synths, circuits and midnight cities",
    preview: ["Arcade", "Chrome", "Cipher", "Glitch"],
  },
] as const;

const THEME_IDS = new Set(SESSION_NAME_THEMES.map((theme) => theme.id));

export function isSessionNameTheme(value: unknown): value is SessionNameTheme {
  return typeof value === "string" && THEME_IDS.has(value as SessionNameTheme);
}

export function sessionNameThemeDef(id: SessionNameTheme): SessionNameThemeDef {
  return SESSION_NAME_THEMES.find((theme) => theme.id === id) ?? SESSION_NAME_THEMES[0];
}

// The pure half of the lens migration, with no imports so settings.ts can use
// it without a module cycle (projectLens.ts reads settings). See projectLens.ts
// for why the stored names are kept.

export type ProjectLens = "builder" | "engineer";

/** What the `defaultProjectLens` setting is stored as. "build" is the v0.4.0
 *  spelling and stays the stored value for the builder lens. */
export type StoredDefaultLens = "build" | "engineer";

/** Every value the old mode setting has ever held (and the hand-edited or
 *  corrupt ones it might) mapped to a lens. Unknown values fall back to
 *  engineer: it hides nothing, so a bad value can never strand someone in a
 *  view without terminals. */
export function lensFromStoredDefault(value: unknown): ProjectLens {
  if (value === true) return "builder";
  if (typeof value !== "string") return "engineer";
  switch (value.trim().toLowerCase()) {
    case "build":
    case "builder":
    case "vibe":
      return "builder";
    default:
      return "engineer";
  }
}

export function storedDefaultFor(lens: ProjectLens): StoredDefaultLens {
  return lens === "builder" ? "build" : "engineer";
}

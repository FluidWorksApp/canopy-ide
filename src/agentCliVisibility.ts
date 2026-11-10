// Which built-in agent CLIs Settings lists. Nothing is shown by default except
// what the person has: a CLI that is installed, or one they gave a path for, or
// one they just added from the "Add" list. Everything else is one choice away.

export interface CliDef {
  id: string;
  bin: string;
}

export interface VisibilityInput {
  /** `which` results by resolved binary. Empty until the probe has answered. */
  found: Record<string, boolean>;
  /** Stored overrides by CLI id: a path the person typed. */
  overrides: Record<string, string>;
  /** Added by hand from the list this session. */
  revealed: ReadonlySet<string>;
  /** The binary Canopy will run for a CLI, with any override applied. */
  resolveBin: (def: CliDef) => string;
}

export function partitionBuiltins<T extends CliDef>(defs: T[], input: VisibilityInput): { shown: T[]; hidden: T[] } {
  const shown: T[] = [];
  const hidden: T[] = [];
  for (const def of defs) {
    const visible =
      input.found[input.resolveBin(def)] === true ||
      Boolean(input.overrides[def.id]) ||
      input.revealed.has(def.id);
    (visible ? shown : hidden).push(def);
  }
  return { shown, hidden };
}

/** The agents a launcher lists: those the install probe has not said are
 *  missing. An agent whose probe has not answered yet stays listed, because
 *  hiding on "unknown" would make an installed CLI vanish for a moment at
 *  startup. Missing ones are added back from Settings → Agents. */
export function listedForLaunch<T extends { bin: string }>(
  clis: readonly T[],
  installed: Record<string, boolean | undefined>,
): T[] {
  return clis.filter((cli) => installed[cli.bin] !== false);
}

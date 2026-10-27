// One project, two lenses. A project is the same folder, the same sessions
// and the same files whichever way you look at it; the lens only decides what
// is on screen. `builder` shows the preview, the plan, checkpoints with
// plain-language summaries and the diagnose-first repair flow. `engineer`
// shows terminals, diffs and the language server.
//
// Storage stays where v0.4.0 put the old Build/Engineer *mode*, on purpose:
// `Project.vibe.enabled` (per project) and the `defaultProjectLens` setting
// ("build" | "engineer"). Renaming either would orphan every saved project and
// every onboarding choice, and a downgrade would read the new key as "never
// chose". So the lens is a reading of those fields, and every read and write
// goes through this module — nothing else should look at `vibe.enabled` to
// decide what to render.
import type { Project, VibeConfig } from "./projects";
import { getSettings } from "./settings";
import { lensFromStoredDefault, type ProjectLens } from "./lensMigration";

export {
  lensFromStoredDefault,
  storedDefaultFor,
  type ProjectLens,
  type StoredDefaultLens,
} from "./lensMigration";

/** The lens this project shows. A project that has never chosen (no `vibe`)
 *  takes `fallback` — the onboarding default — exactly as adoptDefaultProjectLens
 *  would on load. */
export function projectLens(
  project: Pick<Project, "vibe"> | null | undefined,
  fallback: ProjectLens = "engineer",
): ProjectLens {
  const vibe = project?.vibe as { enabled?: unknown } | undefined;
  if (!vibe) return fallback;
  return vibe.enabled === true ? "builder" : "engineer";
}

/** The initial `vibe` block for a new project under `lens`. */
export function initialLensConfig(lens: ProjectLens): VibeConfig {
  return { version: 1, enabled: lens === "builder" };
}

/** Switch a project's lens. Only the one stored bit changes: components,
 *  discovery, required processes, data stores, integrations and every other
 *  field stay exactly as they were, which is what makes a project built in one
 *  lens openable in the other with nothing lost. Returns the same object when
 *  the lens is already `lens`, so callers can skip a save. */
export function withProjectLens<P extends Pick<Project, "vibe">>(project: P, lens: ProjectLens): P {
  if (project.vibe && projectLens(project) === lens) return project;
  return {
    ...project,
    vibe: project.vibe
      ? { ...project.vibe, enabled: lens === "builder" }
      : initialLensConfig(lens),
  };
}

export function otherLens(lens: ProjectLens): ProjectLens {
  return lens === "builder" ? "engineer" : "builder";
}

export function toggleProjectLens<P extends Pick<Project, "vibe">>(project: P): P {
  return withProjectLens(project, otherLens(projectLens(project)));
}

/** Person-facing name, used by the title-bar switch and notices. */
export function lensLabel(lens: ProjectLens): string {
  return lens === "builder" ? "Builder" : "Engineer";
}

/** The lens a brand-new (or never-switched) project opens in: the onboarding
 *  choice, read through the migration above. */
export function defaultLens(): ProjectLens {
  return lensFromStoredDefault(getSettings().defaultProjectLens);
}

/** The folder the builder lens works in: Build's configured component, else
 *  the project's first. The engineer lens sees the very same folder. */
export function builderRoot(project: Pick<Project, "components" | "vibe">): string | null {
  const id = project.vibe?.componentId;
  return (project.components.find((c) => c.id === id) ?? project.components[0])?.path ?? null;
}

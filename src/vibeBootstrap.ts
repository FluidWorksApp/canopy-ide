import * as ipc from "./ipc";
import type { Component } from "./projects";

/** A scaffold must never be inferred over an existing application's files. */
export async function emptyBuildProject(components: readonly Component[]): Promise<boolean> {
  if (!components.length || components.some((component) => component.commands?.length)) return false;
  const entries = await Promise.all(components.map((component) => ipc.fsReadDir(component.path)));
  return entries.every((directory) => directory.every((entry) =>
    /^(?:\.git|\.canopy|\.DS_Store|\.gitignore|AGENTS\.md|README(?:\.[\w-]+)?|LICENSE(?:\.[\w-]+)?)$/i.test(entry.name),
  ));
}

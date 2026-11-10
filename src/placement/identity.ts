// Which project is "the same project" on two machines.
//
// Project ids are minted per machine, so the Mac's "Canopy" and the workspace's
// copy of it have different ids. The mirror (src/remoteExecution/mirror.ts)
// records the link on the workspace copy as `mirroredFrom`: the id of the
// project on the Mac it was made from. That link, never the display name, is
// what says two projects are one. A copy still being set up (`mirrorIncomplete`)
// does not count: it is not usable yet.
//
// Placement and teleport both ask this question, so the answer lives in one place.

export interface ProjectLike {
  id: string;
  name: string;
  /** Set on a workspace copy: the id of the project on the Mac it was mirrored from. */
  mirroredFrom?: string;
  /** The mirror stopped partway; the copy is not complete. */
  mirrorIncomplete?: boolean;
  /** Links to the same project on OTHER machines, by machine and id. This is
   *  what lets a project that began on a workspace be recognised on the Mac
   *  after it was brought back: `mirroredFrom` alone only says "made from the
   *  Mac's project", which a workspace-born project never had. */
  linkedTo?: { env: string; id: string }[];
}

/** The id a project goes by for identity: the Mac's id for a complete mirror,
 *  else its own. */
export function canonicalProjectId(project: ProjectLike): string {
  return project.mirroredFrom && !project.mirrorIncomplete ? project.mirroredFrom : project.id;
}

/** The projects of the machine being read, under their canonical ids. Only a
 *  workspace's store carries `mirroredFrom`, so reading this Mac's own store
 *  leaves every id as it is. Several copies mapping to one id keep the first. */
export function canonicalProjects<T extends ProjectLike>(projects: readonly T[]): { id: string; name: string }[] {
  const seen = new Set<string>();
  const out: { id: string; name: string }[] = [];
  for (const project of projects) {
    const id = canonicalProjectId(project);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name: project.name });
  }
  return out;
}

/** The project on this machine that a project on another machine corresponds
 *  to, or undefined. A mirrored copy points at its source; a source is found by
 *  the copy's `mirroredFrom`. Never by name. */
export function counterpartOf<T extends ProjectLike>(
  project: ProjectLike,
  others: readonly T[],
  /** The machine `others` belong to, when known: a `linkedTo` entry only counts for that machine. */
  otherEnv?: string,
): T | undefined {
  const canonical = canonicalProjectId(project);
  return others.find((other) => {
    if (other === project) return false;
    if (canonicalProjectId(other) === canonical) return true;
    // An explicit link, in either direction.
    const forward = project.linkedTo?.some((l) => l.id === other.id && (!otherEnv || l.env === otherEnv));
    const backward = other.linkedTo?.some((l) => l.id === project.id);
    return Boolean(forward || backward);
  });
}

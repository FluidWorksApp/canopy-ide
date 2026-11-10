// Where an agent started on another machine runs: that machine's copy of the
// project, found by identity, never by name (placement/identity.ts).
import { counterpartOf } from "../placement/identity";

interface StoreComponent {
  id: string;
  label: string;
  path: string;
}
interface StoreProject {
  id: string;
  name: string;
  components: StoreComponent[];
  mirroredFrom?: string;
  mirrorIncomplete?: boolean;
  linkedTo?: { env: string; id: string }[];
}

export type RemoteComponent =
  | { kind: "found"; projectId: string; componentId: string; path: string }
  /** The machine has no complete copy of the project: it has to be set up first. */
  | { kind: "not-set-up" };

/** The copy of `project`'s component `label` on the machine whose store `load`
 *  reads. `load` returns the store's JSON text (`store_load`). */
export async function remoteComponentFor(
  load: () => Promise<string>,
  machineEnv: string,
  project: { id: string; name: string; mirroredFrom?: string; mirrorIncomplete?: boolean; linkedTo?: { env: string; id: string }[] },
  component: { label: string } | undefined,
): Promise<RemoteComponent> {
  const store = JSON.parse(await load()) as { projects?: StoreProject[] } | null;
  const copy = counterpartOf(
    project,
    (store?.projects ?? []).filter((p) => !p.mirrorIncomplete),
    machineEnv,
  );
  if (!copy) return { kind: "not-set-up" };
  const match =
    (component && copy.components.find((c) => c.label === component.label)) ?? copy.components[0];
  if (!match) return { kind: "not-set-up" };
  return { kind: "found", projectId: copy.id, componentId: match.id, path: match.path };
}

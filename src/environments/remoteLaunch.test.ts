import { expect, it } from "vitest";
import { remoteComponentFor } from "./remoteLaunch";

const store = (projects: unknown[]) => async () => JSON.stringify({ projects });

it("finds the machine's copy by identity, never by name", async () => {
  const result = await remoteComponentFor(
    store([
      { id: "w1", name: "Canopy", mirroredFrom: "mac-1", components: [{ id: "c1", label: "site", path: "/workspace/repo-2" }, { id: "c2", label: "app", path: "/workspace/repo-1" }] },
      { id: "w2", name: "Canopy", components: [{ id: "c9", label: "app", path: "/workspace/other" }] },
    ]),
    "remote:ws",
    { id: "mac-1", name: "Canopy" },
    { label: "app" },
  );
  expect(result).toEqual({ kind: "found", projectId: "w1", componentId: "c2", path: "/workspace/repo-1" });
});

it("is not set up when there is no complete copy, even if a name matches", async () => {
  expect(
    await remoteComponentFor(
      store([{ id: "w1", name: "Canopy", mirroredFrom: "mac-1", mirrorIncomplete: true, components: [{ id: "c", label: "app", path: "/workspace/x" }] }]),
      "remote:ws",
      { id: "mac-1", name: "Canopy" },
      { label: "app" },
    ),
  ).toEqual({ kind: "not-set-up" });
  expect(await remoteComponentFor(store([{ id: "z", name: "Canopy", components: [] }]), "remote:ws", { id: "mac-1", name: "Canopy" }, undefined)).toEqual({ kind: "not-set-up" });
});

it("falls back to the copy's first component when the label has no match", async () => {
  const result = await remoteComponentFor(
    store([{ id: "w1", name: "C", mirroredFrom: "mac-1", components: [{ id: "c1", label: "only", path: "/workspace/only" }] }]),
    "remote:ws",
    { id: "mac-1", name: "C" },
    { label: "gone" },
  );
  expect(result).toMatchObject({ kind: "found", path: "/workspace/only" });
});

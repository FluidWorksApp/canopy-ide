/** `collabTick` rides the relay handle, which is threaded into every
 *  ProjectView — so bumping it re-renders every open project, including the
 *  ones behind `display: none`. The relay channel is overwhelmingly keystrokes,
 *  and App used to bump per frame: a remote collaborator typing re-rendered the
 *  whole workspace eight to fifteen times a second.
 *
 *  `structure()` is what makes the bump conditional. These pin the property the
 *  fix depends on: it moves for the frames a consumer can observe, and stays
 *  put for the ones it cannot. */

import { describe, expect, it, vi } from "vitest";

// collab.ts pulls in monaco-setup, which imports the editor API's CSS —
// unresolvable under the test transform. Nothing here touches a model or an
// editor; `structure()` reads only the manager's own maps.
vi.mock("./monaco-setup", () => ({
  monaco: {
    editor: { getModel: () => null, createModel: () => null },
    Uri: { file: (p: string) => ({ path: p }) },
  },
}));

import { CollabManager, type CollabMsg } from "./collab";

const msg = (over: Partial<CollabMsg> & { body: CollabMsg["body"] }): CollabMsg =>
  ({
    doc: "d1",
    from: "peer-1",
    from_name: "Ada",
    ...over,
  }) as CollabMsg;

describe("what a collab frame changes", () => {
  it("a project offer moves the structure", () => {
    const mgr = new CollabManager();
    const before = mgr.structure();
    mgr.receive(
      msg({ body: { kind: "project-offer", name: "canopy" } as CollabMsg["body"] }),
    );
    expect(mgr.structure()).not.toBe(before);
  });

  it("joining a project moves the structure", () => {
    const mgr = new CollabManager();
    mgr.receive(
      msg({ body: { kind: "project-offer", name: "canopy" } as CollabMsg["body"] }),
    );
    const offered = mgr.structure();
    mgr.receive(
      msg({
        body: { kind: "project-tree", paths: ["a.ts"] } as CollabMsg["body"],
      }),
    );
    // The offer became a join: both the offer set and the joined set moved.
    expect(mgr.structure()).not.toBe(offered);
    expect(mgr.joinedProjects.has("d1")).toBe(true);
  });

  it("a frame for a document nobody shares leaves the structure alone", () => {
    // The keystroke case. An edit frame carries no structural news, and this is
    // the whole reason the tick can be conditional.
    const mgr = new CollabManager();
    const before = mgr.structure();
    mgr.receive(
      msg({
        doc: "unknown-doc",
        body: { kind: "edit", rev: 1, ops: [] } as unknown as CollabMsg["body"],
      }),
    );
    expect(mgr.structure()).toBe(before);
  });

  it("is stable across repeated reads", () => {
    const mgr = new CollabManager();
    mgr.receive(
      msg({ body: { kind: "project-offer", name: "canopy" } as CollabMsg["body"] }),
    );
    expect(mgr.structure()).toBe(mgr.structure());
  });
});

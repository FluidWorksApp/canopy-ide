import { beforeEach, describe, expect, it } from "vitest";
import {
  builderRoot,
  defaultLens,
  lensFromStoredDefault,
  projectLens,
  storedDefaultFor,
  toggleProjectLens,
  withProjectLens,
} from "./projectLens";
import { adoptDefaultProjectLens, type Project } from "./projects";
import { getSettings } from "./settings";

const store = (settings: Record<string, unknown>) =>
  localStorage.setItem("canopy.settings", JSON.stringify(settings));

beforeEach(() => localStorage.clear());

describe("lens migration from the old Build/Engineer mode setting", () => {
  it.each([
    ["build", "builder"],
    ["Build", "builder"],
    [" builder ", "builder"],
    ["vibe", "builder"],
    [true, "builder"],
    ["engineer", "engineer"],
    ["ENGINEER", "engineer"],
    [false, "engineer"],
    [undefined, "engineer"],
    [null, "engineer"],
    ["", "engineer"],
    ["garbage", "engineer"],
    [42, "engineer"],
    [{}, "engineer"],
  ])("reads %j as the %s lens", (stored, lens) => {
    expect(lensFromStoredDefault(stored)).toBe(lens);
  });

  it("keeps the stored setting name and its v0.4.0 spelling", () => {
    expect(storedDefaultFor("builder")).toBe("build");
    expect(storedDefaultFor("engineer")).toBe("engineer");
  });

  it.each([
    ["build", "build"],
    ["builder", "build"],
    [true, "build"],
    ["engineer", "engineer"],
    ["nonsense", "engineer"],
    [7, "engineer"],
  ])("normalises a stored defaultProjectLens of %j to %j", (stored, expected) => {
    store({ defaultProjectLens: stored });
    expect(getSettings().defaultProjectLens).toBe(expected);
  });

  it("defaults to the engineer lens when nothing was ever chosen", () => {
    expect(getSettings().defaultProjectLens).toBe("engineer");
    expect(defaultLens()).toBe("engineer");
    store({ defaultProjectLens: "build" });
    expect(defaultLens()).toBe("builder");
  });
});

const fullProject = (): Project => ({
  id: "p1",
  name: "Shop",
  components: [
    { id: "c1", label: "web", path: "/repo/web", commands: [{ id: "dev", name: "dev", command: "npm run dev" } as never] },
    { id: "c2", label: "api", path: "/repo/api" },
  ],
  shareContext: true,
  customTasks: [],
  vibe: {
    version: 1,
    enabled: true,
    componentId: "c2",
    runCommandId: "dev",
    setupRevision: "rev-1",
    requiredProcesses: [{ componentId: "c2", runCommandId: "dev" }],
    componentLinks: [],
    dataStores: [],
    externalServices: [],
  },
  integrations: { version: 1 } as never,
});

describe("one project, two lenses", () => {
  it("reads the lens from the stored per-project bit", () => {
    expect(projectLens(fullProject())).toBe("builder");
    expect(projectLens({ vibe: { version: 1, enabled: false } })).toBe("engineer");
    expect(projectLens({})).toBe("engineer");
    expect(projectLens(undefined)).toBe("engineer");
    expect(projectLens({}, "builder")).toBe("builder");
  });

  it("switching changes only the lens — components, setup and integrations survive", () => {
    const before = fullProject();
    const engineer = withProjectLens(before, "engineer");
    expect(projectLens(engineer)).toBe("engineer");
    const { vibe: vb, ...restBefore } = before;
    const { vibe: ve, ...restAfter } = engineer;
    expect(restAfter).toEqual(restBefore);
    expect({ ...ve, enabled: true }).toEqual(vb);
    // And back again: identical to where it started.
    expect(toggleProjectLens(engineer)).toEqual(before);
  });

  it("is a no-op (same object) when the project already shows that lens", () => {
    const p = fullProject();
    expect(withProjectLens(p, "builder")).toBe(p);
  });

  it("gives a project that never chose a lens its own block", () => {
    const p = { id: "x", name: "x", components: [] } as Project;
    expect(withProjectLens(p, "builder").vibe).toEqual({ version: 1, enabled: true });
    expect(toggleProjectLens(p).vibe).toEqual({ version: 1, enabled: true });
  });

  it("adopts the onboarding default once, through the migration", () => {
    store({ defaultProjectLens: "builder" });
    const adopted = adoptDefaultProjectLens({ id: "x", name: "x", components: [] });
    expect(projectLens(adopted)).toBe("builder");
    // A project that already chose keeps its choice whatever the default says.
    expect(adoptDefaultProjectLens(withProjectLens(fullProject(), "engineer")).vibe?.enabled).toBe(false);
  });

  it("works in the same folder either way", () => {
    const p = fullProject();
    expect(builderRoot(p)).toBe("/repo/api");
    expect(builderRoot(withProjectLens(p, "engineer"))).toBe("/repo/api");
    expect(builderRoot({ components: [{ id: "a", label: "a", path: "/a" }] })).toBe("/a");
    expect(builderRoot({ components: [] })).toBeNull();
  });
});

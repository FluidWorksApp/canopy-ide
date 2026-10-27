import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./ledger", async () => (await import("./test/fakeLedger")).fakeLedger);

import { fakeLedger } from "./test/fakeLedger";
import { registerRulesEditor } from "./gates/events";
import type { askBrain } from "./brainCall";
import {
  cachedLayerMap,
  claimLayer,
  ensureLayerMap,
  expandGlob,
  globToRegExp,
  layerMapPrompt,
  layerOwners,
  matchesAnyGlob,
  ownedLayerHits,
  ownershipNotice,
  ownsLayer,
  releaseLayer,
  resetLensLayersForTests,
  saveLayerGlobs,
  teamRulesAvailable,
  validateLayerMap,
} from "./lensLayers";

const RAW = {
  data: { summary: "Keeps orders and customers.", files: ["prisma/schema.prisma", "prisma/schema.prisma"] },
  logic: { summary: "Handles checkout.", files: ["src/api/checkout.ts"] },
  view: { summary: "The shop pages.", files: ["src/pages/index.tsx"] },
  globs: { data: ["prisma/**"], auth: ["src/auth/**", "middleware.ts"], deploy: ["Dockerfile", ".github/**"], integration: [] },
};

type Ask = typeof askBrain & ReturnType<typeof vi.fn>;
const brain = (raw: unknown) =>
  vi.fn(async (req: { validate?: (v: unknown) => unknown }) => {
    const value = req.validate ? req.validate(raw) : raw;
    return value == null
      ? { ok: false, reason: "invalid-output", message: "junk" }
      : { ok: true, text: "", value, costUsd: 0, inputTokens: 0, outputTokens: 0, durationMs: 1, model: null };
  }) as unknown as Ask;

beforeEach(() => {
  fakeLedger.reset();
  resetLensLayersForTests();
  vi.clearAllMocks();
  localStorage.clear();
});

describe("glob matching", () => {
  it.each([
    ["src/auth/**", "src/auth/login.ts", true],
    ["src/auth/**", "src/auth/deep/a/b.ts", true],
    ["src/auth/**", "src/authority.ts", false],
    ["src/auth/", "src/auth/x.ts", true],
    ["**/*.sql", "db/migrations/001.sql", true],
    ["**/*.sql", "001.sql", true],
    ["*.sql", "db/001.sql", true],
    ["middleware.ts", "middleware.ts", true],
    ["middleware.ts", "src/middleware.ts", true],
    ["src/*.ts", "src/a/b.ts", false],
    ["src/?.ts", "src/a.ts", true],
    ["./prisma/**", "prisma/schema.prisma", true],
    [".env", "config/.env", true],
  ])("%s matches %s → %s", (glob, path, expected) => {
    expect(globToRegExp(glob).test(path)).toBe(expected);
  });

  it("ignores blank patterns and normalises separators", () => {
    expect(matchesAnyGlob("src\\auth\\x.ts", ["", "src/auth/**"])).toBe(true);
    expect(matchesAnyGlob("src/x.ts", ["  "])).toBe(false);
  });
});

describe("layer map", () => {
  it("prompt asks for data/logic/view in plain words and globs for the ownable layers", () => {
    const p = layerMapPrompt("Shop");
    expect(p).toContain("Shop");
    expect(p).toMatch(/non-engineer/);
    for (const k of ["data", "logic", "view", "auth", "deploy", "integration"]) expect(p).toContain(k);
  });

  it("validates and de-duplicates", () => {
    const m = validateLayerMap(RAW)!;
    expect(m.areas.data.files).toEqual(["prisma/schema.prisma"]);
    expect(m.globs.auth).toEqual(["src/auth/**", "middleware.ts"]);
    expect(m.globs.integration).toEqual([]);
    expect(validateLayerMap({ ...RAW, view: { files: [] } })).toBeNull();
    expect(validateLayerMap({ data: RAW.data, logic: RAW.logic, view: RAW.view })!.globs.data).toEqual([]);
  });

  it("is made once on the background tier, cached in the ledger, refreshed on request", async () => {
    const ask = brain(RAW);
    const first = await ensureLayerMap("/repo", "Shop", {}, { ask });
    expect(first).toMatchObject({ ok: true, cached: false });
    expect(ask.mock.calls[0][0]).toMatchObject({ feature: "lens", tier: "background", json: true });
    expect(fakeLedger.rows[0]).toMatchObject({ kind: "memory", ref: { kind: "lens-layers", id: "project" } });

    expect(await ensureLayerMap("/repo", "Shop", {}, { ask })).toMatchObject({ ok: true, cached: true });
    expect(ask).toHaveBeenCalledTimes(1);

    // A fresh process: the ledger answers.
    resetLensLayersForTests();
    expect((await cachedLayerMap("/repo"))?.areas.logic.summary).toBe("Handles checkout.");

    await ensureLayerMap("/repo", "Shop", { refresh: true, tier: "main" }, { ask });
    expect(ask).toHaveBeenCalledTimes(2);
    expect(ask.mock.calls[1][0].tier).toBe("main");
  });

  it("keeps patterns the person edited across a refresh", async () => {
    await ensureLayerMap("/repo", "Shop", {}, { ask: brain(RAW) });
    await saveLayerGlobs("/repo", "auth", ["lib/session/**"]);
    const refreshed = await ensureLayerMap("/repo", "Shop", { refresh: true }, { ask: brain({ ...RAW, globs: { ...RAW.globs, auth: ["other/**"] } }) });
    expect(refreshed.ok && refreshed.map.globs.auth).toEqual(["lib/session/**"]);
  });

  it("degrades to a message when there is no brain", async () => {
    const none = vi.fn(async () => ({ ok: false, reason: "no-brain", message: "Connect an agent first" })) as never;
    expect(await ensureLayerMap("/repo", "Shop", {}, { ask: none })).toEqual({ ok: false, message: "Connect an agent first" });
  });
});

const id = (name: string) => ({ id: `u-${name.toLowerCase()}`, name, email: `${name.toLowerCase()}@example.test` });

describe("layer ownership", () => {
  const globs = validateLayerMap(RAW)!.globs;

  it("claims are rule entries under a team identity; the newest live claim wins and released ones drop out", async () => {
    const sam = await claimLayer("/repo", "auth", id("Sam"));
    expect(sam).toMatchObject({
      kind: "rule",
      scope: "team",
      ref: { kind: "lens-layer", id: "auth" },
      data: { type: "layer-owner", owner: "Sam", ownerId: "u-sam" },
    });
    await claimLayer("/repo", "data", id("Ana"));
    expect(Object.keys(await layerOwners("/repo")).sort()).toEqual(["auth", "data"]);
    await releaseLayer("/repo", sam);
    const owners = await layerOwners("/repo");
    expect(owners.auth).toBeUndefined();
    expect(owners.data?.data.owner).toBe("Ana");
  });

  it("ignores rule entries other features wrote", async () => {
    await fakeLedger.appendLedger("/repo", { kind: "rule", ref: { kind: "lens-layer", id: "auth" }, data: { type: "gate", text: "no force push" } });
    expect(await layerOwners("/repo")).toEqual({});
  });

  it("matches a builder change to the owned layer and names the owner", async () => {
    await claimLayer("/repo", "auth", id("Sam"));
    const owners = await layerOwners("/repo");
    const hits = ownedLayerHits("/repo", ["/repo/src/auth/login.ts", "src/pages/index.tsx", "middleware.ts"], globs, owners, id("Alex"));
    expect(hits).toEqual([{ layer: "auth", owner: "Sam", ownerId: "u-sam", files: ["src/auth/login.ts", "middleware.ts"] }]);
    expect(ownershipNotice(hits[0])).toBe("Sign-in & accounts is owned by Sam — changes to it wait for their approval.");
  });

  it("knows the owner by account id, not by a matching name", async () => {
    await claimLayer("/repo", "auth", id("Sam"));
    const owners = await layerOwners("/repo");
    // Same display name, different account: still someone else's layer.
    expect(ownedLayerHits("/repo", ["src/auth/x.ts"], globs, owners, { id: "u-other", name: "Sam", email: "s@x.test" })).toHaveLength(1);
    expect(ownedLayerHits("/repo", ["src/auth/x.ts"], globs, owners, id("Sam"))).toEqual([]);
    expect(ownsLayer(id("Sam"), owners.auth)).toBe(true);
  });

  it("falls back to the name for claims made before ownership had an id", async () => {
    await fakeLedger.appendLedger("/repo", {
      kind: "rule",
      ref: { kind: "lens-layer", id: "auth" },
      data: { type: "layer-owner", layer: "auth", owner: "Sam" },
    });
    const owners = await layerOwners("/repo");
    expect(ownsLayer({ id: "u-x", name: "sam", email: "sam@x.test" }, owners.auth)).toBe(true);
    expect(ownedLayerHits("/repo", ["src/auth/x.ts"], globs, owners, id("Alex"))[0].ownerId).toBeNull();
  });

  it("does not ask owners to approve their own change, nor match unowned layers", async () => {
    await claimLayer("/repo", "auth", id("Sam"));
    const owners = await layerOwners("/repo");
    expect(ownedLayerHits("/repo", ["prisma/schema.prisma"], globs, owners, null)).toEqual([]);
    expect(ownedLayerHits("/repo", ["src/auth/x.ts"], { ...globs, auth: [] }, owners, null)).toEqual([]);
  });
});

describe("globs read the way the hook reads them", () => {
  it("expands like gates.rs expand_glob", () => {
    expect(expandGlob("migrations")).toEqual(["**/migrations", "**/migrations/**"]);
    expect(expandGlob("src/db/")).toEqual(["src/db/**"]);
    expect(expandGlob("db/")).toEqual(["**/db/**"]);
    expect(expandGlob("*.sql")).toEqual(["**/*.sql"]);
    expect(expandGlob("./prisma/schema.prisma")).toEqual(["prisma/schema.prisma", "prisma/schema.prisma/**"]);
    expect(expandGlob("src/auth/**")).toEqual(["src/auth/**"]);
  });

  it("a bare folder name covers what is inside it, anywhere", () => {
    expect(matchesAnyGlob("db/migrations/0001.sql", ["migrations"])).toBe(true);
    expect(matchesAnyGlob("src/migrations.ts", ["migrations"])).toBe(false);
  });
});

describe("team rules detection", () => {
  it("is on only while a project view with the Rules panel holds the path", () => {
    expect(teamRulesAvailable("/repo")).toBe(false);
    const off = registerRulesEditor(() => ["/repo"]);
    expect(teamRulesAvailable("/repo")).toBe(true);
    expect(teamRulesAvailable("/repo/web")).toBe(true);
    expect(teamRulesAvailable("/repository")).toBe(false);
    off();
    expect(teamRulesAvailable("/repo")).toBe(false);
  });
});

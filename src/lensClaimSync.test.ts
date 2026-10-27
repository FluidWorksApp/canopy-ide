import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./ledger", async () => (await import("./test/fakeLedger")).fakeLedger);
vi.mock("./ipc", () => ({}));

import { fakeLedger } from "./test/fakeLedger";
import { applyLayerEvent, announceOwnClaims, setClaimSyncDepsForTests, shareLayerClaim } from "./lensClaimSync";
import { claimLayer, layerOwners, resetLensLayersForTests } from "./lensLayers";
import { parseEvent } from "./teamMessaging/chatEvents";
import { layerText, parseLayerEvent, type LayerEvent } from "./teamMessaging/layerEvents";
import type { TeamLayerEvent } from "./teamMessaging/session";

const CLAIM = "11111111-1111-4111-8111-111111111111";
const repo = { host: "github.com", slug: "acme/shop" };
const sam = { id: "u-sam", name: "Sam", email: "sam@example.test" };
const alex = { id: "u-alex", name: "Alex", email: "alex@example.test" };

const event = (over: Partial<LayerEvent> = {}): LayerEvent => ({
  type: "layer",
  target: CLAIM,
  op: "claim",
  layer: "data",
  repo,
  owner: "Sam",
  at: 1,
  ...over,
});
const incoming = (over: Partial<TeamLayerEvent> = {}, ev: Partial<LayerEvent> = {}): TeamLayerEvent => ({
  team: "t1",
  user: "u-alex",
  sender: "u-sam",
  senderName: "Sam K.",
  member: true,
  event: event(ev),
  ...over,
});

const republish = vi.fn(async (_root: string) => {});
const sent: unknown[] = [];

beforeEach(() => {
  fakeLedger.reset();
  resetLensLayersForTests();
  republish.mockClear();
  sent.length = 0;
  setClaimSyncDepsForTests({
    roots: () => ["/shop", "/blog"],
    remoteUrl: async (root) => (root === "/shop" ? "git@github.com:acme/shop.git" : "https://github.com/acme/blog"),
    me: async () => alex,
    sessions: () => [{ user: "u-alex", sendLayer: async (e) => (sent.push(e), 2) }],
    republish,
    now: () => 50,
  });
});

describe("layer events on the wire", () => {
  it("round-trip and reject what a modified client might send", () => {
    expect(parseEvent(JSON.parse(JSON.stringify(event())))).toEqual(event());
    expect(parseLayerEvent({ ...event(), ownerId: "u-mallory" })).toBeUndefined();
    expect(parseLayerEvent({ ...event(), layer: "view" })).toBeUndefined();
    expect(parseLayerEvent({ ...event(), target: "x" })).toBeUndefined();
    expect(parseLayerEvent({ ...event(), repo: { host: "github.com", slug: "../x" } })).toBeUndefined();
    expect(parseLayerEvent({ ...event(), owner: "Sam‮" })).toBeUndefined();
    expect(layerText(event())).toBe("Sam now owns Data in acme/shop: agents' changes to it need their approval.");
  });
});

describe("a teammate's claim, applied here", () => {
  it("goes into the ledger of every checkout of that repository under the sender's identity, and the policy is republished", async () => {
    expect(await applyLayerEvent(incoming())).toEqual(["/shop"]);
    const owners = await layerOwners("/shop");
    expect(owners.data?.data).toEqual({ type: "layer-owner", layer: "data", owner: "Sam K.", ownerId: "u-sam", claimId: CLAIM });
    expect(republish).toHaveBeenCalledWith("/shop");
    // Applying it again (a re-announcement) changes nothing.
    expect(await applyLayerEvent(incoming())).toEqual([]);
  });

  it("is ignored from someone the team's directory doesn't list", async () => {
    expect(await applyLayerEvent(incoming({ member: false }))).toEqual([]);
    expect(await layerOwners("/shop")).toEqual({});
  });

  it("doesn't take over a layer someone else owns here", async () => {
    await claimLayer("/shop", "data", alex);
    expect(await applyLayerEvent(incoming())).toEqual([]);
    expect((await layerOwners("/shop")).data?.data.ownerId).toBe("u-alex");
  });

  it("a release is honoured only from the owner", async () => {
    await applyLayerEvent(incoming());
    expect(await applyLayerEvent(incoming({ sender: "u-mallory" }, { op: "release" }))).toEqual([]);
    expect((await layerOwners("/shop")).data).toBeDefined();
    expect(await applyLayerEvent(incoming({}, { op: "release" }))).toEqual(["/shop"]);
    expect((await layerOwners("/shop")).data).toBeUndefined();
  });
});

describe("telling the team", () => {
  it("shares a claim with the repository named by its origin, and re-announces own claims", async () => {
    const mine = await claimLayer("/shop", "auth", alex);
    expect(await shareLayerClaim("/shop", "claim", mine)).toBe(2);
    expect(sent[0]).toMatchObject({ op: "claim", layer: "auth", repo, owner: "Alex", target: mine.data.claimId });
    // Someone else's claim is never announced as ours.
    await claimLayer("/shop", "data", sam);
    setClaimSyncDepsForTests({ roots: () => ["/shop"] });
    sent.length = 0;
    expect(await announceOwnClaims()).toBe(2);
    expect(sent).toHaveLength(1);
  });

  it("names no repository it can't: no origin, nothing sent", async () => {
    setClaimSyncDepsForTests({ remoteUrl: async () => "" });
    const mine = await claimLayer("/shop", "auth", alex);
    expect(await shareLayerClaim("/shop", "claim", mine)).toBe(0);
    expect(sent).toHaveLength(0);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./ledger", async () => (await import("./test/fakeLedger")).fakeLedger);
const gatesPolicyWrite = vi.fn(async (..._a: unknown[]) => "/home/.canopy/policy/x.json");
vi.mock("./ipc", () => ({ gatesPolicyWrite: (...a: unknown[]) => gatesPolicyWrite(...a) }));
const attention: unknown[] = [];
vi.mock("./attention", () => ({ postAttention: (i: unknown) => (attention.push(i), "a1") }));
const shared: unknown[] = [];
vi.mock("./shareCards", async (orig) => ({
  ...(await orig<typeof import("./shareCards")>()),
  openShareDialog: (r: unknown) => shared.push(r),
  repoRefFor: async () => ({ host: "github.com", slug: "acme/shop" }),
}));

import { fakeLedger } from "./test/fakeLedger";
import { setTeamIdentityFetchForTests } from "./teamIdentity";
import { claimLayer, resetLensLayersForTests, saveLayerGlobs, layerOwners, type LayerOwners } from "./lensLayers";
import { APPROVAL_TTL_MS, approvedFiles, currentLayerGates, layerGates, layerOfGateId, type LayerApprovalData } from "./lensGates";
import { answerFrom, applyLayerApprovalAnswer, approvalSummary, requestLayerApproval, resetLensApprovalsForTests } from "./lensApprovals";
import { parseCard } from "./teamMessaging/cardSchema";
import { buildPolicy, publishPolicy } from "./gates/rules";

const sam = { id: "u-sam", name: "Sam", email: "sam@example.test" };
const alex = { id: "u-alex", name: "Alex", email: "alex@example.test" };
const MAP = { globs: { data: ["prisma/**"], auth: ["src/auth/**"], deploy: [], integration: [] } };

async function owners(): Promise<LayerOwners> {
  await claimLayer("/repo", "data", sam);
  return layerOwners("/repo");
}

const approval = (over: Partial<LayerApprovalData> = {}): LayerApprovalData => ({
  type: "layer-approval",
  approvalId: "la-abc123",
  layer: "data",
  owner: "Sam",
  ownerId: "u-sam",
  files: ["prisma/schema.prisma"],
  summary: "add a column",
  status: "approved",
  requestedAt: 1000,
  decidedAt: 2000,
  ...over,
});

beforeEach(() => {
  fakeLedger.reset();
  resetLensLayersForTests();
  resetLensApprovalsForTests();
  gatesPolicyWrite.mockClear();
  attention.length = 0;
  shared.length = 0;
  setTeamIdentityFetchForTests(async () => ({ user: alex }));
});

describe("owned layers compile into gates", () => {
  it("a layer someone else owns denies writes to its patterns", async () => {
    const gates = layerGates(MAP, await owners(), [], alex, 5000);
    expect(gates).toEqual([
      {
        id: "lens-layer:data",
        rule: expect.stringContaining("Data is owned by Sam"),
        scope: "team",
        gate: { type: "deny-path-write", globs: ["prisma/**"] },
        exceptMembers: ["u-sam"],
      },
    ]);
    expect(layerOfGateId(gates[0].id)).toBe("data");
    expect(layerOfGateId("some-rule")).toBeNull();
  });

  it("exempts the owner's own sessions by account, wherever the policy is written", async () => {
    // Published on the owner's computer too: a cloud workspace's policy is
    // shared, and the hook tells sessions apart by CANOPY_MEMBER.
    expect(layerGates(MAP, await owners(), [], sam)[0].exceptMembers).toEqual(["u-sam"]);
  });

  it("an older name-only claim isn't published on its owner's computer", async () => {
    await fakeLedger.appendLedger("/repo", {
      kind: "rule",
      ref: { kind: "lens-layer", id: "data" },
      data: { type: "layer-owner", layer: "data", owner: "Sam" },
    });
    const o = await layerOwners("/repo");
    expect(layerGates(MAP, o, [], sam)).toEqual([]);
    expect(layerGates(MAP, o, [], alex)[0]).not.toHaveProperty("exceptMembers");
  });

  it("is enforced when nobody is signed in (no one here is the owner)", async () => {
    expect(layerGates(MAP, await owners(), [], null)).toHaveLength(1);
  });

  it("lets the owner's approved files through for a day, and only the owner's approvals", async () => {
    const o = await owners();
    const ok = approval();
    const notOwner = approval({ approvalId: "la-zzz999", ownerId: "u-mallory", files: ["prisma/seed.ts"] });
    const pending = approval({ approvalId: "la-pend01", status: "pending", files: ["prisma/x.ts"] });
    const [gate] = layerGates(MAP, o, [ok, notOwner, pending], alex, 3000);
    expect(gate.gate).toEqual({ type: "deny-path-write", globs: ["prisma/**"], exceptFiles: ["prisma/schema.prisma"] });
    const later = layerGates(MAP, o, [ok], alex, 2000 + APPROVAL_TTL_MS + 1)[0];
    expect(later.gate).toEqual({ type: "deny-path-write", globs: ["prisma/**"] });
    expect(approvedFiles("data", "u-sam", [ok], 2500)).toEqual(["prisma/schema.prisma"]);
  });

  it("a layer with no patterns, or nobody owning it, has no gate", async () => {
    expect(layerGates({ globs: { ...MAP.globs, data: [] } }, await owners(), [], alex)).toEqual([]);
    expect(layerGates(MAP, {}, [], alex)).toEqual([]);
    expect(layerGates(null, await owners(), [], alex)).toEqual([]);
  });

  it("every policy publish carries the layer gates beside the written rules", async () => {
    await claimLayer("/repo", "data", sam);
    // The layer map lives in the ledger as a memory entry.
    await fakeLedger.appendLedger("/repo", {
      kind: "memory",
      ref: { kind: "lens-layers", id: "project" },
      data: {
        map: {
          areas: { data: { summary: "d", files: [] }, logic: { summary: "l", files: [] }, view: { summary: "v", files: [] } },
          globs: MAP.globs,
        },
      },
    });
    expect(await currentLayerGates("/repo")).toHaveLength(1);
    await publishPolicy("/repo", { rules: [], trifecta: "warn" });
    const written = gatesPolicyWrite.mock.calls[0][1] as { gates: { id: string }[] };
    expect(written.gates.map((g) => g.id)).toEqual(["lens-layer:data"]);
    // And a pure build with no layer gates is unchanged.
    expect(buildPolicy({ rules: [], trifecta: "warn" }).gates).toEqual([]);
  });

  it("follows edited patterns", async () => {
    await fakeLedger.appendLedger("/repo", {
      kind: "memory",
      ref: { kind: "lens-layers", id: "project" },
      data: {
        map: {
          areas: { data: { summary: "d", files: [] }, logic: { summary: "l", files: [] }, view: { summary: "v", files: [] } },
          globs: MAP.globs,
        },
      },
    });
    await claimLayer("/repo", "data", sam);
    await saveLayerGlobs("/repo", "data", ["db/"]);
    const [g] = await currentLayerGates("/repo");
    expect(g.gate).toEqual({ type: "deny-path-write", globs: ["db/"] });
  });
});

describe("approval without a pull request", () => {
  const hit = { layer: "data" as const, owner: "Sam", ownerId: "u-sam", files: ["/repo/prisma/schema.prisma"] };

  it("records a pending request and opens the share dialog addressed to the owner with a valid card", async () => {
    const r = await requestLayerApproval({ root: "/repo", projectName: "Shop", hit, goal: "Add a phone number to customers", attempted: ["change /repo/prisma/schema.prisma"] });
    expect(r.ok).toBe(true);
    const req = shared[0] as { kind: string; to: string; card: unknown };
    expect(req.kind).toBe("share");
    expect(req.to).toBe("u-sam");
    const card = parseCard(req.card);
    expect(card).toMatchObject({ type: "layer-approval", layer: "data", owner: "u-sam", files: ["prisma/schema.prisma"], repo: { slug: "acme/shop" } });
    expect(card && card.type === "layer-approval" && card.summary).toContain("Add a phone number");
    const rows = fakeLedger.rows.filter((x) => x.kind === "review");
    expect(rows[0]).toMatchObject({ ref: { kind: "lens-approval" }, data: { status: "pending", ownerId: "u-sam" } });
  });

  it("refuses an owner with no account id (a claim from before accounts)", async () => {
    const r = await requestLayerApproval({ root: "/repo", projectName: "Shop", hit: { ...hit, ownerId: null } });
    expect(r).toMatchObject({ ok: false, message: expect.stringContaining("claim it again while signed in") });
    expect(shared).toHaveLength(0);
  });

  it("applies the owner's answer: ledger, policy republished, person told — and ignores anyone else's", async () => {
    const r = await requestLayerApproval({ root: "/repo", projectName: "Shop", hit });
    const id = r.ok ? r.id : "";
    const republish = vi.fn(async () => {});
    expect(await applyLayerApprovalAnswer({ approval: id, outcome: "approved", by: "u-mallory" }, { republish })).toBeNull();
    expect(republish).not.toHaveBeenCalled();
    const next = await applyLayerApprovalAnswer({ approval: id, outcome: "approved", by: "u-sam", byName: "Sam" }, { republish, now: () => 9000 });
    expect(next?.data).toMatchObject({ status: "approved", decidedAt: 9000, decidedBy: "Sam" });
    expect(republish).toHaveBeenCalledWith("/repo");
    expect(attention[0]).toMatchObject({ title: "Sam approved the Data change" });
    // The same answer again changes nothing.
    expect(await applyLayerApprovalAnswer({ approval: id, outcome: "approved", by: "u-sam" }, { republish })).toBeNull();
    // An answer for a request this machine never sent is ignored.
    expect(await applyLayerApprovalAnswer({ approval: "la-unknown1", outcome: "approved", by: "u-sam" }, { republish })).toBeNull();
  });

  it("reads an answer off a chat message", () => {
    const message = {
      id: "11111111-1111-4111-8111-111111111111",
      sender: "u-sam",
      recipient: "u-alex",
      created: 1,
      text: "Use the existing column instead\n⛔ Rejected the change (via Canopy)",
      card: { type: "layer-approval-outcome", v: 1, request: "22222222-2222-4222-8222-222222222222", approval: "la-abc123", outcome: "rejected" },
    };
    expect(answerFrom({ message, senderName: "Sam" } as never)).toEqual({
      approval: "la-abc123",
      outcome: "rejected",
      by: "u-sam",
      byName: "Sam",
      note: "Use the existing column instead",
    });
    expect(answerFrom({ message: { ...message, card: undefined } } as never)).toBeNull();
  });

  it("summarises what was asked, what was stopped and the diff so far", () => {
    const text = approvalSummary({ hit, goal: "Add phone", attempted: ["change prisma/schema.prisma"], diff: "+phone String" });
    expect(text).toContain("What was asked for: Add phone");
    expect(text).toContain("- change prisma/schema.prisma");
    expect(text).toContain("+phone String");
  });
});

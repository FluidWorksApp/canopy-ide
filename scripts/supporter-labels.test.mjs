import { describe, expect, it, vi } from "vitest";
import {
  findSupporter,
  isActive,
  loadStore,
  managedLabels,
  normalizeLogin,
  plan,
  readLocalConfig,
  weightFor,
} from "./supporter-labels.mjs";

const config = {
  policy: { oneTimeGraceDays: 365, lapsedGraceDays: 30 },
  tiers: [
    { id: "bronze", label: "supporter:bronze", color: "cd7f32", weight: 1 },
    { id: "gold", label: "supporter:gold", color: "e3b341", weight: 4 },
  ],
};

const NOW = Date.parse("2026-07-29T00:00:00Z");
const daysAgo = (n) => new Date(NOW - n * 86_400_000).toISOString();

const supporter = (over = {}) => ({
  login: "Octocat",
  tier: "gold",
  visibility: "public",
  recurring: true,
  since: daysAgo(90),
  lastPaymentAt: daysAgo(3),
  ...over,
});

describe("normalizeLogin", () => {
  it("is case-insensitive and tolerates a leading @", () => {
    expect(normalizeLogin(" @OctoCat ")).toBe("octocat");
  });

  it("returns an empty string for nothing", () => {
    expect(normalizeLogin(undefined)).toBe("");
  });
});

describe("findSupporter", () => {
  const store = { supporters: [supporter()] };

  it("matches regardless of case", () => {
    expect(findSupporter(store, "octocat")?.tier).toBe("gold");
  });

  it("returns null for an unknown login, and never matches the empty login", () => {
    expect(findSupporter(store, "stranger")).toBeNull();
    expect(findSupporter({ supporters: [supporter({ login: "" })] }, "")).toBeNull();
  });
});

describe("isActive", () => {
  it("keeps a recurring supporter active while they have not lapsed", () => {
    expect(isActive(supporter(), config, NOW)).toBe(true);
  });

  it("holds a lapsed subscription for the grace period, then drops it", () => {
    expect(isActive(supporter({ lapsedAt: daysAgo(29) }), config, NOW)).toBe(true);
    expect(isActive(supporter({ lapsedAt: daysAgo(31) }), config, NOW)).toBe(false);
  });

  it("holds a one-time payment for its own, longer grace period", () => {
    const oneTime = { recurring: false, lapsedAt: null };
    expect(isActive(supporter({ ...oneTime, lastPaymentAt: daysAgo(364) }), config, NOW)).toBe(true);
    expect(isActive(supporter({ ...oneTime, lastPaymentAt: daysAgo(366) }), config, NOW)).toBe(
      false,
    );
  });

  it("falls back to `since` when a one-time entry carries no payment date", () => {
    expect(isActive({ recurring: false, since: daysAgo(10) }, config, NOW)).toBe(true);
    expect(isActive({ recurring: false }, config, NOW)).toBe(false);
  });
});

describe("weightFor", () => {
  it("reads the weight off the tier, and counts private supporters too", () => {
    expect(weightFor(supporter({ visibility: "private" }), config, NOW)).toBe(4);
    expect(weightFor(supporter({ tier: "bronze" }), config, NOW)).toBe(1);
  });

  it("is zero for a lapsed supporter, an unknown tier, and a non-supporter", () => {
    expect(weightFor(supporter({ lapsedAt: daysAgo(90) }), config, NOW)).toBe(0);
    expect(weightFor(supporter({ tier: "platinum" }), config, NOW)).toBe(0);
    expect(weightFor(null, config, NOW)).toBe(0);
  });
});

describe("plan", () => {
  const run = (over, currentLabels = []) =>
    plan({ entry: over === null ? null : supporter(over), config, currentLabels, now: NOW });

  it("adds the tier label for a public supporter", () => {
    expect(run({})).toMatchObject({ add: ["supporter:gold"], remove: [], weight: 4 });
  });

  it("does nothing when the label is already there", () => {
    expect(run({}, ["supporter:gold", "bug"])).toMatchObject({ add: [], remove: [] });
  });

  it("moves the label when the tier changes, leaving unmanaged labels alone", () => {
    expect(run({ tier: "bronze" }, ["supporter:gold", "bug"])).toMatchObject({
      add: ["supporter:bronze"],
      remove: ["supporter:gold"],
    });
  });

  it("withholds the label from a private supporter without dropping their weight", () => {
    expect(run({ visibility: "private" })).toMatchObject({
      add: [],
      withheld: true,
      weight: 4,
    });
  });

  it("strips a stale label from a supporter who has since lapsed", () => {
    expect(run({ lapsedAt: daysAgo(90) }, ["supporter:gold"])).toMatchObject({
      add: [],
      remove: ["supporter:gold"],
      tier: null,
    });
  });

  it("leaves a non-supporter's issue untouched", () => {
    expect(run(null, ["bug"])).toMatchObject({ add: [], remove: [] });
  });

  it("accepts the label objects the GitHub event payload actually carries", () => {
    expect(run({ tier: "bronze" }, [{ name: "supporter:gold" }])).toMatchObject({
      add: ["supporter:bronze"],
      remove: ["supporter:gold"],
    });
  });
});

describe("the committed store", () => {
  it("declares every tier the labels reference, with a weight", async () => {
    const real = await readLocalConfig();
    expect(managedLabels(real)).toEqual([
      "supporter:bronze",
      "supporter:silver",
      "supporter:gold",
    ]);
    for (const tier of real.tiers) {
      expect(tier.weight).toBeGreaterThan(0);
      expect(tier.color).toMatch(/^[0-9a-f]{6}$/);
    }
  });

  it("loads, and every entry resolves against a declared tier", async () => {
    const real = await readLocalConfig();
    const store = await loadStore();
    for (const entry of store.supporters) {
      expect(real.tiers.map((t) => t.id)).toContain(entry.tier);
      expect(["public", "private"]).toContain(entry.visibility);
    }
  });
});

describe("loadStore", () => {
  it("prefers the remote store when SUPPORTERS_URL is set", async () => {
    const remote = { version: 1, supporters: [supporter({ login: "remote-only" })] };
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => remote }));
    const store = await loadStore({ url: "https://example.test/supporters", fetchImpl });
    expect(store.supporters[0].login).toBe("remote-only");
    expect(fetchImpl.mock.calls[0][0]).toBe("https://example.test/supporters");
  });

  it("falls back to the committed file when the fetch fails", async () => {
    const log = vi.fn();
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 503 }));
    const store = await loadStore({ url: "https://example.test/supporters", fetchImpl, log });
    expect(store.version).toBe(1);
    expect(log).toHaveBeenCalled();
  });
});

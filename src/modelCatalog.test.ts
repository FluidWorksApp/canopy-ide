import { describe, expect, it } from "vitest";
import {
  CATALOGUE_ONLY,
  DONORS,
  SEEDS,
  choicesFor,
  curate,
  donorQuery,
  parseAider,
  parseOmp,
  refreshChoices,
  versionOf,
  type ModelFamily,
} from "./modelCatalog";

const FAMILIES: ModelFamily[] = ["anthropic", "openai", "google"];

// Trimmed from the real `omp models --json` on 2026-07-29.
const OMP_JSON = JSON.stringify({
  models: [
    { provider: "anthropic", id: "claude-3-5-sonnet-20240620" },
    { provider: "anthropic", id: "claude-fable-5" },
    { provider: "anthropic", id: "claude-mythos-5" },
    { provider: "anthropic", id: "claude-haiku-4-5" },
    { provider: "anthropic", id: "claude-haiku-4-5-20251001" },
    { provider: "anthropic", id: "claude-opus-4-8" },
    { provider: "anthropic", id: "claude-opus-5" },
    { provider: "anthropic", id: "claude-sonnet-5" },
    { provider: "openai", id: "gpt-5.5" },
  ],
});

// Trimmed from the real `aider --list-models` runs on 2026-07-29.
const AIDER_GPT = `
- gpt-5
- gpt-5-chat-latest
- gpt-5.4
- gpt-5.4-2026-03-05
- gpt-5.4-mini
- gpt-5.4-nano
- gpt-5.5
- gpt-5.5-2026-04-23
- openrouter/openai/gpt-5.2-codex
`;

const AIDER_GEMINI = `
- gemini-3-pro-preview
- gemini-3.1-pro-preview
- gemini-3.1-pro-preview-customtools
- gemini-3.5-flash
- gemini-3.5-flash-lite
- gemini-3.6-flash
- gemini/gemini-3.6-flash
- vertex_ai/gemini-3.6-flash
`;

describe("seeds", () => {
  it("gives every family a usable menu with no donor installed", () => {
    // The common case: neither omp nor aider is on the machine, and the tray
    // still has to draw something. An empty seed would be a blank menu.
    for (const f of FAMILIES) {
      expect(SEEDS[f].length, f).toBeGreaterThan(0);
      for (const c of SEEDS[f]) {
        expect(c.label.length, `${f} ${c.id}`).toBeGreaterThan(0);
        expect(c.hint.length, `${f} ${c.id}`).toBeGreaterThan(0);
      }
      const ids = SEEDS[f].map((c) => c.id);
      expect(new Set(ids).size, f).toBe(ids.length);
    }
  });

  it("pins no dated snapshot in any seed", () => {
    // A dated id is the failure this whole module exists to prevent: it is
    // correct on the day it is written and wrong at the next release.
    for (const f of FAMILIES) {
      for (const c of SEEDS[f]) expect(c.id, `${f}`).not.toMatch(/\d{4}-?\d{2}-?\d{2}/);
    }
  });

  it("keeps Claude on aliases, since those are what survive a release", () => {
    for (const c of SEEDS.anthropic) expect(c.id).not.toMatch(/^claude-/);
  });

  it("never offers a Glasswing-only model to everyone", () => {
    // claude-mythos-5 shows up in omp's catalogue but is Project Glasswing
    // only, so a menu entry for it fails for almost every account.
    const all = FAMILIES.flatMap((f) => SEEDS[f].map((c) => c.id)).join(" ");
    expect(all).not.toMatch(/mythos/);
    expect(curate("anthropic", ["claude-mythos-5"])).toEqual([]);
  });
});

describe("parseOmp", () => {
  it("takes only the asked-for provider's ids", () => {
    expect(parseOmp(OMP_JSON, "openai")).toEqual(["gpt-5.5"]);
    expect(parseOmp(OMP_JSON, "anthropic")).toContain("claude-opus-5");
    expect(parseOmp(OMP_JSON, "anthropic")).not.toContain("gpt-5.5");
  });

  it("declines rather than throws on output that isn't the JSON it expects", () => {
    // A donor that changed its output format, or printed a warning first, must
    // degrade to the seed — not take the tray down with a parse error.
    for (const junk of ["", "not json", "{}", '{"models":"nope"}', "null"]) {
      expect(parseOmp(junk, "anthropic")).toEqual([]);
    }
  });
});

describe("parseAider", () => {
  it("reads the bare ids out of the list", () => {
    expect(parseAider(AIDER_GPT)).toContain("gpt-5.5");
  });

  it("drops cloud-reseller routes instead of stripping them", () => {
    // vertex_ai/claude-opus-5 is a different endpoint with different ids, not
    // a prefix to shave off — typing the shaved name would be a guess.
    const ids = parseAider(AIDER_GEMINI);
    expect(ids).not.toContain("vertex_ai/gemini-3.6-flash");
    expect(parseAider(AIDER_GPT)).not.toContain("gpt-5.2-codex");
  });

  it("strips LiteLLM's own provider route, which is not the CLI's", () => {
    expect(parseAider("- gemini/gemini-3.6-flash")).toEqual(["gemini-3.6-flash"]);
  });

  it("ignores everything that isn't a list row", () => {
    expect(parseAider("Warning: Input is not a terminal (fd=0).\nModels:\n")).toEqual([]);
  });
});

describe("versionOf", () => {
  it("reads both the dotted and the dashed spelling", () => {
    expect(versionOf("gpt-5.5")).toBe(5.5);
    expect(versionOf("claude-opus-4-8")).toBe(4.8);
    expect(versionOf("gemini-3.6-flash")).toBe(3.6);
    expect(versionOf("claude-opus-5")).toBe(5);
  });

  it("orders a point release above its own major", () => {
    // The comparison curate() relies on: opus-5 must beat opus-4-8, and 5.5
    // must beat 5.4 — a naive string sort gets the second one wrong.
    expect(versionOf("claude-opus-5")).toBeGreaterThan(versionOf("claude-opus-4-8"));
    expect(versionOf("gpt-5.5")).toBeGreaterThan(versionOf("gpt-5.4"));
  });
});

describe("curate", () => {
  it("reduces a vendor catalogue to the newest of each tier", () => {
    const choices = curate("anthropic", parseOmp(OMP_JSON, "anthropic"));
    expect(choices.map((c) => c.id)).toEqual(["fable", "opus", "sonnet", "haiku"]);
    // Not claude-opus-4-8, and not the 2024 sonnet.
    expect(choices.find((c) => c.id === "opus")?.label).toBe("Opus 5");
  });

  it("drops dated snapshots of a model that also has an undated id", () => {
    const ids = curate("anthropic", [
      "claude-haiku-4-5",
      "claude-haiku-4-5-20251001",
    ]).map((c) => c.id);
    expect(ids).toEqual(["haiku"]);
  });

  it("drops the chat, search, live and preview-only variants", () => {
    const ids = curate("openai", parseAider(AIDER_GPT)).map((c) => c.id);
    expect(ids).not.toContain("gpt-5-chat-latest");
    expect(ids).toContain("gpt-5.5");
    expect(ids).toContain("gpt-5.4-mini");
  });

  it("keeps a preview id when the tier has nothing else", () => {
    // Gemini Pro ships preview-suffixed and there is no stable id to prefer,
    // so dropping previews outright would empty the tier.
    const ids = curate("google", parseAider(AIDER_GEMINI)).map((c) => c.id);
    expect(ids).toContain("gemini-3.1-pro-preview");
    expect(ids).toContain("gemini-3.6-flash");
    expect(ids).not.toContain("gemini-3.1-pro-preview-customtools");
  });

  it("returns nothing when the catalogue held nothing recognisable", () => {
    expect(curate("anthropic", ["llama-3", "", "mistral-large"])).toEqual([]);
  });
});

describe("choicesFor", () => {
  it("uses the seed when no donor answered", () => {
    expect(choicesFor("anthropic")).toEqual(SEEDS.anthropic);
  });

  it("prefers a donor's catalogue over the seed", () => {
    const choices = choicesFor("anthropic", { agent: "omp", stdout: OMP_JSON });
    expect(choices.find((c) => c.id === "opus")?.label).toBe("Opus 5");
    expect(choices).not.toEqual(SEEDS.anthropic);
  });

  it("falls back to the seed rather than blanking the menu", () => {
    // Every way a donor can fail — unparseable, empty, nothing recognisable,
    // or a donor that doesn't cover the family — lands on the seed. A blank
    // model menu is worse than a slightly stale one.
    for (const stdout of ["", "garbage", '{"models":[]}', JSON.stringify({ models: [{ provider: "x", id: "y" }] })]) {
      expect(choicesFor("anthropic", { agent: "omp", stdout })).toEqual(SEEDS.anthropic);
    }
    expect(choicesFor("anthropic", { agent: "opencode", stdout: OMP_JSON })).toEqual(
      SEEDS.anthropic,
    );
  });
});

describe("donor wiring", () => {
  it("has a query for every donor and family pair it claims to cover", () => {
    // The index has to be a real slot in that donor's argv table in agents.rs.
    // The two tables can only be kept honest by a test, since one is Rust.
    const SLOTS: Record<string, number> = { omp: 1, aider: 3 };
    for (const d of DONORS) {
      for (const f of d.families) {
        const q = donorQuery(d.agent, f);
        expect(q, `${d.agent} ${f}`).not.toBeNull();
        expect(q!, `${d.agent} ${f}`).toBeGreaterThanOrEqual(0);
        expect(q!, `${d.agent} ${f}`).toBeLessThan(SLOTS[d.agent]);
      }
    }
  });

  it("gives each family its own aider query but shares omp's one dump", () => {
    expect(new Set(FAMILIES.map((f) => donorQuery("aider", f))).size).toBe(3);
    expect(new Set(FAMILIES.map((f) => donorQuery("omp", f))).size).toBe(1);
  });

  it("has no query for a CLI that is not a donor", () => {
    expect(donorQuery("claude", "anthropic")).toBeNull();
  });

  it("stops at the first donor that answers", async () => {
    const asked: string[] = [];
    const choices = await refreshChoices("anthropic", async (donor) => {
      asked.push(donor);
      return donor === "omp" ? OMP_JSON : "";
    });
    // aider is never run: it costs a pty and several seconds, and omp already
    // answered. That ordering is the reason DONORS is an array, not a set.
    expect(asked).toEqual(["omp"]);
    expect(choices.find((c) => c.id === "opus")?.label).toBe("Opus 5");
  });

  it("moves to the next donor when one has nothing", async () => {
    const asked: string[] = [];
    await refreshChoices("openai", async (donor) => {
      asked.push(donor);
      return donor === "omp" ? '{"models":[]}' : AIDER_GPT;
    });
    expect(asked).toEqual(["omp", "aider"]);
  });

  it("lands on the seed when every donor fails, however it fails", async () => {
    // Not installed (null), unparseable, and outright throwing all have to end
    // in a drawable menu — this is the path most users take, since neither
    // donor is installed on a typical machine.
    for (const run of [
      async () => null,
      async () => "garbage",
      async () => {
        throw new Error("spawn failed");
      },
    ]) {
      expect(await refreshChoices("anthropic", run)).toEqual(SEEDS.anthropic);
    }
  });

  it("says why each catalogue-only family stays on its own picker", () => {
    // The reason travels with the entry so a later change has to argue with
    // it, rather than discovering the constraint by shipping a broken menu.
    for (const [family, why] of Object.entries(CATALOGUE_ONLY)) {
      expect(why.length, family).toBeGreaterThan(20);
    }
    expect(Object.keys(CATALOGUE_ONLY).sort()).toEqual(["google", "openai"]);
  });
});

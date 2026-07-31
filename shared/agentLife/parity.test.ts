// One manifest, two languages. The same fixtures run in
// `src-tauri/src/agent_life.rs`'s test module; if the two ladders ever disagree
// on a single case, both suites go red.
//
// This is the only thing standing between these two implementations and the
// pair they replace: `msg.contains("waiting for")` in Rust and
// `/waiting for (your )?input/i` in TypeScript — two non-equivalent predicates
// over the same bytes, in two languages, with a comment in the Rust file
// stating it mirrored the frontend and nothing checking that it did.
import { describe, expect, it } from "vitest";
import fixtures from "./fixtures.json";
import { agentLife, type PtyEvidence } from "./ladder";

interface FixturePty {
  kind: string;
  hint?: boolean;
  cpu?: number;
  quietForMs?: number;
  sinceInputMs?: number;
  firstSeen?: number;
}

interface Fixture {
  name: string;
  digest: Record<string, unknown>;
  pty: FixturePty | null;
  now: number;
  expect: { state: string; via: string; confidence: string };
}

const toPty = (p: FixturePty | null): PtyEvidence | undefined => {
  if (!p) return undefined;
  if (p.kind !== "live") return { kind: "gone" };
  return {
    kind: "live",
    hint: p.hint ? { bin: "x", interactive: true } : null,
    cpu: p.cpu ?? 0,
    quietForMs: p.quietForMs,
    sinceInputMs: p.sinceInputMs,
    firstSeen: p.firstSeen,
  };
};

describe("the two ladders agree", () => {
  const cases = fixtures as unknown as Fixture[];

  it("has a net worth having", () => {
    expect(cases.length).toBeGreaterThanOrEqual(20);
  });

  it.each(cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const life = agentLife({ digest: c.digest, pty: toPty(c.pty), now: c.now });
    expect({
      state: life.state,
      via: life.via,
      confidence: life.confidence,
    }).toEqual(c.expect);
  });
});

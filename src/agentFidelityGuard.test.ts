// The manifest is a promise about what each CLI's installer actually
// registers. This checks the promise against the installer, in both directions.
//
// Why it has to exist: omp's plugin registers every one of its events inside
// `try { pi?.on?.(ev, fn) } catch {}`, against an API its own installer comment
// calls "in flux". A rename there registers nothing and throws nothing — omp
// would simply stop reporting, forever, and the only symptom would be sessions
// that never leave whatever state they were last in. Nothing else in the
// codebase would notice.
//
// Do not fix a failure here by editing the manifest to match a rename you have
// not verified. Read the CLI's docs, confirm the event, then update both and
// bump `verifiedAt`.
/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ALL_FIDELITY } from "../shared/agentLife";

const AGENTS_RS = readFileSync(
  join(process.cwd(), "src-tauri/src/agents.rs"),
  "utf8",
);

/** The body of one CLI's setup, so an event name registered for claude cannot
 *  satisfy a claim made about amp. */
function setupBody(id: string): string {
  const fnNames = [
    `setup_${id}_hooks`,
    `setup_${id}_plugin`,
    `setup_${id}_hook`,
  ];
  for (const fn of fnNames) {
    const at = AGENTS_RS.indexOf(`fn ${fn}(`);
    if (at === -1) continue;
    // To the next top-level `fn ` after it — the generated plugin templates are
    // raw strings inside the function, which is exactly what we want to search.
    const next = AGENTS_RS.indexOf("\nfn ", at + 1);
    return AGENTS_RS.slice(at, next === -1 ? undefined : next);
  }
  return "";
}

describe("the fidelity manifest matches the installers", () => {
  it("covers exactly the supported agents", () => {
    const supported = [
      ...AGENTS_RS.matchAll(/\("([a-z]+)",\s*"[a-z]+"\)/g),
    ].map((m) => m[1]);
    const declared = ALL_FIDELITY.map((f) => f.id).sort();
    // SUPPORTED_AGENTS is the list; every id in it must be declared.
    for (const id of new Set(supported)) {
      if (!AGENTS_RS.includes(`"${id}" => vec![`)) continue; // not a setup arm
      expect(declared, `${id} is set up but undeclared`).toContain(id);
    }
    expect(declared.length).toBeGreaterThanOrEqual(7);
  });

  it("declares no event its installer does not register", () => {
    const missing: string[] = [];
    for (const f of ALL_FIDELITY) {
      const body = setupBody(f.id);
      if (!body) continue;
      const claimed = [
        ...f.endsSession,
        ...f.endsTurn,
        ...f.startsTurn,
        ...f.toolActivity,
        ...f.structuredBlock,
      ];
      for (const ev of claimed) {
        // "PreToolUse:AskUserQuestion" is registered as an event plus a matcher.
        for (const part of ev.split(":")) {
          if (!body.includes(part)) missing.push(`${f.id} claims ${ev} (${part})`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("only lets a CLI that registers SessionEnd claim it can end a session", () => {
    for (const f of ALL_FIDELITY) {
      const registersEnd = setupBody(f.id).includes("SessionEnd");
      expect(
        f.endsSession.length > 0,
        `${f.id}: endsSession must match whether its installer registers SessionEnd`,
      ).toBe(registersEnd);
    }
  });

  it("only lets claude claim the questionnaire block", () => {
    for (const f of ALL_FIDELITY) {
      const has = f.structuredBlock.some((e) => e.includes("AskUserQuestion"));
      expect(has, `${f.id}`).toBe(setupBody(f.id).includes("AskUserQuestion"));
    }
  });

  it("has no installer shipping prose we then re-parse", () => {
    // The assertion that would have caught aider. Its integration passed
    // `--message "Aider is waiting for your input"` — a sentence Canopy wrote
    // into aider's own config, which the helper then matched "waiting for"
    // against and recorded as *finished*. aider fires that command both after a
    // turn and at a y/n confirm, so an agent stopped at a confirmation prompt
    // was classified as done, and done is what auto-hibernation kills.
    //
    // Classify at the source with `--signal`; never round-trip meaning through
    // a string.
    const code = AGENTS_RS.split("\n").filter((l) => {
      const t = l.trim();
      return !t.startsWith("//") && !t.startsWith("///");
    });
    expect(code.filter((l) => l.includes("--message"))).toEqual([]);
  });

  it("records when each row was last checked against the code", () => {
    for (const f of ALL_FIDELITY) {
      expect(f.verifiedAt, `${f.id}`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("does not let a CLI with no notification event claim it can be blocked", () => {
    for (const f of ALL_FIDELITY) {
      if (f.notification !== "none") continue;
      const body = setupBody(f.id);
      if (!body) continue;
      // Either it has a dedicated structural event, or it genuinely cannot say.
      if (f.structuredBlock.length > 0) continue;
      expect(
        /Notification/.test(body),
        `${f.id} declares no notification but its installer registers one`,
      ).toBe(false);
    }
  });
});

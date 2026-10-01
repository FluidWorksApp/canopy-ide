// If this goes red, a surface has started naming a terminal on its own. Do not
// "fix" it by weakening the assertion or by adding an exemption — the point of
// the test is that there is exactly one place a name is written and exactly one
// place a name is decided. This repo does not do exemption lists: the moment
// one exists, the next offender is added to it.
//
// The bug it exists to prevent, in full: a rename landed in `customTitle` when
// the tab had no pty and in `name` when it did, `name` was also where the
// native core's generated label lived, and a boolean `renamed` was the only
// thing telling the two apart. Six writers shared those three fields and eight
// readers each hand-spelled their own precedence chain. Two of the writers
// never set the flag, two of the readers never consulted the field a rename
// actually used, and two of the chains contradicted each other outright. So a
// name the user typed was replaced by their own next sentence, and a dev
// server's chip decayed into `/bin/zsh` a few seconds after it started.
//
// Everything below is a route back to that. If you are adding a surface that
// shows a terminal's name, call `tabName`. If you are adding something that
// learns a name, give it an author in `NameAuthor` and go through `namePatch`.
/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(process.cwd(), "src");

/** The slots. Naming one outside tabName.ts is either a write that skipped
 *  `namePatch` or a read that skipped `tabName` — both are the bug. */
const SLOTS = [
  "userName",
  "agentName",
  "promptName",
  "nativeName",
  "oscTitle",
  "launchTitle",
];

/** The fields the slots replaced. A reappearance is a merge that resurrected
 *  the shared-field model, which is the shape the bug actually had. */
const RETIRED = ["customTitle", "renamed"];

/** Only these may name a slot: the module that owns them, its own tests, and
 *  the two stores that persist a name across a pty's death — which write the
 *  legacy `renamed` key by reading it, never by producing it. */
const SLOT_EXEMPT = new Set([
  "tabName.ts",
  "tabName.test.ts",
  "tabNameGuard.test.ts",
  "agentDisplayName.ts",
  "components/ProjectView/helpers.ts",
]);

/** `renamed` survives as a read-only migration key in the two snapshot shapes
 *  and in the module that migrates them. Nothing may write it. */
const RETIRED_EXEMPT = new Set([
  "tabName.ts",
  "tabName.test.ts",
  "tabNameGuard.test.ts",
  "hibernation.ts",
  "terminalMemory.ts",
]);

/** The native rename. Every surface a user can rename from goes through
 *  `renameSession`, which is what makes one subscription enough to record the
 *  choice no matter which surface asked. */
const RENAME_EXEMPT = new Set(["sessionRename.ts", "ipc.ts", "tabNameGuard.test.ts"]);

function sourceFiles(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...sourceFiles(join(dir, entry.name), rel));
    else if (/\.tsx?$/.test(entry.name)) out.push(rel);
  }
  return out;
}

/** Comments and string literals stripped. Without this the guard trips on prose
 *  — a comment that says "did it get renamed?" is not a resurrection of the
 *  field, and a test that greps for one is not a use of it. */
const code = (text: string) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '""');

const files = sourceFiles(SRC).map((rel) => ({
  rel,
  text: code(readFileSync(join(SRC, rel), "utf8")),
}));

describe("one place decides what a terminal is called", () => {
  it("finds no surface reaching past tabName for a name slot", () => {
    const offenders: string[] = [];
    for (const { rel, text } of files) {
      // Test fixtures build tabs; they are allowed to fill a slot, but not to
      // re-implement precedence over one.
      const fixture = /\.test\.tsx?$/.test(rel);
      if (SLOT_EXEMPT.has(rel)) continue;
      for (const slot of SLOTS) {
        if (fixture && new RegExp(`\\b${slot}:`).test(text)) continue;
        // A `??` or `||` chain over a slot is a hand-spelled precedence — the
        // exact shape that let eight surfaces disagree.
        if (new RegExp(`\\.${slot}\\s*(\\?\\?|\\|\\|)`).test(text))
          offenders.push(`${rel} spells its own precedence over ${slot}`);
      }
    }
    expect(
      offenders,
      "call tabName() — a hand-spelled chain is how the strip and the Agents page came to disagree",
    ).toEqual([]);
  });

  it("finds no writer that skipped namePatch", () => {
    const offenders: string[] = [];
    for (const { rel, text } of files) {
      if (SLOT_EXEMPT.has(rel) || /\.test\.tsx?$/.test(rel)) continue;
      for (const slot of SLOTS)
        // A slot in a patch literal, without namePatch anywhere in the file.
        if (new RegExp(`\\b${slot}:`).test(text) && !/\bnamePatch\b/.test(text))
          offenders.push(`${rel} writes ${slot} without namePatch`);
    }
    expect(
      offenders,
      "go through namePatch() — it is what stops one author reaching another's slot",
    ).toEqual([]);
  });

  it("has not resurrected the shared field it replaced", () => {
    const offenders: string[] = [];
    for (const { rel, text } of files) {
      if (RETIRED_EXEMPT.has(rel)) continue;
      for (const field of RETIRED)
        // As a property — an object key or a type member — not as the name of
        // somebody's local variable.
        if (new RegExp(`(?<!\\b(?:const|let|var)\\s)\\b${field}\\??:`).test(text))
          offenders.push(`${rel} brings back ${field}`);
    }
    expect(
      offenders,
      "a name's author is which slot holds it, never a flag travelling beside it",
    ).toEqual([]);
  });

  it("finds no surface renaming a session for itself", () => {
    const offenders: string[] = [];
    for (const { rel, text } of files) {
      if (RENAME_EXEMPT.has(rel) || /\.test\.tsx?$/.test(rel)) continue;
      if (/\bptySetName\b/.test(text)) offenders.push(`${rel} calls ptySetName`);
    }
    expect(
      offenders,
      "use renameSession() — the Agents page has no tab to record the choice on, and that asymmetry is the bug",
    ).toEqual([]);
  });
});

// Text the app does not control the length of must never push a control off a
// row.
//
// A flex child defaults to `min-width: auto`, which means it refuses to shrink
// below its own content; `flex: 0 0 auto` says the same thing out loud. Put
// either on a span holding a branch name, a path or a prompt and the span wins
// the argument: it takes the width it wants and shoves whatever follows it out
// of the row. That is how a Resume button ends up clipped off the right edge,
// how a version badge ends up painted over the tile beside it, and how the
// Agents panel hid its own workspace button at every panel width.
//
// jsdom cannot see any of it — an overflowing row has exactly the right DOM —
// so the rule is guarded at the source, the way the branch-switch registry and
// the sticky chips are.
//
// The list below is every element known to carry text from a repository, a
// filesystem or a human. Adding a row that shows one means adding it here. Do
// not delete an entry to make this pass: an entry going red means that surface
// has stopped truncating, which is the bug.
/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CSS = readFileSync(join(process.cwd(), "src", "index.css"), "utf8");

/** The declarations of a top-level rule, by exact selector. */
function ruleBody(selector: string): string {
  const at = CSS.indexOf(`\n${selector} {`);
  expect(at, `no rule for ${selector}`).toBeGreaterThan(-1);
  const open = CSS.indexOf("{", at);
  const close = CSS.indexOf("}", open);
  return CSS.slice(open + 1, close);
}

/** Carries unbounded text and sits in a flex row: must shrink AND ellipsise.
 *  A `max-width` is optional — some of these are the row's flexible middle and
 *  are meant to take the slack. */
const MUST_TRUNCATE = [
  // The project home — the surface the overflow was first reported on.
  ".resume-dir,\n.resume-branch",
  // Window chrome, on screen at all times. Two shapes to notice: the project
  // pill's name is the one child with no class of its own, and the status
  // branch caps the chip but truncates the button inside it, because
  // text-overflow only ever truncates the box the text is actually in.
  ".status-branch .status-model-btn",
  ".project-tab > span:not([class])",
  ".tab-title",
  // Panels: the narrowest columns in the app, so the first to break.
  ".component-title",
  ".ap-body .agent-dir,\n.ap-body .agent-branch,\n.ap-body .share-branch",
  ".ticket-assignee",
  // Git — every string here comes out of a repository.
  ".ws-name",
  ".change-name",
];

/** Must not shrink: whatever the text does, these keep their size and stay on
 *  screen. This is the other half of the rule — text yields, controls don't. */
const MUST_HOLD = [
  ".resume-row > .btn,\n.resume-row > .btn-sm,\n.resume-row > .resume-forget",
];

describe("text containment", () => {
  it.each(MUST_TRUNCATE)("%s shrinks and ellipsises", (selector) => {
    const body = ruleBody(selector);
    // `min-width: 0` is the one that actually lets a flex child shrink; without
    // it the other two are decoration.
    expect(body, `${selector} needs min-width: 0`).toMatch(/min-width:\s*0/);
    expect(body, `${selector} needs an ellipsis`).toMatch(
      /text-overflow:\s*ellipsis/,
    );
    expect(body, `${selector} needs overflow: hidden`).toMatch(
      /overflow:\s*hidden/,
    );
    // A rigid flex defeats the min-width above, so the two can never co-exist.
    expect(
      /flex:\s*(0 0 auto|none)\b/.test(body),
      `${selector} is rigid — it cannot both refuse to shrink and truncate`,
    ).toBe(false);
  });

  it.each(MUST_HOLD)("%s keeps its size", (selector) => {
    expect(ruleBody(selector)).toMatch(/flex:\s*0 0 auto/);
  });

  // The tooltip is the one box in the app whose content is almost always a
  // path, and a path has no spaces — so `max-width` alone does nothing and the
  // string runs out through the border. `break-word` is not enough: it still
  // refuses to break a single unbroken token, which is exactly what a path is.
  // The chip carries the cap; the rule above carries the truncation. Split
  // like that on purpose, so both halves are pinned.
  it("caps the status branch chip", () => {
    expect(ruleBody(".status-branch")).toMatch(/max-width:\s*\d+ch/);
  });

  it("lets a path wrap inside the tooltip", () => {
    expect(ruleBody(".cnp-tooltip")).toMatch(/overflow-wrap:\s*anywhere/);
  });
});

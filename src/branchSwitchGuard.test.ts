// If this goes red, a new surface has started moving a ref on its own. Do not
// "fix" it by weakening the assertion or by adding an exemption — the point of
// the test is that there is exactly one place a ref can be moved from. Every
// name below has a way through `useBranchSwitch()`:
//
//   gitCheckout / gitCheckoutCarry  -> switchTo(repo, { kind: "branch", … })
//   gitCheckoutDetached             -> switchTo(repo, { kind: "ref", … })
//   ghPrCheckout                    -> switchTo(repo, { kind: "pr", … })
//   gitWorktreeAdd                  -> switchTo(repo, { kind: "workspace", … })
//   gitWorktreeAddPr                -> switchTo(repo, { kind: "pr-workspace", … })
//   gitBranchRelease / gitWorktreePrune
//                                   -> the "move it here" / "clear it" choices,
//                                      which the funnel runs for you
//
// Without this, nothing would fail if a new surface started toasting raw stderr
// again — which is how the eight divergent flows this replaces came about.
/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Vitest runs from the repo root; import.meta.url is not a file: URL here.
//
// The whole of `src`, not just `src/components`: a source that feeds the
// command palette, a hook, a store — none of them are components, and all of
// them could reach for a checkout as easily as a panel could.
const SRC = join(process.cwd(), "src");

/** Commands that move a ref or a workspace. A refusal from any of them is a
 *  question, and the only thing that can ask it is the funnel. */
const REF_MOVING = [
  "gitCheckout",
  "gitCheckoutDetached",
  "gitCheckoutCarry",
  "gitBranchRelease",
  "gitWorktreeAdd",
  "gitWorktreeAddPr",
  "gitWorktreePrune",
  "ghPrCheckout",
];

/** The funnel itself is the one place allowed to call these — that is the whole
 *  claim. `ipc.ts` declares them, and tests mock ipc wholesale rather than
 *  calling anything. */
const isExempt = (rel: string) =>
  rel === "useBranchSwitch.tsx" || rel === "ipc.ts" || /\.test\.tsx?$/.test(rel);

function sourceFiles(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...sourceFiles(join(dir, entry.name), rel));
    else if (/\.tsx?$/.test(entry.name) && !isExempt(rel)) out.push(rel);
  }
  return out;
}

describe("every route into a moving ref goes through the funnel", () => {
  it("finds no surface calling a ref-moving command for itself", () => {
    const offenders: string[] = [];
    for (const rel of sourceFiles(SRC)) {
      const text = readFileSync(join(SRC, rel), "utf8");
      for (const name of REF_MOVING)
        if (new RegExp(`\\b${name}\\b`).test(text))
          offenders.push(`${rel} calls ${name}`);
    }
    expect(offenders).toEqual([]);
  });
});

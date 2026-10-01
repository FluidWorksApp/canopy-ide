// A name the user typed on a tab is permanent. Nothing may take it away.
//
// It had been taken away by four different paths, which is why this is a guard
// and not four unit tests: the tab's rename is written in one place and read in
// a dozen, and every reader that reached for a different field was a way for the
// tab to rename itself back.
//
//   1. the rename itself deleted `customTitle` the moment native accepted the
//      name, leaving the choice recorded only in the session's `name` — which
//      dies with the pty, so a restart, a re-run or a wake renamed the tab;
//   2. surfaces that fall back to the OSC `title` when there is no
//      `customTitle` went back to showing whatever the CLI was painting, which
//      for an agent is a new string every few seconds;
//   3. `canopy_name_task` on a micro-task tab wrote the title unconditionally,
//      so the agent re-titled the tab every time its focus changed;
//   4. restoring a snapshot brought the name back but not the flag saying it
//      was chosen, so the first auto-namer after a wake overwrote it.
//
// ProjectView is fourteen thousand lines of React with no seam to render it
// through, so these are read off the source. Each assertion names the field and
// the invariant rather than a line, and stays true through any refactor that
// keeps the invariant.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dirname, "components", "ProjectView", "index.tsx");
const view = readFileSync(SRC, "utf8");
const helpers = readFileSync(
  join(import.meta.dirname, "components", "ProjectView", "helpers.ts"),
  "utf8",
);
const paneBar = readFileSync(
  join(import.meta.dirname, "components", "PaneBar.tsx"),
  "utf8",
);
const hibernation = readFileSync(
  join(import.meta.dirname, "hibernation.ts"),
  "utf8",
);

describe("a tab the user renamed keeps its name", () => {
  it("never clears the field that records the rename", () => {
    // `customTitle: undefined` was how the rename was thrown away — twice, on
    // commit and again on every respawn. There is no legitimate reason to blank
    // it: a user who wants the generated name back renames the tab to nothing,
    // which writes `undefined` through the same `chosen` value as any other
    // name, not through a literal.
    expect(view).not.toContain("customTitle: undefined");
  });

  it("re-asserts the chosen name onto each new session instead of taking the tab's", () => {
    // A respawned pty arrives with a generated name of its own. The tab's stored
    // choice has to be pushed back onto it; the tab must not adopt the pty's.
    expect(view).toContain("ipc\n                      .ptySetName(ptyId, tab.customTitle)");
  });

  it("asks mayAutoRename before every automatic title write", () => {
    // Two call sites in canopy_name_task — the ordinary tab and the micro-task
    // tab. The second one was the unguarded one. Both must ask.
    const writes = view.match(/customTitle:?\s*\n?\s*named\.title/g) ?? [];
    expect(writes.length).toBeGreaterThan(0);
    expect(view.match(/mayAutoRename\(tab\)/g)?.length).toBe(writes.length);
  });

  it("brings the chosen flag back with the name on restore", () => {
    // `customTitle` without `renamed` reads as an auto-generated name to every
    // namer, which is how a wake used to hand the tab back to the agent.
    for (const restore of view.match(/if \(t\.renamed && t\.title\)[\s\S]{0,200}?\);/g) ??
      []) {
      expect(restore).toContain("renamed: true");
    }
    expect(view.match(/if \(t\.renamed && t\.title\)/g)?.length).toBe(2);
  });

  it("puts the chosen name ahead of the session's and the terminal's in every label", () => {
    // `name ?? customTitle` is the wrong order: after a rename both hold it, but
    // only `customTitle` survives the session, and only `customTitle` is what
    // the user typed rather than native's deduplicated answer to it.
    for (const [file, text] of [
      ["ProjectView/index.tsx", view],
      ["ProjectView/helpers.ts", helpers],
      ["PaneBar.tsx", paneBar],
      ["hibernation.ts", hibernation],
    ] as const) {
      expect(text, `${file} must read customTitle before name`).not.toMatch(
        /\bname \?\? \w*\.?customTitle/,
      );
      expect(text, `${file} must read customTitle before title`).not.toMatch(
        /\btitle \?\? \w*\.?customTitle/,
      );
    }
  });
});

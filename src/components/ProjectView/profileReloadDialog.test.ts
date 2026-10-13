import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const source = readFileSync("src/components/ProjectView/index.tsx", "utf8");
const sidePanelStart = source.indexOf("  const sidePanel = (");
const sidePanel = source.slice(sidePanelStart, source.indexOf("\n  );\n", sidePanelStart));

// The side panel stays mounted while closed: overlay mode slides it off-screen
// (a transform anchors its fixed dialogs to it), docked mode collapses it to
// zero width, and zen and vibe never mount it. A confirmation asked by anything
// outside the panel is invisible there.
it("the account-switch reload confirmation is not rendered inside the side panel", () => {
  expect(sidePanelStart).toBeGreaterThan(0);
  expect(sidePanel).toContain('className="sidebar"');
  for (const title of ["Reload agents as", "Reopen every one of these?"]) {
    expect(sidePanel).not.toContain(title);
    expect(source.indexOf(title)).toBeGreaterThan(source.indexOf("<AgentCloseUndo"));
  }
});

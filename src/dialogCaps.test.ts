import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Every dialog surface is capped at --dialog-max-h (70% of the window), so no
// dialog can fill the screen and push its buttons out of reach.
const CAPPED: [file: string, selector: string][] = [
  ["src/index.css", ".dlg-panel {"],
  ["src/index.css", ".modal {"],
  ["src/index.css", ".confirm {"],
  ["src/index.css", ".confirm.settings-dialog {"],
  ["src/index.css", ".confirm.help-dialog {"],
  ["src/index.css", ".ask-dialog {"],
  ["src/components/chatCard.css", ".share-dialog{"],
  ["src/components/plans.css", ".plan-gate-dialog{"],
  ["src/sessionDoc/sessionDoc.css", ".sdoc{"],
];

describe("dialog height cap", () => {
  it("defines the cap at 70% of the window", () => {
    expect(readFileSync("src/index.css", "utf8")).toMatch(/--dialog-max-h:\s*70dvh/);
  });
  it.each(CAPPED)("%s %s is capped", (file, selector) => {
    const css = readFileSync(file, "utf8");
    const at = css.indexOf(selector);
    expect(at, `${selector} missing`).toBeGreaterThanOrEqual(0);
    const rule = css.slice(at, css.indexOf("}", at));
    expect(rule).toContain("var(--dialog-max-h)");
  });
  it("no dialog selector is capped by 80vh, 90vh, 100vh or the whole window", () => {
    for (const f of ["src/remoteExecution/workspace.css", "src/components/chatCard.css", "src/components/plans.css"]) {
      expect(readFileSync(f, "utf8")).not.toMatch(/max-height:\s*calc\(100d?vh/);
    }
  });
});

import { describe, expect, it } from "vitest";
import { receiptMarkdown, receiptOneLine, tellAgentMessage } from "./markdown";
import { sampleReceipt } from "./fixtures";

describe("receipt markdown", () => {
  const r = sampleReceipt();
  it("puts status, asked/did, the claim, every check and the flags in the copy", () => {
    const md = receiptMarkdown(r);
    expect(md).toContain("Workspace verification receipt: ✗ Contradicted");
    expect(md).toContain("**Asked:** Make sum add its two numbers.");
    expect(md).toContain("**Did:** Changed subtraction to addition");
    expect(md).toContain("**Agent says:** Fixed it");
    expect(md).toContain("`npm run test` failed — 11 passed, 1 failed (4.2s, exit 1)");
    expect(md).toContain("`src/sum.test.ts`: 1 assertion was removed or rewritten.");
    expect(md).toContain("left-padz (UNKNOWN — not on the registry)");
    expect(md).toContain("The failing test was the one the agent edited.");
  });

  it("collapses to one line for a PTY brief", () => {
    const line = receiptOneLine(r);
    expect(line).not.toContain("\n");
    expect(line).toContain("✗ Contradicted");
    expect(line).toContain("tests changed by the agent: src/sum.test.ts");
    expect(line).toContain("unknown packages: left-padz");
  });

  it("tells the agent only facts, on one line", () => {
    const msg = tellAgentMessage(r);
    expect(msg).not.toContain("\n");
    expect(msg).toMatch(/^Workspace verification \(re-run by Canopy, not by you\): npm run test failed \(1 failing: src\/sum.test.ts > adds\); src\/sum.test.ts was modified/);
    expect(msg).toContain('package "left-padz" does not exist on the npm registry');
  });
});

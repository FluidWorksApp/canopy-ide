import { beforeEach, describe, expect, it } from "vitest";
import { raisePrTask } from "../microTasks";
import { resetReceiptsForTests, setReceipt } from "./store";
import { sampleReceipt } from "./fixtures";

describe("receipts travel with Raise PR", () => {
  beforeEach(() => resetReceiptsForTests());

  it("asks for the branch's latest receipt verbatim in the PR body, on one line", () => {
    setReceipt(sampleReceipt());
    const brief = raisePrTask.buildContext({ repo: "/repo", branch: "feat/sum" }, "");
    expect(brief).not.toContain("\n");
    expect(brief).toContain('"## Verification receipt"');
    expect(brief).toContain("verbatim");
    expect(brief).toContain("✗ Contradicted");
    expect(brief).toContain("`npm run test` failed");
  });

  it("adds nothing when the branch has no receipt", () => {
    setReceipt(sampleReceipt({ branch: "other", cwd: "/elsewhere", root: "/elsewhere" }));
    const brief = raisePrTask.buildContext({ repo: "/repo", branch: "feat/sum" }, "");
    expect(brief).not.toContain("Verification receipt");
  });
});

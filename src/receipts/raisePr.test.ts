import { beforeEach, describe, expect, it, vi } from "vitest";

const queryLedger = vi.fn();
vi.mock("../ledger", async (orig) => ({ ...(await orig<typeof import("../ledger")>()), queryLedger: (...a: unknown[]) => queryLedger(...a) }));

import { raisePrTask } from "../microTasks";
import { resetReceiptsForTests, setReceipt } from "./store";
import { sampleReceipt } from "./fixtures";

describe("receipts travel with Raise PR", () => {
  beforeEach(() => {
    resetReceiptsForTests();
    queryLedger.mockReset();
  });

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

  it("finds the branch's receipt in the ledger after a restart", async () => {
    const { id, ts, root, ...data } = sampleReceipt();
    queryLedger.mockResolvedValue([{ id, ts, root, kind: "receipt", author: { kind: "workspace", name: "receipts" }, scope: "project", data }]);
    expect(raisePrTask.buildContext({ repo: "/repo", branch: "feat/sum" }, "")).not.toContain("Verification receipt");
    await raisePrTask.prepare!({ repo: "/repo", branch: "feat/sum" });
    expect(queryLedger).toHaveBeenCalledWith("/repo", expect.objectContaining({ kinds: ["receipt"] }));
    expect(raisePrTask.buildContext({ repo: "/repo", branch: "feat/sum" }, "")).toContain("✗ Contradicted");
  });
});

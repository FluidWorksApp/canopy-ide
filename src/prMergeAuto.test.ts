import { describe, expect, it } from "vitest";
import { offersAutoMerge } from "./prMergeAuto";

describe("offersAutoMerge", () => {
  it("matches gh's base-branch-policy refusal that names --auto", () => {
    const gh =
      "X Pull request org/repo#572 is not mergeable: the base branch policy prohibits the merge.\nTo have the pull request merged after all the requirements have been met, add the `--auto` flag.\nTo use administrator privileges to immediately merge the pull request, add the `--admin` flag.";
    expect(offersAutoMerge(gh)).toBe(true);
    expect(offersAutoMerge(new Error(gh))).toBe(true);
  });
  it("does not match other merge failures", () => {
    expect(offersAutoMerge("Pull request is not mergeable: merge conflicts")).toBe(false);
    expect(offersAutoMerge("Required status checks are failing")).toBe(false);
    expect(offersAutoMerge("the base branch policy prohibits the merge")).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { repoLabel } from "./prs";

describe("repoLabel", () => {
  it("reads owner/name out of every shape of origin URL", () => {
    const want = "FluidWorksApp/canopy-ide";
    expect(repoLabel("git@github.com:FluidWorksApp/canopy-ide.git", "/x")).toBe(want);
    expect(repoLabel("https://github.com/FluidWorksApp/canopy-ide.git", "/x")).toBe(want);
    expect(repoLabel("https://github.com/FluidWorksApp/canopy-ide", "/x")).toBe(want);
    expect(repoLabel("ssh://git@github.com/FluidWorksApp/canopy-ide.git", "/x")).toBe(want);
    // A trailing slash is not a third segment.
    expect(repoLabel("https://github.com/FluidWorksApp/canopy-ide/", "/x")).toBe(want);
  });

  it("keeps only the last two segments of a nested path", () => {
    // Self-hosted GitLab-style groups: the project is still owner/name.
    expect(repoLabel("https://git.acme.com/team/group/svc.git", "/x")).toBe("group/svc");
  });

  it("falls back to the checkout's folder when there is no remote", () => {
    expect(repoLabel("", "/Users/me/Documents/GitHub/canopy")).toBe("canopy");
    expect(repoLabel("", "/Users/me/code/canopy/")).toBe("canopy");
  });
});

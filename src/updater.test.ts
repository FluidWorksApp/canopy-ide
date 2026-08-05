import { describe, expect, it } from "vitest";
import { releaseHighlights, releaseUrlFor } from "./updater";

describe("release notes", () => {
  it("turns GitHub markdown into concise card highlights", () => {
    expect(
      releaseHighlights("## Highlights\n- **Faster** previews\n- [Safer updates](https://example.com)\n\nFull changelog:"),
    ).toEqual(["Faster previews", "Safer updates"]);
  });

  it("builds a canonical GitHub release URL", () => {
    expect(releaseUrlFor("v0.3.4")).toBe(
      "https://github.com/FluidWorksApp/canopy-ide/releases/tag/v0.3.4",
    );
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const projectView = readFileSync(
  join(process.cwd(), "src/components/ProjectView/index.tsx"),
  "utf8",
);

describe("Build session component identity", () => {
  it("memoizes worktree-mapped components before constructing the session", () => {
    const components = projectView.indexOf("const components = useMemo(");
    const session = projectView.indexOf("const vibeSession = useMemo(");

    expect(components).toBeGreaterThan(-1);
    expect(session).toBeGreaterThan(components);
    expect(projectView.slice(components, session)).toContain(
      "[project.components, worktreeEnv]",
    );
  });
});

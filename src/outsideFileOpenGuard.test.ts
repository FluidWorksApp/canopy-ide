/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const projectView = readFileSync(join(process.cwd(), "src/components/ProjectView/index.tsx"), "utf8");
const openFileNow = projectView.slice(
  projectView.indexOf("const openFileNow = useCallback("),
  projectView.indexOf("// Proper diff for changed files"),
);

describe("opening a file outside the project", () => {
  it("every open asks for that one file in openFileNow, not per click site", () => {
    expect(openFileNow).toContain("ipc.fsGrantLinkFile(path)");
    expect(openFileNow).toMatch(/includes\("outside"\)\) throw err/);
  });

  it("no longer shows the dead-end 'outside this project' message", () => {
    expect(projectView).not.toContain("it's outside this project's folders.");
  });

  it("a failed image staging still opens the clicked file", () => {
    expect(projectView).toContain(".then(([staged]) => staged ?? path, () => path)");
  });
});

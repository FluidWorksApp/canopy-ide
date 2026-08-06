/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(process.cwd(), "src/projectRunner.ts"), "utf8");

describe("the project runner is not Companion-owned", () => {
  it("does not import Companion singleton state or IPC", () => {
    for (const forbidden of [
      'from "./companion"',
      'from "./companionSession"',
      'from "./settings"',
      'from "./ipc"',
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });

  it("keys native process operations by attempt id", () => {
    expect(source).toContain("spawn(\n    attemptId: string");
    expect(source).toContain("write(attemptId: string");
    expect(source).toContain("kill(attemptId: string");
    expect(source).toContain("if (!attemptId)");
  });
});

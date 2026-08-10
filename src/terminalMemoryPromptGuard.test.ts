import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const app = read("src/App.tsx");
const projectView = read("src/components/ProjectView/index.tsx");
const settings = read("src/settings.ts");
const dialog = read("src/components/SettingsDialog.tsx");

describe("terminal memory prompt feature gate", () => {
  it("defaults on and is exposed in Settings", () => {
    expect(settings).toContain("terminalMemoryPromptsEnabled: true");
    expect(dialog).toContain("checked={s.terminalMemoryPromptsEnabled}");
    expect(dialog).toContain("Monitoring continues silently");
  });

  it("gates both automatic memory surfaces through the same visibility store", () => {
    expect(app).toContain("const pendingGovernor = showTerminalMemoryPrompts");
    expect(projectView).toContain("showTerminalMemoryPrompts");
    expect(projectView).toContain("? terminalMemoryQuotaWarning(");
    expect(projectView).toContain(": null,");
  });

  it("makes either dismiss action suppress prompts for the current window", () => {
    expect(app).toContain("dismissTerminalMemoryPromptsForWindow();");
    expect(projectView).toContain("dismissTerminalMemoryPromptsForWindow();");
  });
});

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  documentResourceActive,
  shouldReuseInactiveDocumentPane,
} from "./documentResourceActive";

describe("inactive document resource lifecycle wiring", () => {
  it("propagates active transitions through the pane cache", () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), "src/components/ProjectView/index.tsx"),
      "utf8",
    );
    expect(source).toContain(
      "shouldReuseInactiveDocumentPane(cached, tab, active)",
    );
    expect(source).toContain(
      "documentResourceActive(tab.id, surfaceTabId, visible)",
    );
    expect(source).toContain("docTabView(tab, active)");
    expect(source).toContain("<FileView\n            active={active}");
    expect(source).toContain('modelOwnerId={`${project.id}:${tab.id}`}');
    expect(source).toContain("closeEditorModelOwner(");
    expect(source).toContain("for (const session of shared.current.values())");
    expect(source).toContain("for (const tab of tabsRef.current)");
    expect(source).toContain("<CollabView");
    expect(source).toContain("active={active}");
  });

  it("follows the presented Build/Engineer surface instead of activeTabId", () => {
    const engineerTab = "file:engineer";
    const buildPreview = "preview:build";
    expect(documentResourceActive(engineerTab, buildPreview, true)).toBe(false);
    expect(documentResourceActive(buildPreview, buildPreview, true)).toBe(true);
    expect(documentResourceActive(buildPreview, buildPreview, false)).toBe(false);
    expect(documentResourceActive(engineerTab, engineerTab, true)).toBe(true);
  });

  it("never freezes changing props behind a cached active element", () => {
    const stableTab = { id: "preview:one" };
    expect(
      shouldReuseInactiveDocumentPane(
        { tab: stableTab, active: true },
        stableTab,
        true,
      ),
    ).toBe(false);
    expect(
      shouldReuseInactiveDocumentPane(
        { tab: stableTab, active: false },
        stableTab,
        true,
      ),
    ).toBe(false);
  });

  it("reuses only stable inactive panes and invalidates transitions/data", () => {
    const stableTab = { id: "file:one" };
    expect(
      shouldReuseInactiveDocumentPane(
        { tab: stableTab, active: false },
        stableTab,
        false,
      ),
    ).toBe(true);
    expect(
      shouldReuseInactiveDocumentPane(
        { tab: stableTab, active: true },
        stableTab,
        false,
      ),
    ).toBe(false);
    expect(
      shouldReuseInactiveDocumentPane(
        { tab: stableTab, active: false },
        { id: "file:one" },
        false,
      ),
    ).toBe(false);
  });

  it("releases inactive file-view children and Monaco instances", () => {
    const fileView = fs.readFileSync(
      path.resolve(process.cwd(), "src/components/FileView.tsx"),
      "utf8",
    );
    const monaco = fs.readFileSync(
      path.resolve(process.cwd(), "src/components/MonacoEditor.tsx"),
      "utf8",
    );
    expect(fileView).toContain("if (!props.active)");
    expect(fileView).toContain("props.active && file.bytes");
    expect(fileView).toContain("props.modelOwnerId ?? localOwnerId");
    expect(fileView).toContain("closeEditorModelOwner(");
    expect(monaco).toContain("if (!active) return");
    expect(monaco).toContain("editor.dispose()");
    expect(monaco).toContain("rememberEditorViewState");
  });
});

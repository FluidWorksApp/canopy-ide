import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLAUDE_IDE_MARKER,
  EMPTY_STATE,
  applyClaudeIdeEvent,
  claudeIdeLaunchEnv,
  claudeIdeRoot,
  claudeIdeState,
  debounced,
  diffsForPtys,
  dismissClaudeDiff,
  hasSessionFor,
  markersToDiagnostics,
  mentionLines,
  pathOfFileUri,
  reduceClaudeIde,
  resetClaudeIdeForTest,
  selectionParams,
  type ClaudeIdeEvent,
  type ClaudeIdeState,
} from "./claudeIde";
import { installHost } from "./host";
import type { Host } from "./host/contract";
import { getSettings, updateSettings } from "./settings";

afterEach(() => {
  localStorage.clear();
  resetClaudeIdeForTest();
});

describe("the setting", () => {
  it("is on by default and a stored choice wins", () => {
    expect(getSettings().claudeIdeIntegration).toBe(true);
    updateSettings({ claudeIdeIntegration: false });
    expect(getSettings().claudeIdeIntegration).toBe(false);
  });
});

describe("claudeIdeLaunchEnv", () => {
  const claude = { command: "claude --permission-mode default", root: "/w/app" };

  it("asks for a server for an interactive Claude Code tab, naming its component", () => {
    expect(claudeIdeLaunchEnv(claude)).toEqual([[CLAUDE_IDE_MARKER, "/w/app"]]);
    // A rebound binary by path is still Claude Code.
    expect(claudeIdeLaunchEnv({ command: "/opt/bin/claude", root: "/w" })).toEqual([
      [CLAUDE_IDE_MARKER, "/w"],
    ]);
  });

  it("scopes a worktree session to the worktree, not the component beside it", () => {
    expect(claudeIdeRoot("/w/app", "/w/app/packages/ui")).toBe("/w/app");
    expect(claudeIdeRoot("/w/app/", "/w/app")).toBe("/w/app");
    expect(claudeIdeRoot("/w/app", "/w/app-wt-fix-login")).toBe("/w/app-wt-fix-login");
    expect(claudeIdeRoot(undefined, "/w/scratch")).toBe("/w/scratch");
    expect(
      claudeIdeLaunchEnv({ command: "claude", root: "/w/app", cwd: "/w/app-wt-x" }),
    ).toEqual([[CLAUDE_IDE_MARKER, "/w/app-wt-x"]]);
  });

  it("adds nothing when the setting is off", () => {
    updateSettings({ claudeIdeIntegration: false });
    expect(claudeIdeLaunchEnv(claude)).toEqual([]);
  });

  it("leaves every other CLI on Canopy's MCP editor tools", () => {
    for (const command of ["codex", "gemini", "opencode", "claude-utils run", "bash"]) {
      expect(claudeIdeLaunchEnv({ command, root: "/w" }), command).toEqual([]);
    }
  });

  it("never wires a run tab, a micro-task or a headless print run", () => {
    // A run tab or micro-task hands its command to the shell as runCommand.
    expect(claudeIdeLaunchEnv({ ...claude, runCommand: "claude -p hi" })).toEqual([]);
    expect(claudeIdeLaunchEnv({ command: "claude -p 'say hi'", root: "/w" })).toEqual([]);
    expect(claudeIdeLaunchEnv({ command: "claude --print x", root: "/w" })).toEqual([]);
    expect(claudeIdeLaunchEnv({ root: "/w" })).toEqual([]);
  });

  it("gives the phone portal no env at all", () => {
    // The portal drives the desktop's own terminals from another screen; the
    // window that would show their diffs is not the one in front of the user.
    const uninstall = installHost({
      kind: "socket",
      invoke: vi.fn(),
      listen: vi.fn(),
      channel: vi.fn(),
    } as unknown as Host);
    try {
      expect(claudeIdeLaunchEnv(claude)).toEqual([]);
    } finally {
      uninstall();
    }
  });

  it("asks a remote workspace for a server on the VM, beside claude", () => {
    // The workspace host turns the marker into a /sessions request field;
    // packages/remote-host/claude-ide.mjs serves it in claude's PID namespace.
    const uninstall = installHost({
      kind: "socket",
      invoke: vi.fn(),
      invokeDesktop: vi.fn(),
      listen: vi.fn(),
      channel: vi.fn(),
    } as unknown as Host);
    try {
      expect(claudeIdeLaunchEnv({ command: "claude", root: "/workspace/projects/app" })).toEqual([
        [CLAUDE_IDE_MARKER, "/workspace/projects/app"],
      ]);
      expect(claudeIdeLaunchEnv({ command: "claude -p hi", root: "/workspace/projects/app" })).toEqual([]);
    } finally {
      uninstall();
    }
  });
});

describe("reduceClaudeIde", () => {
  const diff = (ptyId: number, tabName: string): ClaudeIdeEvent => ({
    kind: "diff",
    ptyId,
    tabName,
    path: "/w/a.ts",
    contents: `proposed by ${ptyId}`,
  });
  const run = (...events: ClaudeIdeEvent[]): ClaudeIdeState =>
    events.reduce(reduceClaudeIde, EMPTY_STATE);

  it("keeps each pending diff until the CLI closes it, however often it says so", () => {
    let state = run(diff(1, "a"), diff(1, "b"), diff(2, "a"));
    expect(state.diffs.map((d) => `${d.ptyId}:${d.tabName}`)).toEqual(["1:a", "1:b", "2:a"]);
    // close_tab arrives twice; the second finds nothing and changes nothing.
    state = reduceClaudeIde(state, { kind: "diffClosed", ptyId: 1, tabName: "a" });
    const again = reduceClaudeIde(state, { kind: "diffClosed", ptyId: 1, tabName: "a" });
    expect(again).toBe(state);
    expect(state.diffs.map((d) => `${d.ptyId}:${d.tabName}`)).toEqual(["1:b", "2:a"]);
    // closeAllDiffTabs is per session.
    state = reduceClaudeIde(state, { kind: "diffsCleared", ptyId: 1 });
    expect(state.diffs.map((d) => `${d.ptyId}:${d.tabName}`)).toEqual(["2:a"]);
  });

  it("replaces a diff reopened under the same name", () => {
    const state = run(diff(1, "a"), { ...diff(1, "a"), contents: "second" } as ClaudeIdeEvent);
    expect(state.diffs).toEqual([{ ptyId: 1, tabName: "a", path: "/w/a.ts", proposed: "second" }]);
  });

  it("tracks connections and drops a dropped session's diffs with it", () => {
    let state = run(
      { kind: "connection", ptyId: 1, root: "/w/app", connected: true },
      { kind: "connection", ptyId: 2, root: "/w/lib", connected: true },
      diff(1, "a"),
      diff(2, "b"),
    );
    expect([...state.connections]).toEqual([
      [1, "/w/app"],
      [2, "/w/lib"],
    ]);
    state = reduceClaudeIde(state, { kind: "connection", ptyId: 1, root: "/w/app", connected: false });
    expect([...state.connections.keys()]).toEqual([2]);
    expect(state.diffs.map((d) => d.ptyId)).toEqual([2]);
  });

  it("shows a project only the diffs its own terminals opened", () => {
    const state = run(diff(1, "a"), diff(2, "b"), diff(3, "c"));
    expect(diffsForPtys(state, new Set([1, 3])).map((d) => d.tabName)).toEqual(["a", "c"]);
  });

  it("is what the store applies, and answering here dismisses at once", () => {
    applyClaudeIdeEvent(diff(4, "x"));
    expect(claudeIdeState().diffs).toHaveLength(1);
    dismissClaudeDiff(4, "x");
    expect(claudeIdeState().diffs).toHaveLength(0);
    // A diagnostics request is a round trip, not state.
    const before = claudeIdeState();
    applyClaudeIdeEvent({ kind: "diagnostics", requestId: 1, ptyId: 4, root: "/w", uri: null });
    expect(claudeIdeState()).toBe(before);
  });
});

describe("selection on the wire", () => {
  it("is 0-based with the selected text", () => {
    expect(
      selectionParams(
        "/w/hello.py",
        { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 19 },
        '    return "hello"',
      ),
    ).toEqual({
      text: '    return "hello"',
      filePath: "/w/hello.py",
      fileUrl: "file:///w/hello.py",
      selection: { start: { line: 1, character: 0 }, end: { line: 1, character: 18 }, isEmpty: false },
    });
  });

  it("sends an empty selection, never null, for a file that is merely open", () => {
    const params = selectionParams(
      "/w/my file.py",
      { startLineNumber: 3, startColumn: 5, endLineNumber: 3, endColumn: 5 },
      "ignored",
    );
    expect(params.text).toBe("");
    expect(params.selection).toEqual({
      start: { line: 2, character: 4 },
      end: { line: 2, character: 4 },
      isEmpty: true,
    });
    expect(params.fileUrl).toBe("file:///w/my%20file.py");
  });

  it("caps a huge selection", () => {
    const params = selectionParams(
      "/w/big.txt",
      { startLineNumber: 1, startColumn: 1, endLineNumber: 9, endColumn: 1 },
      "x".repeat(200_000),
    );
    expect(params.text.length).toBe(100_000);
  });

  it("only bothers when a connected session works on the file", () => {
    const state = reduceClaudeIde(EMPTY_STATE, {
      kind: "connection",
      ptyId: 1,
      root: "/w/app/",
      connected: true,
    });
    expect(hasSessionFor(state, "/w/app/src/a.ts")).toBe(true);
    expect(hasSessionFor(state, "/w/app")).toBe(true);
    expect(hasSessionFor(state, "/w/application/a.ts")).toBe(false);
    expect(hasSessionFor(EMPTY_STATE, "/w/app/src/a.ts")).toBe(false);
  });

  it("is debounced to where the caret settles", () => {
    vi.useFakeTimers();
    try {
      const sent: number[] = [];
      const send = debounced((n: number) => sent.push(n), 150);
      send(1);
      send(2);
      vi.advanceTimersByTime(100);
      send(3);
      vi.advanceTimersByTime(149);
      expect(sent).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(sent).toEqual([3]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Add to Claude lines", () => {
  it("are 0-based and inclusive", () => {
    expect(mentionLines({ startLineNumber: 1, startColumn: 1, endLineNumber: 2, endColumn: 4 })).toEqual({
      lineStart: 0,
      lineEnd: 1,
    });
  });

  it("drop a last line selected only up to its first column", () => {
    expect(mentionLines({ startLineNumber: 3, startColumn: 1, endLineNumber: 5, endColumn: 1 })).toEqual({
      lineStart: 2,
      lineEnd: 3,
    });
  });

  it("mention the whole file when nothing is selected", () => {
    expect(mentionLines({ startLineNumber: 3, startColumn: 2, endLineNumber: 3, endColumn: 2 })).toBeNull();
    expect(mentionLines(null)).toBeNull();
  });
});

describe("diagnostics", () => {
  it("are Monaco markers in the CLI's shape: 0-based, string severity", () => {
    expect(
      markersToDiagnostics([
        { severity: 8, message: "boom", source: "ts", code: "2304", startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 5 },
        { severity: 4, message: "meh", code: { value: "no-unused" }, startLineNumber: 1, startColumn: 3, endLineNumber: 1, endColumn: 4 },
        { severity: 2, message: "fyi", startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
        { severity: 1, message: "hint", startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
      ]),
    ).toEqual([
      { message: "boom", severity: "Error", source: "ts", code: "2304", range: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } } },
      { message: "meh", severity: "Warning", code: "no-unused", range: { start: { line: 0, character: 2 }, end: { line: 0, character: 3 } } },
      { message: "fyi", severity: "Info", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } },
      { message: "hint", severity: "Hint", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } },
    ]);
  });

  it("name files by the path in their file:// URI", () => {
    expect(pathOfFileUri("file:///w/a%20b.ts")).toBe("/w/a b.ts");
    expect(pathOfFileUri("file:///C:/w/a.ts")).toBe("C:/w/a.ts");
    expect(pathOfFileUri("_claude_fs_right:/w/a.ts")).toBeNull();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyClaudeIdeEvent, noteActiveTerminal, resetClaudeIdeForTest } from "./claudeIde";

const mocks = vi.hoisted(() => ({
  selection: vi.fn(async () => 1),
  mention: vi.fn(async (_opts: unknown) => 3),
  post: vi.fn(),
}));
vi.mock("./ipc", () => ({
  claudeIdeSelection: mocks.selection,
  claudeIdeAtMention: mocks.mention,
}));
vi.mock("./attention", () => ({ postAttention: mocks.post }));
vi.mock("./agentOps", () => ({ prime: vi.fn() }));
vi.mock("./monaco-setup", () => ({
  monaco: {
    Range: class {
      constructor(
        public startLineNumber: number,
        public startColumn: number,
        public endLineNumber: number,
        public endColumn: number,
      ) {}
    },
  },
}));

import { CLAUDE_MENTIONED_EVENT, addToClaude, noteEditorSelection } from "./claudeIdeBridge";
import type { monaco } from "./monaco-setup";

const model = (path: string, scheme = "file") =>
  ({
    uri: { scheme, path },
    getValueInRange: () => '    return "hello"',
  }) as unknown as monaco.editor.ITextModel;

const line2 = { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 19 };

beforeEach(() => {
  vi.useFakeTimers();
  applyClaudeIdeEvent({ kind: "connection", ptyId: 3, root: "/w/app", connected: true });
});
afterEach(() => {
  vi.useRealTimers();
  resetClaudeIdeForTest();
  vi.clearAllMocks();
});

describe("noteEditorSelection", () => {
  it("sends where the selection settled to the sessions on that file", () => {
    noteEditorSelection(model("/w/app/hello.py"), { ...line2, endColumn: 5 });
    noteEditorSelection(model("/w/app/hello.py"), line2);
    vi.advanceTimersByTime(200);
    expect(mocks.selection).toHaveBeenCalledTimes(1);
    expect(mocks.selection).toHaveBeenCalledWith("/w/app/hello.py", {
      text: '    return "hello"',
      filePath: "/w/app/hello.py",
      fileUrl: "file:///w/app/hello.py",
      selection: { start: { line: 1, character: 0 }, end: { line: 1, character: 18 }, isEmpty: false },
    });
  });

  it("stays quiet for files no Claude session works on, and for scratch models", () => {
    noteEditorSelection(model("/elsewhere/x.py"), line2);
    noteEditorSelection(model("/w/app/hello.py", "claude-diff"), line2);
    vi.advanceTimersByTime(200);
    expect(mocks.selection).not.toHaveBeenCalled();
  });
});

describe("addToClaude", () => {
  it("mentions the selected lines, preferring the terminal last in front, and brings it forward", async () => {
    noteActiveTerminal(3);
    const brought = vi.fn();
    window.addEventListener(CLAUDE_MENTIONED_EVENT, (e) => brought((e as CustomEvent).detail));
    expect(await addToClaude(model("/w/app/hello.py"), { startLineNumber: 1, startColumn: 1, endLineNumber: 2, endColumn: 4 })).toBeNull();
    expect(mocks.mention).toHaveBeenCalledWith({ path: "/w/app/hello.py", lineStart: 0, lineEnd: 1, prefer: 3 });
    expect(brought).toHaveBeenCalledWith({ ptyId: 3 });
  });

  it("mentions the whole file with no selection", async () => {
    await addToClaude(model("/w/app/hello.py"), null);
    expect(mocks.mention).toHaveBeenCalledWith(expect.not.objectContaining({ lineStart: expect.anything() }));
  });

  it("explains instead of failing silently when no session can take it", async () => {
    expect(await addToClaude(model("/other/x.py"), null)).toMatch(/No Claude Code session/);
    expect(mocks.mention).not.toHaveBeenCalled();
  });
});

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyClaudeIdeEvent, claudeIdeState, resetClaudeIdeForTest } from "../claudeIde";

// A model just real enough for the scratch side: value, change events, dispose.
const mocks = vi.hoisted(() => {
  const models = new Map<string, FakeModel>();
  class FakeModel {
    listeners = new Set<() => void>();
    disposed = false;
    value: string;
    key: string;
    constructor(value: string, key: string) {
      this.value = value;
      this.key = key;
    }
    getValue() {
      return this.value;
    }
    setValue(v: string) {
      this.value = v;
      for (const l of this.listeners) l();
    }
    onDidChangeContent(l: () => void) {
      this.listeners.add(l);
      return { dispose: () => this.listeners.delete(l) };
    }
    dispose() {
      this.disposed = true;
      models.delete(this.key);
    }
  }
  return { models, FakeModel, resolve: vi.fn(async () => {}) };
});

vi.mock("../monaco-setup", () => {
  const uri = (key: string) => ({ toString: () => key });
  return {
    languageForPath: () => "python",
    monaco: {
      Uri: {
        file: (p: string) => uri(`file://${p}`),
        from: (c: { scheme: string; path: string; query: string }) =>
          uri(`${c.scheme}://${c.path}?${c.query}`),
      },
      editor: {
        getModel: (u: { toString(): string }) => mocks.models.get(u.toString()) ?? null,
        createModel: (value: string, _lang: string, u: { toString(): string }) => {
          const m = new mocks.FakeModel(value, u.toString());
          mocks.models.set(u.toString(), m);
          return m;
        },
      },
    },
  };
});
vi.mock("../boundedFileRead", () => ({
  readBoundedFile: async () => new TextEncoder().encode('def greet():\n    return "hello"\n'),
}));
vi.mock("../ipc", () => ({ claudeIdeResolveDiff: mocks.resolve }));
// The diff renderer and the editor are their own components with their own
// tests; here they only need to show what they were given.
vi.mock("./DiffView", () => ({
  DiffView: (p: { title: string; original: string; modified: string; actions: { label: string; onClick(): void }[] }) => (
    <div>
      <div data-testid="title">{p.title}</div>
      <pre data-testid="original">{p.original}</pre>
      <pre data-testid="modified">{p.modified}</pre>
      {p.actions.map((a) => (
        <button key={a.label} onClick={a.onClick}>
          {a.label}
        </button>
      ))}
    </div>
  ),
}));
vi.mock("./MonacoEditor", () => ({
  MonacoEditor: (p: { model: { getValue(): string; setValue(v: string): void } }) => (
    <textarea
      data-testid="editor"
      defaultValue={p.model.getValue()}
      onChange={(e) => p.model.setValue(e.target.value)}
    />
  ),
}));

import { ClaudeDiffDock } from "./ClaudeDiffDock";

const TAB = "✻ [Claude Code] hello.py (84bf2c) ⧉";
const proposed = 'def greet():\n    return "howdy"\n';

function openDiff(ptyId = 7, tabName = TAB) {
  act(() =>
    applyClaudeIdeEvent({ kind: "diff", ptyId, tabName, path: "/w/hello.py", contents: proposed }),
  );
}

afterEach(() => {
  cleanup();
  resetClaudeIdeForTest();
  mocks.resolve.mockClear();
  mocks.models.clear();
});

describe("ClaudeDiffDock", () => {
  it("shows the file as it is against Claude's proposal, titled by tab_name", async () => {
    render(<ClaudeDiffDock ptyIds={[7]} onNotice={vi.fn()} />);
    openDiff();
    expect(await screen.findByTestId("original")).toHaveTextContent('return "hello"');
    expect(screen.getByTestId("modified")).toHaveTextContent('return "howdy"');
    expect(screen.getByTestId("title")).toHaveTextContent(TAB);
  });

  it("only shows diffs from this project's own terminals", () => {
    const { container } = render(<ClaudeDiffDock ptyIds={[1, 2]} onNotice={vi.fn()} />);
    openDiff(7);
    expect(container).toBeEmptyDOMElement();
  });

  it("accepts with the proposal, then gets out of the way", async () => {
    render(<ClaudeDiffDock ptyIds={[7]} onNotice={vi.fn()} />);
    openDiff();
    fireEvent.click(await screen.findByText("Accept"));
    await waitFor(() => expect(mocks.resolve).toHaveBeenCalledWith(7, TAB, true, proposed));
    await waitFor(() => expect(claudeIdeState().diffs).toHaveLength(0));
  });

  it("accepts what the user typed on the right-hand side", async () => {
    render(<ClaudeDiffDock ptyIds={[7]} onNotice={vi.fn()} />);
    openDiff();
    fireEvent.click(await screen.findByText("Edit proposal"));
    const edited = `${proposed}# tweaked\n`;
    fireEvent.change(screen.getByTestId("editor"), { target: { value: edited } });
    fireEvent.click(screen.getByText("Show diff"));
    expect(screen.getByTestId("modified")).toHaveTextContent("# tweaked");
    fireEvent.click(screen.getByText("Accept edited"));
    await waitFor(() => expect(mocks.resolve).toHaveBeenCalledWith(7, TAB, true, edited));
  });

  it("rejects without contents", async () => {
    render(<ClaudeDiffDock ptyIds={[7]} onNotice={vi.fn()} />);
    openDiff();
    fireEvent.click(await screen.findByText("Reject"));
    await waitFor(() => expect(mocks.resolve).toHaveBeenCalledWith(7, TAB, false, undefined));
  });

  it("closes when the CLI does (answered in the terminal), and drops its scratch model", async () => {
    const { container } = render(<ClaudeDiffDock ptyIds={[7]} onNotice={vi.fn()} />);
    openDiff();
    await screen.findByTestId("original");
    expect(mocks.models.size).toBe(1);
    act(() => applyClaudeIdeEvent({ kind: "diffClosed", ptyId: 7, tabName: TAB }));
    expect(container).toBeEmptyDOMElement();
    expect(mocks.models.size).toBe(0);
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it("says so when the terminal won the race", async () => {
    mocks.resolve.mockRejectedValueOnce(new Error("Claude Code is no longer waiting on this change"));
    const notice = vi.fn();
    render(<ClaudeDiffDock ptyIds={[7]} onNotice={notice} />);
    openDiff();
    fireEvent.click(await screen.findByText("Accept"));
    await waitFor(() => expect(notice).toHaveBeenCalledWith(expect.stringMatching(/terminal/), "info"));
    await waitFor(() => expect(claudeIdeState().diffs).toHaveLength(0));
  });

  it("hiding is not an answer", async () => {
    const { container } = render(<ClaudeDiffDock ptyIds={[7]} onNotice={vi.fn()} />);
    openDiff();
    fireEvent.click(await screen.findByText("Hide"));
    expect(container).toBeEmptyDOMElement();
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(claudeIdeState().diffs).toHaveLength(1);
  });
});

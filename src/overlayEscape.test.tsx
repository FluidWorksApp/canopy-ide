import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { useEffect, useRef, useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { terminalKeyBlocked, useEscape, useEscapeBackstop, useEscapeLayer } from "./useEscape";
import { Dialog } from "./components/Dialog";
import { WorkspacePanel } from "./remoteExecution/WorkspacePanel";

// The bug: with a popup open, Escape (pressed to close it) went to the agent
// CLI in the terminal behind it — and to Claude Code, Escape is "interrupt".
// These tests stand in for xterm with the one thing that matters: a keydown
// listener on its hidden textarea that asks the same guard Term.tsx asks
// (attachCustomKeyEventHandler) and otherwise writes the key to the "pty".

const write = vi.fn<(data: string) => void>();

function FakeTerminal() {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current!;
    // xterm's own keydown runs on the textarea, after the custom handler.
    const onKey = (ev: KeyboardEvent) => {
      if (terminalKeyBlocked(ev)) return; // Term.tsx: `return false`
      write(ev.key === "Escape" ? "\x1b" : ev.key);
    };
    el.addEventListener("keydown", onKey);
    return () => el.removeEventListener("keydown", onKey);
  }, []);
  return (
    <div className="xterm">
      <textarea ref={ref} className="xterm-helper-textarea" aria-label="terminal" />
    </div>
  );
}

const terminal = () => screen.getByLabelText("terminal");
const press = (key: string, target: Element = terminal()) => {
  fireEvent.keyDown(target, { key });
  fireEvent.keyUp(target, { key });
};
const flush = () => act(async () => { await Promise.resolve(); });

afterEach(() => {
  cleanup();
  write.mockReset();
});

function Popup({ onClose, blocksTerminal }: { onClose: () => void; blocksTerminal?: boolean }) {
  useEscape(onClose, true, { blocksTerminal });
  return <div role="menu">menu</div>;
}

function WithPopup({ initial = true, blocksTerminal }: { initial?: boolean; blocksTerminal?: boolean }) {
  const [open, setOpen] = useState(initial);
  return (
    <>
      <FakeTerminal />
      <button onClick={() => setOpen(true)}>open</button>
      {open && <Popup onClose={() => setOpen(false)} blocksTerminal={blocksTerminal} />}
    </>
  );
}

describe("Escape with nothing open", () => {
  it("reaches the terminal — agents rely on it to interrupt", () => {
    render(<FakeTerminal />);
    press("Escape");
    expect(write).toHaveBeenCalledWith("\x1b");
  });

  it("still reaches it after an overlay has opened and closed", () => {
    render(<WithPopup />);
    press("Escape"); // closes the popup
    expect(screen.queryByRole("menu")).toBeNull();
    press("Escape"); // now it is the agent's
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith("\x1b");
  });
});

describe("Escape with an overlay open", () => {
  it("closes the overlay and never reaches the terminal, though focus is still in it", () => {
    render(<WithPopup />);
    terminal().focus();
    press("Escape");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(write).not.toHaveBeenCalled();
  });

  it("swallows the terminal's other keys while a modal overlay is up", () => {
    render(<WithPopup />);
    press("a");
    press("Enter");
    expect(write).not.toHaveBeenCalled();
  });

  it("lets typing through for a non-modal panel, but still not Escape", () => {
    render(<WithPopup blocksTerminal={false} />);
    press("a");
    expect(write).toHaveBeenCalledWith("a");
    write.mockReset();
    press("Escape");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(write).not.toHaveBeenCalled();
  });

  it("takes focus out of the terminal while open and gives it back on close", async () => {
    render(<WithPopup initial={false} />);
    terminal().focus();
    act(() => screen.getByText("open").click());
    // jsdom: a click doesn't move focus, exactly like WebKit on a button.
    expect(document.activeElement).not.toBe(terminal());
    press("Escape", document.body);
    await flush();
    expect(document.activeElement).toBe(terminal());
  });

  it("never reaches the terminal from a real overlay: the Workspaces panel", () => {
    const onClose = vi.fn();
    render(
      <>
        <FakeTerminal />
        <WorkspacePanel open title="Workspaces" onClose={onClose}>
          <p>rows</p>
        </WorkspacePanel>
      </>,
    );
    press("Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(write).not.toHaveBeenCalled();
  });
});

describe("nested overlays", () => {
  function Nested() {
    const [panel, setPanel] = useState(true);
    const [confirm, setConfirm] = useState(false);
    return (
      <>
        <FakeTerminal />
        <WorkspacePanel open={panel} title="Workspaces" onClose={() => setPanel(false)}>
          <button onClick={() => setConfirm(true)}>Delete</button>
        </WorkspacePanel>
        {confirm && (
          <Dialog title="Delete workspace?" dismissLabel="Cancel" onDismiss={() => setConfirm(false)} />
        )}
      </>
    );
  }

  it("close top-first: the confirm, then the panel, then Escape is the terminal's", () => {
    render(<Nested />);
    act(() => screen.getByText("Delete").click());
    expect(screen.getByRole("dialog", { name: "Delete workspace?" })).toBeTruthy();

    press("Escape");
    expect(screen.queryByRole("dialog", { name: "Delete workspace?" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Workspaces" })).toBeTruthy();

    press("Escape");
    expect(screen.queryByRole("dialog", { name: "Workspaces" })).toBeNull();
    expect(write).not.toHaveBeenCalled();

    press("Escape");
    expect(write).toHaveBeenCalledWith("\x1b");
  });

  it("closes only the top one even when both listen", () => {
    const below = vi.fn();
    const above = vi.fn();
    function Two() {
      useEscape(below);
      return <Above />;
    }
    function Above() {
      const [on, setOn] = useState(false);
      useEffect(() => setOn(true), []);
      useEscape(above, on);
      return null;
    }
    render(<Two />);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(above).toHaveBeenCalledTimes(1);
    expect(below).not.toHaveBeenCalled();
  });
});

describe("fields inside an overlay", () => {
  function WithField({ handles }: { handles: boolean }) {
    const [open, setOpen] = useState(true);
    const [draft, setDraft] = useState("edit");
    useEscapeLayer(open, { onEscape: () => setOpen(false) });
    if (!open) return <p>closed</p>;
    return (
      <input
        aria-label="rename"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (handles && e.key === "Escape") {
            e.preventDefault();
            setDraft("");
          }
        }}
      />
    );
  }

  it("a field that cancels its own edit on Escape keeps the overlay open", () => {
    render(<WithField handles />);
    fireEvent.keyDown(screen.getByLabelText("rename"), { key: "Escape" });
    expect((screen.getByLabelText("rename") as HTMLInputElement).value).toBe("");
  });

  it("a field with no Escape of its own lets the overlay close", () => {
    render(<WithField handles={false} />);
    fireEvent.keyDown(screen.getByLabelText("rename"), { key: "Escape" });
    expect(screen.getByText("closed")).toBeTruthy();
  });
});

describe("the side panel backstop", () => {
  it("puts the panel away without the press also reaching the terminal", () => {
    const onEscape = vi.fn();
    function Panel() {
      useEscapeBackstop(onEscape);
      return <FakeTerminal />;
    }
    render(<Panel />);
    press("Escape");
    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(write).not.toHaveBeenCalled();
  });
});

describe("Term.tsx", () => {
  it("asks the overlay stack before anything reaches the pty", () => {
    const src = readFileSync(join(process.cwd(), "src", "components", "Term.tsx"), "utf8");
    const handler = src.slice(src.indexOf("attachCustomKeyEventHandler"));
    const guard = handler.indexOf("if (terminalKeyBlocked(ev)) return false;");
    expect(guard).toBeGreaterThan(-1);
    // First thing it does: before the keydown filter, the paste path and the
    // editing chords, every one of which can write to the pty.
    expect(guard).toBeLessThan(handler.indexOf('ev.type !== "keydown"'));
  });
});

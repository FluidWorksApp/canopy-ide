// A spawn that is refused (bad argv[0], missing binary) produces no pty and
// therefore no pty:exit. Term must route that failure through the same
// spawned->exited path a crashed process takes, or the tab reads as "running"
// forever: the servers panel calls it up, and Build waits on a readiness that
// can never come. These tests drive the real component against a rejecting
// spawn and mirror ProjectView's handlers — including its "only exits from the
// pty I was told about" guard — so a synthetic exit that the consumer would
// drop is a failure here too.
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { mockCommands } from "../test/setup";
import { groupServers, type ServerComponent } from "../servers";
import type { TermSubTab } from "./ProjectView/helpers";

/** The most recent mock Terminal, for the clipboard tests to drive. */
const xterm = vi.hoisted(() => ({
  last: null as null | {
    options: Record<string, unknown>;
    selection: string;
    modes: { mouseTrackingMode: string };
    osc: Map<number, (data: string) => boolean>;
    keyHandler?: (ev: KeyboardEvent) => boolean;
    pasted: string[];
  },
}));

vi.mock("@xterm/xterm", () => {
  class Terminal {
    options: Record<string, unknown> = {};
    cols = 80;
    rows = 24;
    unicode = { activeVersion: "" };
    selection = "";
    pasted: string[] = [];
    modes = { mouseTrackingMode: "none" };
    osc = new Map<number, (data: string) => boolean>();
    keyHandler?: (ev: KeyboardEvent) => boolean;
    parser = {
      registerOscHandler: (id: number, handler: (data: string) => boolean) => {
        this.osc.set(id, handler);
        return { dispose() {} };
      },
      registerCsiHandler: () => ({ dispose() {} }),
      registerEscHandler: () => ({ dispose() {} }),
    };
    buffer = {
      active: { length: 0, getLine: () => undefined },
      normal: { length: 0, getLine: () => undefined },
      alternate: { length: 0, getLine: () => undefined },
      onBufferChange: () => ({ dispose() {} }),
    };
    onWriteParsed() {
      return { dispose() {} };
    }
    onResize() {
      return { dispose() {} };
    }
    constructor(opts?: object) {
      Object.assign(this.options, opts);
      xterm.last = this;
    }
    loadAddon() {}
    registerLinkProvider() {
      return { dispose() {} };
    }
    attachCustomKeyEventHandler(handler: (ev: KeyboardEvent) => boolean) {
      this.keyHandler = handler;
    }
    selectAll() {}
    open() {}
    refresh() {}
    resize() {}
    write(_data: unknown, cb?: () => void) {
      cb?.();
    }
    writeln() {}
    input() {}
    paste(text: string) {
      this.pasted.push(text);
    }
    focus() {}
    clear() {}
    reset() {}
    dispose() {}
    hasSelection() {
      return this.selection !== "";
    }
    getSelection() {
      return this.selection;
    }
    onData() {
      return { dispose() {} };
    }
    onTitleChange() {
      return { dispose() {} };
    }
    onBinary() {
      return { dispose() {} };
    }
  }
  return { Terminal };
});
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    proposeDimensions() {
      return undefined;
    }
  },
}));
vi.mock("@xterm/addon-unicode11", () => ({ Unicode11Addon: class {} }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({
    onDragDropEvent: async () => () => {},
  }),
}));

if (!globalThis.ResizeObserver)
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;

import { Term } from "./Term";

const component: ServerComponent = {
  id: "cmp-web",
  label: "site",
  path: "/w/site",
  commands: [{ id: "run-server", name: "server", command: "npm run dev" }],
};

/** ProjectView's side of the contract, verbatim in miniature: remember the pty
 *  each tab was told about, and only accept exits from that pty. */
function consumer(initial: TermSubTab) {
  let tab = initial;
  const livePty = new Map<string, number>();
  return {
    get tab() {
      return tab;
    },
    onSpawned: (ptyId: number) => {
      livePty.set(tab.id, ptyId);
      tab = { ...tab, ptyId, exited: false, exitCode: undefined };
    },
    onExited: (event: { id: number; exit_code: number | null }) => {
      if (livePty.get(tab.id) !== event.id) return;
      livePty.delete(tab.id);
      tab = { ...tab, exited: true, exitCode: event.exit_code, ptyId: null };
    },
  };
}

const runTab = (): TermSubTab => ({
  id: "t1",
  type: "terminal",
  launchTitle: "server",
  cwd: "/w/site",
  command: "npm run dev",
  run: true,
  componentId: "cmp-web",
  runCommandId: "run-server",
  ptyId: null,
});

const events = {
  "plugin:event|listen": () => 1,
  "plugin:event|unlisten": () => undefined,
};

describe("Term spawn failure", () => {
  it("reports the native session lifetime when a new terminal binds", async () => {
    mockCommands({
      ...events,
      pty_renderer_register: () => ({generation: 1, sessions: []}),
      pty_detach_desktop: () => undefined,
      pty_spawn: () => ({id:91,session_generation:42,name:"Native label",cols:80,rows:24,generation:3}),
    });
    await (await import("../ipc")).ptyRendererRegister();
    const onSpawned = vi.fn();
    render(<Term cwd="/w/site" active streaming={false} onSpawned={onSpawned} onExited={vi.fn()} />);
    await waitFor(() => expect(onSpawned).toHaveBeenCalledWith(91,"Native label",42));
  });
  it("marks the tab exited/failed when the shell-run spawn is refused", async () => {
    mockCommands({
      ...events,
      pty_spawn: () => {
        throw new Error("no such binary");
      },
    });
    const c = consumer(runTab());
    render(
      <Term
        cwd="/w/site"
        active
        streaming={false}
        runCommand="npm run dev"
        onSpawned={c.onSpawned}
        onExited={c.onExited}
      />,
    );
    await waitFor(() => expect(c.tab.exited).toBe(true));
    expect(c.tab.exitCode).not.toBe(0);
    expect(c.tab.ptyId).toBeNull();
  });

  it("marks the tab exited/failed when the argv spawn is refused", async () => {
    mockCommands({
      ...events,
      pty_spawn_attached_argv: () => {
        throw new Error("bad argv[0]");
      },
    });
    const c = consumer(runTab());
    render(
      <Term
        cwd="/w/site"
        active
        streaming={false}
        runCommand="npm run dev"
        runArgv={["definitely-not-a-binary", "run", "dev"]}
        onSpawned={c.onSpawned}
        onExited={c.onExited}
      />,
    );
    await waitFor(() => expect(c.tab.exited).toBe(true));
    expect(c.tab.exitCode).not.toBe(0);
  });

  it("reports the failed run as failed — never running — in the servers join", async () => {
    mockCommands({
      ...events,
      pty_spawn: () => {
        throw new Error("spawn refused");
      },
    });
    const c = consumer(runTab());
    render(
      <Term
        cwd="/w/site"
        active
        streaming={false}
        runCommand="npm run dev"
        onSpawned={c.onSpawned}
        onExited={c.onExited}
      />,
    );
    await waitFor(() => expect(c.tab.exited).toBe(true));
    const [group] = groupServers([component], [c.tab], () => []);
    expect(group.entries[0].state).toBe("failed");
    expect(group.running).toBe(0);
  });

  it("leaves an interactive shell tab alone: its consumer closes on exit", async () => {
    mockCommands({
      ...events,
      pty_spawn: () => {
        throw new Error("login shell missing");
      },
    });
    const onSpawned = vi.fn();
    const onExited = vi.fn();
    render(
      <Term
        cwd="/w/site"
        active
        streaming={false}
        onSpawned={onSpawned}
        onExited={onExited}
      />,
    );
    // Give the rejected spawn the same turns the run-tab tests needed.
    await new Promise((r) => setTimeout(r, 20));
    expect(onSpawned).not.toHaveBeenCalled();
    expect(onExited).not.toHaveBeenCalled();
  });
});

describe("Term ended process recovery", () => {
  it("settles a missing PTY and does not retry when the viewer is shown again", async () => {
    const ipc = await import("../ipc");
    const attach = vi.spyOn(ipc, "ptyAttachDesktop").mockRejectedValue(new Error("no pty session 12"));
    vi.spyOn(ipc, "ptyOutput").mockResolvedValue("ERR_PNPM_OUTDATED_LOCKFILE");
    vi.spyOn(ipc, "onPtyExit").mockResolvedValue(() => {});
    const c = consumer(runTab());
    const props = { cwd: "/w/site", active: true, attachId: 12, onSpawned: c.onSpawned, onExited: c.onExited };
    const view = render(<Term {...props} streaming />);
    await waitFor(() => expect(c.tab.exited).toBe(true));
    expect(c.tab.exitCode).toBeNull();
    view.rerender(<Term {...props} streaming={false} />);
    view.rerender(<Term {...props} streaming />);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(attach).toHaveBeenCalledTimes(1);
    view.unmount();
    vi.restoreAllMocks();
  });

  it("does not reconnect an exited process after hide and show", async () => {
    const ipc = await import("../ipc");
    let exited!: (event: import("../ipc").PtyExit) => void;
    vi.spyOn(ipc, "onPtyExit").mockImplementation(async (cb) => { exited = cb; return () => {}; });
    const attach = vi.spyOn(ipc, "ptyAttachDesktop").mockResolvedValue({ generation: 1, cols: 80, rows: 24 } as Awaited<ReturnType<typeof ipc.ptyAttachDesktop>>);
    vi.spyOn(ipc, "ptyDetachDesktop").mockResolvedValue(undefined);
    const c = consumer(runTab());
    const props = { cwd: "/w/site", active: true, attachId: 12, onSpawned: c.onSpawned, onExited: c.onExited };
    const view = render(<Term {...props} streaming />);
    await waitFor(() => expect(c.tab.ptyId).toBe(12));
    exited({ id: 12, session_generation: 1, exit_code: 1, requested: false });
    view.rerender(<Term {...props} streaming={false} />);
    view.rerender(<Term {...props} streaming />);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(attach).toHaveBeenCalledTimes(1);
    expect(c.tab.exitCode).toBe(1);
    view.unmount();
    vi.restoreAllMocks();
  });

  it("reads retained native output when the hidden viewer has no text", async () => {
    const ipc = await import("../ipc");
    vi.spyOn(ipc, "onPtyExit").mockResolvedValue(() => {});
    vi.spyOn(ipc, "ptyOutput").mockResolvedValue("ERR_PNPM_OUTDATED_LOCKFILE");
    const { createRef } = await import("react");
    const ref = createRef<import("./Term").TermHandle>();
    const view = render(<Term ref={ref} cwd="/w/site" active={false} streaming={false} attachId={12} onSpawned={() => {}} onExited={() => {}} />);
    await waitFor(async () => expect(await ref.current!.captureTextSettled()).toBe("ERR_PNPM_OUTDATED_LOCKFILE"));
    view.unmount();
    vi.restoreAllMocks();
  });
});

describe("Term recovered attachment", () => {
  it("resumes every stream before starting the shared exit puller", async () => {
    // Earlier component tests install and remove their subscribers from the
    // renderer-level fan-out. Reload the modules so this case exercises the
    // first shared pull without inheriting their cursor.
    vi.resetModules();
    const [{ Term: RecoveryTerm }, recoveryIpc] = await Promise.all([
      import("./Term"),
      import("../ipc"),
    ]);
    const calls: string[] = [];
    const attach = vi.fn(({ id }: { id: number }) => {
      calls.push(`attach:${id}`);
      return {
        cols: 80,
        rows: 24,
        generation: 4,
        replay_start: 0,
        replay_end: 0,
      };
    });
    mockCommands({
      pty_renderer_register: () => ({ generation: 9, sessions: [] }),
      pty_renderer_events: () => {
        calls.push("exits");
        return { exit_cursor: 0, exits: [], spawn_cursor: 0, spawns: [] };
      },
      pty_attach_desktop: attach,
      pty_read_desktop: () => null,
      pty_detach_desktop: () => undefined,
    });
    await recoveryIpc.ptyRendererRegister();
    const onSpawned = vi.fn();
    render(
      <>
        <RecoveryTerm
          cwd="/w/site"
          active
          streaming
          attachId={77}
          onSpawned={onSpawned}
          onExited={vi.fn()}
        />
        <RecoveryTerm
          cwd="/w/site"
          active
          streaming
          attachId={88}
          onSpawned={onSpawned}
          onExited={vi.fn()}
        />
      </>,
    );

    await waitFor(() => expect(attach).toHaveBeenCalledTimes(2));
    expect(onSpawned).toHaveBeenCalledWith(77, undefined, undefined);
    expect(onSpawned).toHaveBeenCalledWith(88, undefined, undefined);
    expect(calls).toEqual(["attach:77", "attach:88", "exits"]);
  });
});

describe("Term clipboard", () => {
  const b64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));
  const keydown = (init: Partial<KeyboardEvent>) =>
    ({ type: "keydown", isComposing: false, keyCode: 0, preventDefault() {}, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...init }) as KeyboardEvent;
  const chordEvent = async (id: string) => {
    const { resolve } = await import("../shortcuts");
    const c = resolve(id)!;
    return keydown({ code: c.code!, metaKey: c.meta, ctrlKey: c.ctrl, altKey: c.alt, shiftKey: c.shift });
  };
  /** A mounted terminal whose clipboard writes are recorded. */
  const mount = () => {
    const written: string[] = [];
    mockCommands({
      ...events,
      pty_spawn: () => {
        throw new Error("not needed here");
      },
      clipboard_write_text: (args: Record<string, unknown>) => void written.push(String(args.text)),
      clipboard_read_text: () => "from the clipboard",
      notify_native: () => undefined,
    });
    const view = render(<Term cwd="/w/site" active streaming={false} onSpawned={vi.fn()} onExited={vi.fn()} />);
    return { written, view, term: xterm.last! };
  };

  it("lets Option-drag force a selection while a TUI owns the mouse", () => {
    const { term, view } = mount();
    expect(term.options.macOptionClickForcesSelection).toBe(true);
    view.unmount();
  });

  it("puts an OSC 52 write on the clipboard after the user's input, and never answers a query", async () => {
    const { term, written, view } = mount();
    const osc52 = term.osc.get(52)!;
    // Replayed output with no input from the user: dropped.
    expect(osc52(`c;${b64("stale")}`)).toBe(true);
    term.keyHandler!(keydown({ code: "KeyY", key: "y" }));
    expect(osc52("c;?")).toBe(true);
    expect(osc52(`c;${b64("copied in the remote TUI")}`)).toBe(true);
    await waitFor(() => expect(written).toEqual(["copied in the remote TUI"]));
    view.unmount();
  });

  it("copies the xterm selection on the copy chord, and passes the key through without one", async () => {
    const { term, written, view } = mount();
    const copy = await chordEvent("term-copy");
    expect(term.keyHandler!(copy)).toBe(true);
    term.selection = "selected text";
    expect(term.keyHandler!(copy)).toBe(false);
    await waitFor(() => expect(written).toEqual(["selected text"]));
    view.unmount();
  });

  it("validates WebKit's Copy command only while xterm holds a selection", () => {
    const { term, view } = mount();
    const el = view.container.querySelector(".term-container")!;
    const before = () => {
      const ev = new Event("beforecopy", { bubbles: true, cancelable: true });
      el.dispatchEvent(ev);
      return ev.defaultPrevented;
    };
    expect(before()).toBe(false);
    term.selection = "x";
    expect(before()).toBe(true);
    view.unmount();
  });

  it("opens Canopy's terminal menu with a working Copy and Paste", async () => {
    const { term, written, view } = mount();
    const el = view.container.querySelector(".term-container")!;
    term.selection = "menu copy";
    fireEvent.contextMenu(el);
    const copy = screen.getByText("Copy").closest("button")!;
    expect(copy.disabled).toBe(false);
    fireEvent.click(copy);
    await waitFor(() => expect(written).toEqual(["menu copy"]));

    fireEvent.contextMenu(el);
    fireEvent.click(screen.getByText("Paste").closest("button")!);
    await waitFor(() => expect(term.pasted).toEqual(["from the clipboard"]));
    view.unmount();
  });

  it("disables Copy and explains the modifier-drag when a TUI owns the mouse", () => {
    const { term, view } = mount();
    term.modes.mouseTrackingMode = "any";
    fireEvent.contextMenu(view.container.querySelector(".term-container")!);
    expect(screen.getByText("Copy").closest("button")!.disabled).toBe(true);
    expect(screen.getByText(/drag to select text/)).toBeTruthy();
    view.unmount();
  });
});

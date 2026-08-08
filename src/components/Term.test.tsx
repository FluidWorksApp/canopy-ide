// A spawn that is refused (bad argv[0], missing binary) produces no pty and
// therefore no pty:exit. Term must route that failure through the same
// spawned->exited path a crashed process takes, or the tab reads as "running"
// forever: the servers panel calls it up, and Build waits on a readiness that
// can never come. These tests drive the real component against a rejecting
// spawn and mirror ProjectView's handlers — including its "only exits from the
// pty I was told about" guard — so a synthetic exit that the consumer would
// drop is a failure here too.
import { describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { mockCommands } from "../test/setup";
import { groupServers, type ServerComponent } from "../servers";
import type { TermSubTab } from "./ProjectView/helpers";

vi.mock("@xterm/xterm", () => {
  class Terminal {
    options: Record<string, unknown> = {};
    cols = 80;
    rows = 24;
    unicode = { activeVersion: "" };
    parser = { registerOscHandler: () => ({ dispose() {} }) };
    buffer = { active: { length: 0, getLine: () => undefined } };
    constructor(opts?: object) {
      Object.assign(this.options, opts);
    }
    loadAddon() {}
    attachCustomKeyEventHandler() {}
    open() {}
    refresh() {}
    resize() {}
    write(_data: unknown, cb?: () => void) {
      cb?.();
    }
    writeln() {}
    input() {}
    paste() {}
    focus() {}
    clear() {}
    reset() {}
    dispose() {}
    hasSelection() {
      return false;
    }
    getSelection() {
      return "";
    }
    onData() {
      return { dispose() {} };
    }
    onTitleChange() {
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
  title: "server",
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
      <Term cwd="/w/site" active onSpawned={onSpawned} onExited={onExited} />,
    );
    // Give the rejected spawn the same turns the run-tab tests needed.
    await new Promise((r) => setTimeout(r, 20));
    expect(onSpawned).not.toHaveBeenCalled();
    expect(onExited).not.toHaveBeenCalled();
  });
});

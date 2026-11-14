import { afterEach, describe, expect, it, vi } from "vitest";

const openLink = vi.fn();
vi.mock("../links", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../links")>()),
  openLink: (...args: unknown[]) => openLink(...args),
}));
vi.mock("../ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc")>()),
  onTunnelState: async () => () => {},
  onTailnetRemoteState: async () => () => {},
}));
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockCommands } from "../test/setup";
import { setTeamIdentityFetchForTests } from "../teamIdentity";
import type * as ipc from "../ipc";
import type { TailscaleMachine, TailscaleView } from "../ipc";
import { TailscaleStatus } from "./TailscaleStatus";
import { RemoteSettings } from "./SettingsDialog";
import {
  applyRemoteStateForTests,
  resetTailnetRemoteForTests,
  TAILNET_OPEN_EVENT,
} from "../tailnetRemote";

// Invented names and addresses only.
const machine = (name: string, n: number, extra: Partial<TailscaleMachine> = {}): TailscaleMachine => ({
  name,
  dnsName: `${name}.example.ts.net`,
  ip: `100.64.0.${n}`,
  stableId: `n${name.replace(/-/g, "").toUpperCase()}1CNTRL`,
  online: true,
  allowed: false,
  ...extra,
});

const base: TailscaleView = {
  kind: "running",
  version: "1.78.1",
  minVersion: "1.60.0",
  canOpenApp: true,
  thisMachine: machine("node-a", 1),
  machines: [
    machine("build-box", 3),
    machine("laptop", 2, { allowed: true }),
    machine("node-b", 4),
    machine("node-c", 5, { online: false }),
    machine("node-d", 6, { online: false, stableId: null }),
  ],
  allowError: null,
};
const view = (over: Partial<TailscaleView>): TailscaleView => ({ ...base, ...over });

/** A desktop whose allow list changes when told to, as tailnet.rs does. */
function show(v: TailscaleView, calls: string[] = [], extra: Record<string, unknown> = {}) {
  let current = structuredClone(v);
  mockCommands({
    tailscale_status: () => current,
    tailscale_allow_set: (args: Record<string, unknown>) => {
      calls.push(`allow ${args.stableId} ${args.allowed}`);
      current = {
        ...current,
        machines: current.machines.map((m) =>
          m.stableId === args.stableId ? { ...m, allowed: args.allowed as boolean } : m,
        ),
      };
      return null;
    },
    tailscale_open_app: () => {
      calls.push("open");
      return null;
    },
    ...extra,
  });
  render(<TailscaleStatus pollMs={60_000} />);
}

describe("Tailscale row states", () => {
  it("not installed: offers the download", async () => {
    openLink.mockClear();
    show(view({ kind: "notInstalled", version: null, thisMachine: null, machines: [] }));
    expect(await screen.findByText("Not installed")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Get Tailscale ↗" }));
    expect(openLink).toHaveBeenCalledWith("https://tailscale.com/download", true);
  });

  it("off: one card for app-not-running and stopped, with Open Tailscale", async () => {
    const calls: string[] = [];
    show(view({ kind: "off", thisMachine: null, machines: [] }), calls);
    expect(await screen.findByText("Tailscale is off")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Open Tailscale" }));
    await waitFor(() => expect(calls).toEqual(["open"]));
    expect(screen.queryByText("Online")).toBeNull();
  });

  it("off without an app to open (Linux) says what to do instead", async () => {
    show(view({ kind: "off", canOpenApp: false, thisMachine: null, machines: [] }));
    expect(await screen.findByText("Start Tailscale on this machine.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open Tailscale" })).toBeNull();
  });

  it("needs login: sends you to the app, never signs in itself", async () => {
    show(view({ kind: "needsLogin", thisMachine: null, machines: [] }));
    expect(await screen.findByText("Needs login")).toBeInTheDocument();
    expect(screen.getByText("Sign in from the Tailscale app.")).toHaveClass("set-warn");
    expect(screen.getByRole("button", { name: "Open Tailscale" })).toBeInTheDocument();
  });

  it("needs approval: says an admin must approve, offers the app", async () => {
    show(view({ kind: "needsApproval", thisMachine: null, machines: [] }));
    expect(await screen.findByText("Needs approval")).toBeInTheDocument();
    expect(screen.getByText("An admin must approve this machine.")).toHaveClass("set-warn");
    expect(screen.getByRole("button", { name: "Open Tailscale" })).toBeInTheDocument();
  });

  it("starting: a passing state with nothing to press", async () => {
    show(view({ kind: "starting", thisMachine: null, machines: [] }));
    expect(await screen.findByText("Starting…")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("too old: shows the found and the needed version, and Update", async () => {
    openLink.mockClear();
    show(view({ kind: "tooOld", version: "1.40.2", thisMachine: null, machines: [] }));
    expect(await screen.findByText("Too old")).toBeInTheDocument();
    expect(screen.getByText("v1.40.2")).toBeInTheDocument();
    expect(screen.getByText("Needs v1.60 or newer.")).toHaveClass("set-warn");
    await userEvent.click(screen.getByRole("button", { name: "Update ↗" }));
    expect(openLink).toHaveBeenCalledWith("https://tailscale.com/download", true);
  });

  it("running: this machine, the online machines and how many are offline", async () => {
    show(base);
    expect(await screen.findByText("Running")).toBeInTheDocument();
    expect(screen.getByText("v1.78.1")).toBeInTheDocument();
    expect(screen.getByText("This machine")).toBeInTheDocument();
    expect(screen.getByText("node-a.example.ts.net")).toBeInTheDocument();
    for (const name of ["build-box", "laptop", "node-b"])
      expect(screen.getByRole("switch", { name: `Allow ${name}` })).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "Allow node-c" })).toBeNull();
    expect(screen.getByText("2 offline")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Allow laptop" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("switch", { name: "Allow build-box" })).toHaveAttribute("aria-checked", "false");
  });

  it("running with nobody offline shows no offline count", async () => {
    show(view({ machines: [machine("laptop", 2)] }));
    await screen.findByText("Running");
    expect(screen.queryByText(/offline/)).toBeNull();
  });
});

describe("Allow", () => {
  it("calls the command with the machine's stable id and shows the new state", async () => {
    const calls: string[] = [];
    show(base, calls);
    const toggle = await screen.findByRole("switch", { name: "Allow build-box" });
    await userEvent.click(toggle);
    await waitFor(() => expect(calls).toEqual(["allow nBUILDBOX1CNTRL true"]));
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
  });

  it("switching off sends allowed false", async () => {
    const calls: string[] = [];
    show(base, calls);
    await userEvent.click(await screen.findByRole("switch", { name: "Allow laptop" }));
    await waitFor(() => expect(calls).toEqual(["allow nLAPTOP1CNTRL false"]));
  });

  it("a refusal is shown and the switch stays as it was", async () => {
    show(base, [], {
      tailscale_allow_set: () => {
        throw new Error("Tailscale couldn't confirm that machine.");
      },
    });
    const toggle = await screen.findByRole("switch", { name: "Allow node-b" });
    await userEvent.click(toggle);
    expect(await screen.findByRole("alert")).toHaveTextContent("couldn't confirm");
    expect(toggle).toHaveAttribute("aria-checked", "false");
  });

  it("a machine without a stable id cannot be allowed", async () => {
    show(view({ machines: [machine("node-e", 7, { stableId: null })] }));
    expect(await screen.findByRole("switch", { name: "Allow node-e" })).toBeDisabled();
  });

  it("says plainly that an allowed machine gets full access", async () => {
    show(base);
    expect(await screen.findByText(/read and type into every terminal on this machine, as you/)).toBeInTheDocument();
    expect(screen.getByText("Allow")).toHaveAttribute(
      "title",
      "An allowed machine can read and type into every terminal on this machine",
    );
  });

  it("says when the listener cannot start, only while someone is allowed", async () => {
    show(view({ listener: { state: "portInUse", port: 28617 } }));
    expect(await screen.findByRole("status")).toHaveTextContent("Another program is using port 28617");
  });

  it("is quiet about the listener when nothing is wrong", async () => {
    show(view({ listener: { state: "listening", port: 28617 } }));
    await screen.findByRole("switch", { name: "Allow laptop" });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("is quiet about a listener problem while nobody is allowed", async () => {
    show(
      view({
        listener: { state: "noInterface", port: 28617 },
        machines: base.machines.map((m) => ({ ...m, allowed: false })),
      }),
    );
    await screen.findByRole("switch", { name: "Allow laptop" });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("an unreadable allow list is said, and every switch is off limits", async () => {
    show(view({ allowError: "Can't read ~/.canopy/tailnet-allow.txt. Fix or remove it." }));
    expect(await screen.findByText(/tailnet-allow\.txt/)).toHaveClass("set-warn");
    for (const s of screen.getAllByRole("switch")) expect(s).toBeDisabled();
  });
});

describe("Tailscale row in Remote access", () => {
  const remote = {
    remote_status: { enabled: false, port: 0, pin: null, urls: [] },
    tunnel_status: { running: false, provider: null, url: null, message: null },
    which_check: {},
    remote_qr: "<svg></svg>",
    tailscale_status: view({ kind: "off", thisMachine: null, machines: [] }),
  };

  it.each([
    ["signed in", async () => ({ user: { id: "u1", name: "Test" } })],
    ["signed out", async () => null],
  ])("is shown %s", async (_label, fetchIdentity) => {
    setTeamIdentityFetchForTests(fetchIdentity);
    mockCommands(remote);
    render(<RemoteSettings runInTerminal={() => {}} />);
    expect(await screen.findByText("Uses the Tailscale app on this machine.")).toBeInTheDocument();
    const row = screen.getByText("Tailscale", { selector: ".set-item-name" }).closest(".set-item") as HTMLElement;
    expect(await within(row).findByText("Tailscale is off")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Remote access" })).toBeInTheDocument();
    setTeamIdentityFetchForTests(null);
  });
});

// Connect → the other machine's terminals. Placeholder names only.
describe("Connect", () => {
  afterEach(() => resetTailnetRemoteForTests());

  const WORK = "nWORKMAC1CNTRL";
  const work = machine("work-mac", 3, { stableId: WORK });
  const one = view({ thisMachine: machine("this-mac", 1), machines: [work] });
  const terminals: ipc.TailnetRemoteTerminal[] = [
    { remoteId: 1, title: "zsh", cwd: "~/code/api", command: null, status: "running", exitCode: null },
    { remoteId: 2, title: "claude", cwd: "~/code/web", command: "claude", status: "running", exitCode: null },
    { remoteId: 3, title: "zsh", cwd: "~/scratch", command: null, status: "exited", exitCode: 0 },
  ];
  const row = (name: string) => screen.getByLabelText(`Allow ${name}`).closest(".resume-row") as HTMLElement;

  it("A: Connect is enabled whether or not the machine is allowed", async () => {
    show(view({ machines: [work, machine("laptop", 2, { allowed: true })] }));
    await screen.findByText("Running");
    for (const b of screen.getAllByRole("button", { name: "Connect" })) expect(b).toBeEnabled();
  });

  it("A: a machine without a stable id cannot be connected to", async () => {
    show(view({ machines: [machine("node-e", 7, { stableId: null })] }));
    await screen.findByText("Running");
    expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled();
  });

  it("B: pressing Connect shows Connecting… until the list arrives", async () => {
    let release!: (t: unknown) => void;
    show(one, [], {
      tailnet_remote_list: () => new Promise((r) => (release = r)),
    });
    await userEvent.click(await screen.findByRole("button", { name: "Connect" }));
    expect(await screen.findByRole("button", { name: "Connecting…" })).toBeDisabled();
    release(terminals);
    expect(await screen.findByRole("button", { name: "Disconnect" })).toBeInTheDocument();
  });

  it("C: the row expands with Terminals on <machine>, a count, and a row per terminal", async () => {
    const calls: string[] = [];
    show(one, calls, {
      tailnet_remote_list: (a: Record<string, unknown>) => {
        calls.push(`list ${a.stableId}`);
        return terminals;
      },
    });
    await userEvent.click(await screen.findByRole("button", { name: "Connect" }));
    expect(await screen.findByText("Terminals on work-mac")).toBeInTheDocument();
    expect(calls).toContain(`list ${WORK}`);
    const list = screen.getByText("Terminals on work-mac").closest(".ts-terminals") as HTMLElement;
    expect(within(list).getByText("3")).toBeInTheDocument();
    expect(within(list).getByText("~/code/api")).toBeInTheDocument();
    expect(within(list).getAllByText("running")).toHaveLength(2);
    expect(within(list).getByText("exited")).toBeInTheDocument();
    // Open on the two running ones; nothing to press on the exited one.
    expect(within(list).getAllByRole("button", { name: /^Open / })).toHaveLength(2);
  });

  it("C: the list refreshes while open", async () => {
    let n = 0;
    mockCommands({
      tailscale_status: one,
      tailnet_remote_list: () => (++n === 1 ? terminals.slice(0, 1) : terminals),
    });
    render(<TailscaleStatus pollMs={30} />);
    await userEvent.click(await screen.findByRole("button", { name: "Connect" }));
    expect(await screen.findByText("Terminals on work-mac")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("exited")).toBeInTheDocument());
  });

  it("C: Open registers a proxy tab and tells the project view; a second Open focuses it", async () => {
    const calls: string[] = [];
    const seen: unknown[] = [];
    const on = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener(TAILNET_OPEN_EVENT, on);
    show(one, calls, {
      tailnet_remote_list: () => terminals,
      tailnet_remote_open: (a: Record<string, unknown>) => {
        calls.push(`open ${a.stableId} ${a.remoteId}`);
        return { ptyId: 41, sessionGeneration: 1, cwd: "~/code/api", title: "zsh", machine: "work-mac" };
      },
    });
    await userEvent.click(await screen.findByRole("button", { name: "Connect" }));
    await userEvent.click(await screen.findByRole("button", { name: "Open zsh ~/code/api" }));
    await waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toMatchObject({ ptyId: 41, machine: "work-mac", cwd: "~/code/api" });
    expect(await screen.findByText("running · in use here")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Open zsh ~/code/api" }));
    await waitFor(() => expect(seen).toHaveLength(2));
    expect(calls.filter((c) => c.startsWith("open"))).toEqual([`open ${WORK} 1`]);
    window.removeEventListener(TAILNET_OPEN_EVENT, on);
  });

  it("C: Disconnect closes this machine's tabs and collapses the row", async () => {
    const calls: string[] = [];
    show(one, calls, {
      tailnet_remote_list: () => terminals,
      tailnet_remote_open: () => ({ ptyId: 41, sessionGeneration: 1, cwd: "~/code/api", title: "zsh", machine: "work-mac" }),
      tailnet_remote_close: (a: Record<string, unknown>) => void calls.push(`close ${a.ptyId}`),
    });
    await userEvent.click(await screen.findByRole("button", { name: "Connect" }));
    await userEvent.click(await screen.findByRole("button", { name: "Open zsh ~/code/api" }));
    await userEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    expect(calls).toContain("close 41");
    expect(screen.queryByText("Terminals on work-mac")).toBeNull();
    expect(screen.getByRole("button", { name: "Connect" })).toBeEnabled();
  });

  it("F: Tailscale off on this Mac, with Open Tailscale", async () => {
    const calls: string[] = [];
    show(one, calls, {
      tailnet_remote_list: () => {
        throw "tailscale_off";
      },
    });
    await userEvent.click(await screen.findByRole("button", { name: "Connect" }));
    expect(await screen.findByText("Tailscale is off on this Mac.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Open Tailscale" }));
    await waitFor(() => expect(calls).toContain("open"));
  });

  it("F: a refused or silent machine gets the same 'didn't accept' text, and Try again retries", async () => {
    let n = 0;
    show(one, [], {
      tailnet_remote_list: () => {
        if (++n === 1) throw "refused";
        return terminals;
      },
    });
    await userEvent.click(await screen.findByRole("button", { name: "Connect" }));
    expect(await screen.findByText("work-mac didn't accept the connection.")).toBeInTheDocument();
    expect(
      screen.getByText("Canopy may not be running there, or work-mac hasn't allowed this Mac."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("On work-mac: Settings → Remote access → turn Allow on for this Mac."),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Terminals on work-mac")).toBeInTheDocument();
  });

  it("F: a build with no such command shows 'didn't accept', never an error dump", async () => {
    // No tailnet_remote_list mock: the harness throws 'Unmocked Tauri command'.
    show(one);
    await userEvent.click(await screen.findByRole("button", { name: "Connect" }));
    expect(await screen.findByText("work-mac didn't accept the connection.")).toBeInTheDocument();
    expect(screen.queryByText(/Unmocked/)).toBeNull();
    // The rest of the row still works.
    expect(screen.getByRole("switch", { name: "Allow work-mac" })).toBeEnabled();
  });

  it("F: an older Canopy over there", async () => {
    show(one, [], {
      tailnet_remote_list: () => {
        throw "older_canopy";
      },
    });
    await userEvent.click(await screen.findByRole("button", { name: "Connect" }));
    expect(
      await screen.findByText("work-mac runs an older Canopy that can't share terminals. Update it."),
    ).toBeInTheDocument();
  });

  it("F: Allow turned off over there says the tabs were closed", async () => {
    show(one, [], {
      tailnet_remote_list: () => terminals,
      tailnet_remote_open: () => ({ ptyId: 41, sessionGeneration: 1, cwd: "~/code/api", title: "zsh", machine: "work-mac" }),
    });
    await userEvent.click(await screen.findByRole("button", { name: "Connect" }));
    await userEvent.click(await screen.findByRole("button", { name: "Open zsh ~/code/api" }));
    act(() =>
      applyRemoteStateForTests({ ptyId: 41, stableId: WORK, state: "revoked", attempt: null, exitCode: null }),
    );
    expect(await screen.findByText("work-mac turned Allow off. Your tabs were closed.")).toBeInTheDocument();
    expect(screen.queryByText("Terminals on work-mac")).toBeNull();
    expect(within(row("work-mac")).getByRole("button", { name: "Connect" })).toBeEnabled();
  });

  it("F: a terminal that ended over there is said with its exit code", async () => {
    show(one, [], {
      tailnet_remote_list: () => terminals,
      tailnet_remote_open: () => ({ ptyId: 41, sessionGeneration: 1, cwd: "~/code/api", title: "zsh", machine: "work-mac" }),
    });
    await userEvent.click(await screen.findByRole("button", { name: "Connect" }));
    await userEvent.click(await screen.findByRole("button", { name: "Open zsh ~/code/api" }));
    act(() =>
      applyRemoteStateForTests({ ptyId: 41, stableId: WORK, state: "ended", attempt: null, exitCode: 0 }),
    );
    expect(await screen.findByText("This terminal ended on work-mac (exit 0).")).toBeInTheDocument();
  });

  it("Allow is untouched: the switch and its copy still work beside Connect", async () => {
    const calls: string[] = [];
    show(one, calls, { tailnet_remote_list: () => terminals });
    await userEvent.click(await screen.findByRole("switch", { name: "Allow work-mac" }));
    await waitFor(() => expect(calls).toEqual([`allow ${WORK} true`]));
    expect(
      screen.getByTitle("An allowed machine can read and type into every terminal on this machine"),
    ).toHaveTextContent("Allow");
  });
});

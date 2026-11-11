import { describe, expect, it, vi } from "vitest";

const openLink = vi.fn();
vi.mock("../links", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../links")>()),
  openLink: (...args: unknown[]) => openLink(...args),
}));
vi.mock("../ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc")>()),
  onTunnelState: async () => () => {},
}));
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockCommands } from "../test/setup";
import { setTeamIdentityFetchForTests } from "../teamIdentity";
import type { TailscaleMachine, TailscaleView } from "../ipc";
import { TailscaleStatus } from "./TailscaleStatus";
import { RemoteSettings } from "./SettingsDialog";

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

  it("Connect is not wired yet: disabled, Coming soon", async () => {
    show(base);
    await screen.findByText("Running");
    const connects = screen.getAllByRole("button", { name: "Connect" });
    expect(connects).toHaveLength(3);
    for (const b of connects) {
      expect(b).toBeDisabled();
      expect(b.parentElement).toHaveAttribute("title", "Coming soon");
    }
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

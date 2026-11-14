import { describe, expect, it, vi } from "vitest";

// Tunnel state also arrives as an app event; these tests read it from the
// command answers, so the listener is a no-op.
vi.mock("../ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc")>()),
  onTunnelState: async () => () => {},
}));
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockCommands } from "../test/setup";
import { setTeamIdentityFetchForTests } from "../teamIdentity";
import { RemoteSettings } from "./SettingsDialog";

const off = { enabled: false, port: 0, pin: null, urls: [] };
const running = { enabled: true, port: 6680, pin: "123456", urls: ["http://192.168.1.4:6680/remote"] };

function commands(calls: string[], tunnelUrl: string | null, message: string | null = null) {
  let enabled = false;
  mockCommands({
    remote_status: () => (enabled ? running : off),
    remote_enable: () => {
      calls.push("remote_enable");
      enabled = true;
      return running;
    },
    tunnel_status: () => ({ running: false, provider: null, url: null, message: null }),
    tunnel_start: (args: Record<string, unknown>) => {
      calls.push(`tunnel_start ${args.provider} ${args.port}`);
      return { running: !message, provider: "canopy", url: tunnelUrl, message };
    },
    remote_qr: () => "<svg></svg>",
    which_check: () => ({}),
    tailscale_status: () => tailscale,
  });
}

const machine = { name: "mac", dnsName: "mac.example.ts.net.", ip: "100.64.0.1", stableId: "nMAC1CNTRL", online: true, allowed: false };
const running_ts = { kind: "running", version: "1.104.7", minVersion: "1.60.0", canOpenApp: true, thisMachine: machine, machines: [], allowError: null };
let tailscale: unknown = running_ts;

describe("Remote access, signed in to Canopy", () => {
  it("is one switch: phone access over Tailscale, no PIN screen of its own and no second network option", async () => {
    setTeamIdentityFetchForTests(async () => ({ user: { id: "u1", name: "VJ" } }));
    tailscale = running_ts;
    const calls: string[] = [];
    commands(calls, "https://vj.remote.canopyide.dev");
    render(<RemoteSettings runInTerminal={() => {}} />);
    const toggle = await screen.findByRole("switch", { name: "Remote access" });
    expect(screen.queryByText("Cloudflare")).toBeNull();
    await userEvent.click(toggle);
    await waitFor(() => expect(calls).toEqual(["remote_enable", "tunnel_start canopy 6680"]));
    // The hosted link, when there is one.
    expect(await screen.findByText("https://vj.remote.canopyide.dev/remote")).toBeInTheDocument();
    // The Tailscale address to open on the phone, with the PIN, right there.
    expect(await screen.findByText("http://mac.example.ts.net:6680/remote")).toBeInTheDocument();
    expect(screen.getByText("123456")).toBeInTheDocument();
    // There is no local-network section any more.
    expect(screen.queryByText("On this network")).toBeNull();
    expect(screen.queryByRole("button", { name: "Show address and PIN" })).toBeNull();
    setTeamIdentityFetchForTests(null);
  });

  it("uses the tailnet address when Tailscale gives no name", async () => {
    setTeamIdentityFetchForTests(async () => ({ user: { id: "u1", name: "VJ" } }));
    tailscale = { ...running_ts, thisMachine: { ...machine, dnsName: "" } };
    commands([], null, "not-on-server-yet");
    render(<RemoteSettings runInTerminal={() => {}} />);
    await userEvent.click(await screen.findByRole("switch", { name: "Remote access" }));
    expect(await screen.findByText("http://100.64.0.1:6680/remote")).toBeInTheDocument();
    setTeamIdentityFetchForTests(null);
  });

  it("says what is needed when Tailscale is not running, instead of an address", async () => {
    setTeamIdentityFetchForTests(async () => ({ user: { id: "u1", name: "VJ" } }));
    tailscale = { ...running_ts, kind: "off", thisMachine: null };
    commands([], null, "not-on-server-yet");
    render(<RemoteSettings runInTerminal={() => {}} />);
    await userEvent.click(await screen.findByRole("switch", { name: "Remote access" }));
    expect(await screen.findByText(/Needs Tailscale running on this Mac and on your phone/)).toBeInTheDocument();
    expect(screen.queryByText(/ts\.net/)).toBeNull();
    setTeamIdentityFetchForTests(null);
  });

  it.each(["not-on-server-yet", "Remote access is not configured"])(
    "says links are waiting on the server, not an error (%s)",
    async (message) => {
      setTeamIdentityFetchForTests(async () => ({ user: { id: "u1", name: "VJ" } }));
      tailscale = running_ts;
      commands([], null, message);
      render(<RemoteSettings runInTerminal={() => {}} />);
      await userEvent.click(await screen.findByRole("switch", { name: "Remote access" }));
      // Waiting on the server is not an error and not worth a line: phone access
      // is the Tailscale block, which does not depend on the link.
      expect(await screen.findByText("Open on your phone")).toBeInTheDocument();
      expect(screen.queryByText(/Not live yet/)).toBeNull();
      expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
      setTeamIdentityFetchForTests(null);
    },
  );

  it("still offers Try again when the link really fails", async () => {
    setTeamIdentityFetchForTests(async () => ({ user: { id: "u1", name: "VJ" } }));
    commands([], null, "Can't reach Canopy's edge");
    render(<RemoteSettings runInTerminal={() => {}} />);
    await userEvent.click(await screen.findByRole("switch", { name: "Remote access" }));
    expect(await screen.findByRole("button", { name: "Try again" })).toBeInTheDocument();
    setTeamIdentityFetchForTests(null);
  });
});

describe("Remote access, signed out", () => {
  it("keeps the self-hosted options and points to signing in", async () => {
    setTeamIdentityFetchForTests(async () => null);
    commands([], null);
    render(<RemoteSettings runInTerminal={() => {}} />);
    expect(await screen.findByText(/Sign in to Canopy/)).toBeInTheDocument();
    setTeamIdentityFetchForTests(null);
  });
});

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
  });
}

describe("Remote access, signed in to Canopy", () => {
  it("is one switch that brings up your own link — no tunnel picker, no PIN", async () => {
    setTeamIdentityFetchForTests(async () => ({ user: { id: "u1", name: "VJ" } }));
    const calls: string[] = [];
    commands(calls, "https://vj.remote.canopyide.dev");
    render(<RemoteSettings runInTerminal={() => {}} />);
    const toggle = await screen.findByRole("switch", { name: "Remote access" });
    expect(screen.queryByText("Cloudflare")).toBeNull();
    await userEvent.click(toggle);
    await waitFor(() => expect(calls).toEqual(["remote_enable", "tunnel_start canopy 6680"]));
    expect(await screen.findByText("https://vj.remote.canopyide.dev/remote")).toBeInTheDocument();
    expect(screen.queryByText("123456")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Show address and PIN" }));
    expect(screen.getByText("123456")).toBeInTheDocument();
    setTeamIdentityFetchForTests(null);
  });

  it.each(["not-on-server-yet", "Remote access is not configured"])(
    "says links are waiting on the server, not an error (%s)",
    async (message) => {
      setTeamIdentityFetchForTests(async () => ({ user: { id: "u1", name: "VJ" } }));
      commands([], null, message);
      render(<RemoteSettings runInTerminal={() => {}} />);
      await userEvent.click(await screen.findByRole("switch", { name: "Remote access" }));
      const note = await screen.findByText(/Canopy links aren't live on Canopy's server yet/);
      expect(note).toHaveClass("set-note");
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

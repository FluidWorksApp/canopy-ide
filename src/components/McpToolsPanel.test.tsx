// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { McpToolsPanel } from "./McpToolsPanel";
import type { McpServer } from "../ipc";

// The panel's whole claim is that one server configured in four CLIs is one
// row that knows about all four. These cover that claim, and the one thing that
// must never happen: a credential from a config reaching the DOM.

const mcpServers = vi.hoisted(() => vi.fn());
vi.mock("../ipc", () => ({ mcpServers }));

const server = (over: Partial<McpServer> = {}): McpServer => ({
  key: "cmd:npx @playwright/mcp",
  name: "playwright",
  transport: "stdio",
  command: "npx",
  args: ["@playwright/mcp@latest"],
  url: null,
  env_keys: [],
  sources: [
    {
      agent: "claude",
      label: "Claude Code (global)",
      name: "playwright",
      config_path: "/home/u/.claude.json",
      scope: "global",
      status: "enabled",
    },
  ],
  enabled: true,
  ...over,
});

const onOpen = vi.fn();

const panel = (servers: McpServer[]) => {
  mcpServers.mockReset();
  onOpen.mockReset();
  mcpServers.mockResolvedValue(servers);
  render(<McpToolsPanel rootsKey={"/repo"} visible onOpen={onOpen} />);
};

/** Unfold a row's configs — the chevron, not the row, which now opens the
 *  server instead. */
const expand = () => fireEvent.click(screen.getByTitle("Where it's configured"));

it("asks for the project's roots, not a joined string", async () => {
  panel([]);
  await waitFor(() => expect(mcpServers).toHaveBeenCalledWith(["/repo"]));
});

it("says how many of the configured servers are actually reachable", async () => {
  panel([server(), server({ key: "b", name: "off", enabled: false })]);
  expect(await screen.findByText("1 of 2 live")).toBeTruthy();
});

it("names every CLI that can reach one server on its single row", async () => {
  panel([
    server({
      sources: [
        {
          agent: "cursor",
          label: "Cursor (global)",
          name: "browserbase",
          config_path: "/home/u/.cursor/mcp.json",
          scope: "global",
          status: "enabled",
        },
        {
          agent: "windsurf",
          label: "Windsurf (global)",
          name: "bb",
          config_path: "/home/u/.codeium/windsurf/mcp_config.json",
          scope: "global",
          status: "enabled",
        },
      ],
    }),
  ]);
  expect(await screen.findByText("Cursor · Windsurf")).toBeTruthy();
});

// A CLI that has the server switched off cannot reach it, so listing it beside
// the ones that can would answer "who can use this" wrongly.
it("leaves a CLI that has it switched off out of the reachable list", async () => {
  panel([
    server({
      sources: [
        {
          agent: "claude",
          label: "Claude Code (global)",
          name: "playwright",
          config_path: "/home/u/.claude.json",
          scope: "global",
          status: "enabled",
        },
        {
          agent: "opencode",
          label: "OpenCode (global)",
          name: "playwright",
          config_path: "/home/u/.config/opencode/opencode.json",
          scope: "global",
          status: "disabled",
        },
      ],
    }),
  ]);
  expect(await screen.findByText("Claude Code")).toBeTruthy();
  expect(screen.queryByText(/OpenCode/)).toBeNull();
});

it("shows a server no CLI can reach rather than hiding it", async () => {
  panel([
    server({
      enabled: false,
      sources: [
        {
          agent: "claude",
          label: "Claude Code (project)",
          name: "linear",
          config_path: "/repo/.mcp.json",
          scope: "project",
          status: "pending",
        },
      ],
    }),
  ]);
  expect(await screen.findByText("not reachable")).toBeTruthy();
});

it("names the variables a server needs without holding a single value", async () => {
  panel([server({ env_keys: ["BROWSERBASE_API_KEY", "GEMINI_API_KEY"] })]);
  await screen.findByText("playwright");
  expand();
  expect(screen.getByText("BROWSERBASE_API_KEY")).toBeTruthy();
  // The Rust side never sends values; this asserts the panel invents no way to
  // show one — the whole `McpServer` shape has nowhere to put it.
  expect(document.body.textContent).not.toMatch(/bb_live_|AIza/);
});

it("names each config's own name for the server, which is rarely the row's", async () => {
  panel([
    server({
      name: "browserbase",
      sources: [
        {
          agent: "windsurf",
          label: "Windsurf (global)",
          name: "bb",
          config_path: "/home/u/.codeium/windsurf/mcp_config.json",
          scope: "global",
          status: "enabled",
        },
      ],
    }),
  ]);
  await screen.findByText("browserbase");
  expand();
  expect(screen.getByText("bb")).toBeTruthy();
  expect(screen.getByTitle("/home/u/.codeium/windsurf/mcp_config.json")).toBeTruthy();
});

it("does not read the configs while it is out of sight", () => {
  mcpServers.mockReset();
  mcpServers.mockResolvedValue([]);
  render(<McpToolsPanel rootsKey="/repo" visible={false} onOpen={onOpen} />);
  expect(mcpServers).not.toHaveBeenCalled();
});

// The point of the rewrite: a row is a way into the server, not a disclosure
// triangle. Clicking one must open it; unfolding its configs must not.
it("opens the server when its row is clicked", async () => {
  const one = server();
  panel([one]);
  fireEvent.click(await screen.findByText("playwright"));
  expect(onOpen).toHaveBeenCalledWith(one);
});

it("does not open the server when the configs are unfolded", async () => {
  panel([server({ env_keys: ["A_KEY"] })]);
  await screen.findByText("playwright");
  expand();
  expect(onOpen).not.toHaveBeenCalled();
  expect(screen.getByText("A_KEY")).toBeTruthy();
});

describe("a remote server", () => {
  const remote = server({
    key: "url:https://mcp.linear.app/mcp",
    name: "linear",
    transport: "http",
    command: null,
    args: [],
    url: "https://mcp.linear.app/mcp",
  });

  it("is marked as remote and shows its endpoint rather than a command", async () => {
    panel([remote]);
    expect(await screen.findByText("http")).toBeTruthy();
    expand();
    expect(screen.getByText("https://mcp.linear.app/mcp")).toBeTruthy();
  });
});

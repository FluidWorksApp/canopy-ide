// @vitest-environment jsdom
import { expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { McpView } from "./McpView";
import type { McpServer, McpSession } from "../ipc";

// The tab exists to answer two questions the panel could not: who reaches this
// server, and what can it actually do. These cover both, plus the thing that
// makes the second one useful — running a tool and seeing what came back.

const mcpConnect = vi.hoisted(() => vi.fn());
const mcpCallTool = vi.hoisted(() => vi.fn());
vi.mock("../ipc", () => ({ mcpConnect, mcpCallTool }));

const server: McpServer = {
  key: "cmd:npx @browserbasehq/mcp-server-browserbase",
  name: "browserbase",
  transport: "stdio",
  command: "npx",
  args: ["@browserbasehq/mcp-server-browserbase"],
  url: null,
  env_keys: ["BROWSERBASE_API_KEY"],
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
      label: "Windsurf (project)",
      name: "bb",
      config_path: "/repo/.mcp.json",
      scope: "project",
      status: "disabled",
    },
  ],
  enabled: true,
};

const session = (over: Partial<McpSession> = {}): McpSession => ({
  key: server.key,
  server_name: "browserbase-mcp",
  server_version: "2.1.0",
  protocol_version: "2025-06-18",
  instructions: null,
  tools: [
    {
      name: "navigate",
      title: null,
      description: "Point the browser at a URL",
      input_schema: {
        type: "object",
        properties: { url: { type: "string", description: "Where to go" } },
        required: ["url"],
      },
      output_schema: null,
      annotations: null,
    },
    {
      name: "screenshot",
      title: null,
      description: "Capture the page",
      input_schema: { type: "object" },
      output_schema: null,
      annotations: { readOnlyHint: true },
    },
  ],
  prompts: [],
  resources: [],
  capabilities: ["tools"],
  elapsed_ms: 812,
  ...over,
});

beforeEach(() => {
  mcpConnect.mockReset();
  mcpCallTool.mockReset();
});

const view = (s: McpSession = session()) => {
  mcpConnect.mockResolvedValue(s);
  render(<McpView server={server} />);
};

// You opened the tab to see the tools. A Connect button in the way is a step
// whose only purpose is to be clicked.
it("connects on open without being asked to", async () => {
  view();
  await waitFor(() => expect(mcpConnect).toHaveBeenCalledWith(server.key, false));
});

it("shows every CLI that configures it as a tag, with the scope and the alias", async () => {
  view();
  expect(await screen.findByText("Cursor")).toBeTruthy();
  expect(screen.getByText("Windsurf")).toBeTruthy();
  // Windsurf calls it something else, and that difference is why these two
  // configs are one server.
  expect(screen.getByText("bb")).toBeTruthy();
  expect(screen.getByText("project")).toBeTruthy();
});

it("names the variables it needs without ever holding a value", async () => {
  view();
  expect(await screen.findByText("BROWSERBASE_API_KEY")).toBeTruthy();
  expect(document.body.textContent).not.toMatch(/bb_live_|sk-/);
});

it("lists the server's tools and opens on the first", async () => {
  view();
  // The heading is the detail pane; the same text also appears in the list row,
  // which is the point — you navigate by the list and read in the pane.
  expect(await screen.findByRole("heading", { name: "navigate" })).toBeTruthy();
  expect(screen.getByText("screenshot")).toBeTruthy();
  expect(screen.getByLabelText(/url/)).toBeTruthy();
});

it("builds the argument form from the tool's own schema", async () => {
  view();
  await screen.findByText("Where to go");
  expect(screen.getByText("required")).toBeTruthy();
  // Run stays out of reach until the required argument has something in it.
  const run = screen.getByRole("button", { name: "Run" }) as HTMLButtonElement;
  expect(run.disabled).toBe(true);
});

it("runs a tool with what was typed and shows what came back", async () => {
  view();
  await screen.findByText("Where to go");
  fireEvent.change(screen.getByLabelText(/url/), {
    target: { value: "https://example.com" },
  });
  mcpCallTool.mockResolvedValue({
    content: [{ type: "text", text: "loaded example.com" }],
    is_error: false,
    structured: null,
    elapsed_ms: 42,
  });
  fireEvent.click(screen.getByRole("button", { name: "Run" }));
  await waitFor(() =>
    expect(mcpCallTool).toHaveBeenCalledWith(server.key, "navigate", {
      url: "https://example.com",
    }),
  );
  expect(await screen.findByText("loaded example.com")).toBeTruthy();
});

// A tool that ran and refused is not the same as a call that never happened,
// and reading one as the other sends you debugging the wrong thing.
it("distinguishes a tool that refused from a call that failed", async () => {
  view();
  await screen.findByText("Where to go");
  fireEvent.change(screen.getByLabelText(/url/), { target: { value: "x" } });
  mcpCallTool.mockResolvedValue({
    content: [{ type: "text", text: "not a valid URL" }],
    is_error: true,
    structured: null,
    elapsed_ms: 3,
  });
  fireEvent.click(screen.getByRole("button", { name: "Run" }));
  expect(await screen.findByText("The tool returned an error")).toBeTruthy();
  expect(screen.getByText("not a valid URL")).toBeTruthy();
});

it("shows a failed call as a failure, not as an empty result", async () => {
  view();
  await screen.findByText("Where to go");
  fireEvent.change(screen.getByLabelText(/url/), { target: { value: "x" } });
  mcpCallTool.mockRejectedValue("the server did not answer within 120s");
  fireEvent.click(screen.getByRole("button", { name: "Run" }));
  expect(
    await screen.findByText(/did not answer within 120s/),
  ).toBeTruthy();
  expect(screen.queryByText("Result")).toBeNull();
});

it("switches to another tool and shows that tool's arguments", async () => {
  view();
  await screen.findByText("Where to go");
  fireEvent.click(screen.getByText("screenshot"));
  expect(await screen.findByText("This tool takes no arguments.")).toBeTruthy();
  const run = screen.getByRole("button", { name: "Run" }) as HTMLButtonElement;
  expect(run.disabled).toBe(false);
});

it("shows the raw schema when asked", async () => {
  view();
  await screen.findByText("Where to go");
  fireEvent.click(screen.getByRole("button", { name: "schema" }));
  expect(screen.getByText(/"required"/)).toBeTruthy();
});

// The one that makes a broken server fixable: the reason it wouldn't start.
it("shows why a server would not start, with a way to try again", async () => {
  mcpConnect.mockRejectedValue(
    "could not start `npx`: No such file or directory",
  );
  render(<McpView server={server} />);
  expect(await screen.findByText(/No such file or directory/)).toBeTruthy();
  mcpConnect.mockResolvedValue(session());
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(mcpConnect).toHaveBeenLastCalledWith(server.key, true));
});

it("says so plainly when a server exposes nothing", async () => {
  view(session({ tools: [] }));
  expect(await screen.findByText("This server exposes no tools.")).toBeTruthy();
});

// A server whose point is its resources looked empty when only tools counted.
it("counts the prompts and resources a server also exposes", async () => {
  view(
    session({
      tools: [],
      resources: [
        { name: "docs://index", description: null, uri: "docs://index", mime_type: null },
      ],
      prompts: [{ name: "summarise", description: "Summarise a page", uri: null, mime_type: null }],
    }),
  );
  expect(await screen.findByText("1 resource")).toBeTruthy();
  expect(screen.getByText("1 prompt")).toBeTruthy();
});

// @vitest-environment jsdom
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SlackSettings } from "./SlackSettings";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), openUrl: vi.fn(), changed: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: mocks.openUrl }));
vi.mock("../slackLive", () => ({ slackStatusChanged: mocks.changed }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const team = { team: "T1", teamName: "Acme" };
const hub = (status: unknown) =>
  mocks.invoke.mockImplementation(async (_cmd: string, args: { body: { action: string } }) => {
    const { action } = args.body;
    if (action === "status") {
      if (status instanceof Error) throw status;
      return status;
    }
    if (action === "install-url") return { url: "https://slack.com/oauth/v2/authorize?x" };
    if (action === "link-url") return { url: "https://slack.com/openid/connect/authorize?x" };
    return {};
  });
const buttons = () => screen.queryAllByRole("button").map((b) => b.textContent);
const action = () => mocks.invoke.mock.calls.map((c) => c[1].body.action).filter((a) => a !== "status");

it("offers nothing while Slack isn't available", async () => {
  hub({ configured: false, installs: [], linked: [] });
  render(<SlackSettings companion="Jarvis" />);
  expect(await screen.findByText("Slack is not available yet.")).toBeTruthy();
  expect(buttons()).toEqual([]);
});

it("leads with Add to Slack when nothing is installed or linked", async () => {
  hub({ configured: true, installs: [], linked: [] });
  render(<SlackSettings companion="Jarvis" />);
  expect(await screen.findByText("Not linked.")).toBeTruthy();
  expect(buttons()).toEqual(["Add to Slack", "Link my Slack"]);
  expect(screen.getByRole("button", { name: "Add to Slack" }).className).toContain("btn-accent");
  expect(screen.getByRole("button", { name: "Link my Slack" }).className).not.toContain("btn-accent");
  expect(screen.getByText(/Already in a workspace with Canopy\?/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Add to Slack" }));
  await waitFor(() => expect(mocks.openUrl).toHaveBeenCalledWith("https://slack.com/oauth/v2/authorize?x"));
  expect(action()).toEqual(["install-url"]);
});

it("leads with Link my Slack when this user installed it but isn't linked", async () => {
  hub({ configured: true, installs: [team], linked: [] });
  render(<SlackSettings companion="Jarvis" />);
  expect(await screen.findByText("Canopy is in Acme, but your Slack isn't linked.")).toBeTruthy();
  expect(buttons()).toEqual(["Link my Slack", "Add to another workspace"]);
  expect(screen.getByRole("button", { name: "Link my Slack" }).className).toContain("btn-accent");
  fireEvent.click(screen.getByRole("button", { name: "Link my Slack" }));
  await waitFor(() => expect(mocks.openUrl).toHaveBeenCalledWith("https://slack.com/openid/connect/authorize?x"));
});

it("shows only Unlink and Add to another workspace once linked", async () => {
  hub({ configured: true, installs: [team], linked: [{ ...team, slackUser: "U1" }] });
  render(<SlackSettings companion="Jarvis" />);
  expect(await screen.findByText("Linked in Acme. DM or mention Jarvis there.")).toBeTruthy();
  expect(buttons()).toEqual(["Add to another workspace", "Unlink"]);
  expect(screen.queryByRole("button", { name: "Add to Slack" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Link my Slack" })).toBeNull();
  mocks.changed.mockClear();
  fireEvent.click(screen.getByRole("button", { name: "Unlink" }));
  await waitFor(() => expect(action()).toEqual(["unlink"]));
  expect(mocks.invoke).toHaveBeenCalledWith("canopy_account_request", { route: "/api/slack", body: { action: "unlink" } });
  expect(mocks.changed).toHaveBeenCalled();
});

it("shows a failed status check as an error, with no actions", async () => {
  hub(new Error("offline"));
  render(<SlackSettings companion="Jarvis" />);
  expect((await screen.findByRole("alert")).textContent).toContain("offline");
  expect(screen.queryByRole("status")).toBeNull();
  expect(buttons()).toEqual([]);
});

it("keeps the status and actions when an action fails", async () => {
  hub({ configured: true, installs: [], linked: [] });
  mocks.openUrl.mockRejectedValueOnce(new Error("no browser"));
  render(<SlackSettings companion="Jarvis" />);
  fireEvent.click(await screen.findByRole("button", { name: "Add to Slack" }));
  expect((await screen.findByRole("alert")).textContent).toContain("no browser");
  expect(screen.getByRole("status").textContent).toBe("Not linked.");
  expect(buttons()).toEqual(["Add to Slack", "Link my Slack"]);
});

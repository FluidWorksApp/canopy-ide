// @vitest-environment jsdom
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PlaywrightTokenSetting } from "./PlaywrightTokenSetting";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const backend = (saved: boolean) =>
  mocks.invoke.mockImplementation(async (cmd: string) =>
    cmd === "chrome_extension_token_status" ? saved : undefined,
  );

it("saves a pasted token to the backend and never keeps it on screen", async () => {
  backend(false);
  render(<PlaywrightTokenSetting />);
  expect(await screen.findByText(/Chrome asks you to approve each connection/)).toBeTruthy();
  const field = screen.getByLabelText("Skip Chrome's approval:") as HTMLInputElement;
  await waitFor(() => expect(field.disabled).toBe(false));
  expect(field.type).toBe("password");
  fireEvent.change(field, { target: { value: "  synthetic-token_123  " } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByText(/token saved in Keychain/);
  expect(mocks.invoke).toHaveBeenCalledWith("chrome_extension_token_set", { token: "synthetic-token_123" });
  expect(screen.getByText(/Chrome connects without asking/)).toBeTruthy();
  expect(document.body.innerHTML).not.toContain("synthetic-token_123");
  expect(window.localStorage.length).toBe(0);
});

it("clears a saved token", async () => {
  backend(true);
  render(<PlaywrightTokenSetting />);
  fireEvent.click(await screen.findByRole("button", { name: "Clear" }));
  await screen.findByLabelText("Skip Chrome's approval:");
  expect(mocks.invoke).toHaveBeenCalledWith("chrome_extension_token_clear");
  expect(screen.getByText(/Chrome asks you to approve each connection/)).toBeTruthy();
});

it("opens the extension page, and explains where the token is when Chrome cannot be opened", async () => {
  mocks.invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "chrome_extension_token_status") return false;
    if (cmd === "chrome_extension_open_status") throw Error("Google Chrome was not found.");
  });
  render(<PlaywrightTokenSetting />);
  fireEvent.click(await screen.findByRole("button", { name: "Open extension page" }));
  expect(mocks.invoke).toHaveBeenCalledWith("chrome_extension_open_status");
  expect((await screen.findByRole("alert")).textContent).toMatch(/extension's icon in Chrome's toolbar/);
});

it("shows a save failure and keeps the token unsaved", async () => {
  mocks.invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "chrome_extension_token_status") return false;
    if (cmd === "chrome_extension_token_set") throw "That does not look like a Playwright extension token.";
  });
  render(<PlaywrightTokenSetting />);
  const field = (await screen.findByLabelText("Skip Chrome's approval:")) as HTMLInputElement;
  await waitFor(() => expect(field.disabled).toBe(false));
  fireEvent.change(field, { target: { value: "bad token" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect((await screen.findByRole("alert")).textContent).toContain("does not look like");
  expect(screen.queryByText(/token saved/)).toBeNull();
});

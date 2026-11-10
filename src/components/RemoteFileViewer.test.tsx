import { afterEach, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import type { Host } from "../host/contract";
import { liveEnvironments } from "../environments/live";
import { openRemoteFile } from "../environments/remoteFiles";
import { RemoteFileViewer } from "./RemoteFileViewer";

const ENV = "remote:ws9";
const connect = (invoke: (c: string) => unknown) =>
  liveEnvironments.register(
    { id: ENV, name: "Workstation", host: { kind: "socket", readOnly: false, invoke: vi.fn(async (c: string) => invoke(c)) } as unknown as Host, status: "connected", readOnly: false },
    { secondary: true },
  );
afterEach(() => liveEnvironments.unregister(ENV));

it("shows the file read-only, badged with the machine", async () => {
  connect(() => ({ b64: btoa("line one\nline two") }));
  render(<RemoteFileViewer />);
  act(() => openRemoteFile({ env: ENV, machine: "Workstation", path: "/work/notes.md" }));
  expect(await screen.findByText(/line one/)).toBeTruthy();
  expect(screen.getByText("Workstation")).toBeTruthy();
  expect(screen.getByText("read-only")).toBeTruthy();
  expect(screen.queryByRole("textbox")).toBeNull();
});

it("says why a credential file was not opened", async () => {
  connect(() => ({ b64: "" }));
  render(<RemoteFileViewer />);
  act(() => openRemoteFile({ env: ENV, machine: "Workstation", path: "/home/dev/.ssh/id_rsa" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/credentials/));
});

it("a binary file is not dumped as text", async () => {
  connect(() => ({ b64: btoa("a\u0000b") }));
  render(<RemoteFileViewer />);
  act(() => openRemoteFile({ env: ENV, machine: "Workstation", path: "/work/blob.bin" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/not text/));
});

it("closes on Escape", async () => {
  connect(() => ({ b64: btoa("x") }));
  const { container } = render(<RemoteFileViewer />);
  act(() => openRemoteFile({ env: ENV, machine: "Workstation", path: "/work/a.txt" }));
  await screen.findByText("x");
  act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
  expect(container.querySelector(".remote-file")).toBeNull();
});

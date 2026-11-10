import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Host } from "../host/contract";
import { liveEnvironments } from "./live";
import {
  OPEN_REMOTE_FILE_EVENT,
  RemoteFileRefused,
  isCredentialPath,
  openRemoteFile,
  readRemoteFile,
  remoteFileExists,
} from "./remoteFiles";
import { updateSettings } from "../settings";

const ENV = "remote:ws9";
const b64 = (s: string) => btoa(s);

function connect(invoke: (command: string, args?: Record<string, unknown>) => unknown) {
  const host = { kind: "socket", readOnly: false, invoke: vi.fn(async (c: string, a?: Record<string, unknown>) => invoke(c, a)) } as unknown as Host;
  liveEnvironments.register({ id: ENV, name: "Workstation", host, status: "connected", readOnly: false }, { secondary: true });
  return host as unknown as { invoke: ReturnType<typeof vi.fn> };
}

beforeEach(() => updateSettings({ allowOutsideFileLinks: false }));
afterEach(() => liveEnvironments.unregister(ENV));

describe("credential paths", () => {
  it.each([
    "/home/dev/.ssh/id_rsa",
    "/home/dev/.aws/credentials",
    "/srv/app/server.pem",
    "/srv/app/../../etc/passwd",
    "/home/dev/.zshrc",
    "C:\\Users\\dev\\AppData\\Roaming\\x.txt",
    "/home/dev/.config/gh/hosts.yml",
  ])("refuses %s", (path) => expect(isCredentialPath(path)).toBe(true));
  it.each(["/srv/app/README.md", "/work/canopy/src/a.ts", "/work/.github/workflows/ci.yml"])("allows %s", (path) =>
    expect(isCredentialPath(path)).toBe(false));
});

describe("reading on the other machine", () => {
  it("reads through that machine's own fs_read_file", async () => {
    const host = connect(() => ({ b64: b64("hello") }));
    const { bytes, truncated } = await readRemoteFile(ENV, "/work/a.txt");
    expect(new TextDecoder().decode(bytes)).toBe("hello");
    expect(truncated).toBe(false);
    expect(host.invoke).toHaveBeenCalledWith("fs_read_file", { path: "/work/a.txt", maxBytes: 1048576 });
  });

  it("never asks the machine for a credential file", async () => {
    const host = connect(() => ({ b64: "" }));
    await expect(readRemoteFile(ENV, "/home/dev/.ssh/id_ed25519")).rejects.toBeInstanceOf(RemoteFileRefused);
    expect(host.invoke).not.toHaveBeenCalled();
  });

  it("outside the project folders: refused with the Privacy setting off, no grant requested", async () => {
    const host = connect((c) => {
      if (c === "fs_read_file") throw new Error("path is outside the registered roots");
      return undefined;
    });
    await expect(readRemoteFile(ENV, "/tmp/notes.txt")).rejects.toThrow(/Privacy/);
    expect(host.invoke).not.toHaveBeenCalledWith("fs_grant_link_file", expect.anything());
  });

  it("outside the project folders: with Privacy on, grants that one file and retries once", async () => {
    updateSettings({ allowOutsideFileLinks: true });
    let granted = false;
    const host = connect((c) => {
      if (c === "fs_grant_link_file") { granted = true; return undefined; }
      if (!granted) throw new Error("path is outside the registered roots");
      return { b64: b64("ok") };
    });
    const { bytes } = await readRemoteFile(ENV, "/tmp/notes.txt");
    expect(new TextDecoder().decode(bytes)).toBe("ok");
    expect(host.invoke).toHaveBeenCalledWith("fs_grant_link_file", { path: "/tmp/notes.txt" });
  });

  it("another kind of failure is passed on, not mistaken for a scope refusal", async () => {
    connect(() => { throw new Error("ENOENT: no such file"); });
    await expect(readRemoteFile(ENV, "/work/missing.txt")).rejects.toThrow(/ENOENT/);
  });

  it("a machine that is not connected is an error, not a read on this Mac", async () => {
    await expect(readRemoteFile("remote:nope", "/work/a.txt")).rejects.toThrow(/not connected/);
  });
});

describe("existence and opening", () => {
  it("a file exists, a folder or a failure does not", async () => {
    connect((_c, a) => (a?.path === "/work/dir" ? { is_dir: true } : a?.path === "/work/a" ? { is_dir: false } : (() => { throw new Error("no"); })()));
    expect(await remoteFileExists(ENV, "/work/a")).toBe(true);
    expect(await remoteFileExists(ENV, "/work/dir")).toBe(false);
    expect(await remoteFileExists(ENV, "/work/none")).toBe(false);
  });

  it("opening dispatches one event, and ignores a relative path", () => {
    const seen = vi.fn();
    window.addEventListener(OPEN_REMOTE_FILE_EVENT, seen);
    openRemoteFile({ env: ENV, machine: "Workstation", path: "relative/a.txt" });
    expect(seen).not.toHaveBeenCalled();
    openRemoteFile({ env: ENV, machine: "Workstation", path: "/work/a.txt", line: 3 });
    expect(seen).toHaveBeenCalledTimes(1);
    window.removeEventListener(OPEN_REMOTE_FILE_EVENT, seen);
  });
});

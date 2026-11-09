// tauriTransport over mocked t3_socket_* commands and a fake Channel.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  channels: [] as Array<{ onmessage: (event: unknown) => void }>,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
  Channel: class {
    onmessage: (event: unknown) => void = () => {};
    constructor() { mocks.channels.push(this); }
  },
}));

import { connectT3Machine, tauriTransport } from "./api";
import { RpcTransportError } from "./rpc";

const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
const channel = () => mocks.channels.at(-1)!;
const sent = () => mocks.invoke.mock.calls.filter(([name]) => name === "t3_socket_send").map(([, args]) => (args as { text: string }).text);

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.channels.length = 0;
  mocks.invoke.mockImplementation(async (name: string) => (name === "t3_socket_open" ? 7 : undefined));
});

describe("tauriTransport", () => {
  it("opens by machine id only and passes the channel", async () => {
    await tauriTransport("env-1");
    expect(mocks.invoke).toHaveBeenCalledWith("t3_socket_open", { id: "env-1", onFrame: channel() });
  });

  it("delivers messages, including ones that arrived before the open returned", async () => {
    mocks.invoke.mockImplementation(async (name: string) => {
      if (name !== "t3_socket_open") return undefined;
      channel().onmessage({ kind: "message", data: "early" });
      return 7;
    });
    const transport = await tauriTransport("env-1");
    const messages: string[] = [];
    transport.onMessage(text => messages.push(text));
    transport.onClose(() => {});
    channel().onmessage({ kind: "message", data: '{"kind":"closed"}' });
    expect(messages).toEqual(["early", '{"kind":"closed"}']);
  });

  it("sends in order, one at a time", async () => {
    let release!: () => void;
    mocks.invoke.mockImplementation(async (name: string) => {
      if (name === "t3_socket_open") return 7;
      if (name === "t3_socket_send" && !release) await new Promise<void>(resolve => { release = resolve; });
      return undefined;
    });
    const transport = await tauriTransport("env-1");
    transport.send("a");
    transport.send("b");
    await flush();
    expect(sent()).toEqual(["a"]);
    release();
    await flush();
    expect(sent()).toEqual(["a", "b"]);
    expect(mocks.invoke).toHaveBeenCalledWith("t3_socket_send", { socketId: 7, text: "b" });
  });

  it("reports the closed event once, and closes the socket", async () => {
    const transport = await tauriTransport("env-1");
    const closed = vi.fn();
    transport.onMessage(() => {});
    transport.onClose(closed);
    channel().onmessage({ kind: "closed", code: 4001, reason: "" });
    channel().onmessage({ kind: "closed", code: 1000, reason: "again" });
    channel().onmessage({ kind: "message", data: "late" });
    expect(closed).toHaveBeenCalledTimes(1);
    expect(closed).toHaveBeenCalledWith("Socket closed (4001)");
    transport.close();
    await flush();
    expect(mocks.invoke).toHaveBeenCalledWith("t3_socket_close", { socketId: 7 });
  });

  it("ends the transport when the desktop refuses a send", async () => {
    mocks.invoke.mockImplementation(async (name: string) => {
      if (name === "t3_socket_open") return 7;
      if (name === "t3_socket_send") throw new Error("The T3 connection is not keeping up; the message was not sent.");
      return undefined;
    });
    const transport = await tauriTransport("env-1");
    const closed = vi.fn();
    transport.onMessage(() => {});
    transport.onClose(closed);
    transport.send("a");
    await flush();
    expect(closed).toHaveBeenCalledWith(expect.stringContaining("not keeping up"));
    expect(mocks.invoke).toHaveBeenCalledWith("t3_socket_close", { socketId: 7 });
    transport.send("b");
    await flush();
    expect(sent()).toEqual(["a"]);
  });

  it("carries the RPC client: requests out, Exits in, closed fails pending calls", async () => {
    const client = await connectT3Machine("env-1");
    const pending = client.call<string>("server.getConfig", {});
    await flush();
    expect(JSON.parse(sent()[0]!)).toEqual({ _tag: "Request", id: 0, tag: "server.getConfig", payload: {}, headers: [] });
    channel().onmessage({ kind: "message", data: '{"_tag":"Exit","requestId":0,"exit":{"_tag":"Success","value":"ok"}}' });
    await expect(pending).resolves.toBe("ok");
    const next = client.call("x", {});
    await flush();
    channel().onmessage({ kind: "closed", code: 1006, reason: "The T3 connection dropped." });
    await expect(next).rejects.toBeInstanceOf(RpcTransportError);
    expect(client.closed).toBe(true);
  });

  it("fails to connect when the desktop cannot open the socket", async () => {
    mocks.invoke.mockRejectedValue("That T3 machine is not saved on this computer.");
    await expect(connectT3Machine("env-x")).rejects.toThrow("not saved");
  });
});

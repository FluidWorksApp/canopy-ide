import { describe, expect, it } from "vitest";
import type { StructuredRunnerEvent } from "../structuredEvents";
import { AcpSession, type AcpSessionOptions } from "./client";

type Msg = Record<string, unknown>;
type Handler = (params: Msg) => unknown | { error: { code: number; message: string } };
/** Returned by a handler that never answers. */
const SILENT = { silent: true };

/** A scripted agent: `handlers` map a method to its result (or `{error}`).
 *  Unlisted methods answer method-not-found. */
function harness(
  handlers: Record<string, Handler>,
  opts: Partial<AcpSessionOptions> = {},
) {
  const written: Msg[] = [];
  const events: StructuredRunnerEvent[] = [];
  let session: AcpSession;
  const reply = (m: Msg) => session.handleLine(JSON.stringify({ jsonrpc: "2.0", ...m }));
  session = new AcpSession({
    write: async (line) => {
      const m = JSON.parse(line) as Msg;
      written.push(m);
      if (typeof m.method !== "string" || m.id === undefined) return;
      const handler = handlers[m.method];
      queueMicrotask(() => {
        if (!handler) return reply({ id: m.id, error: { code: -32601, message: "no" } });
        const out = handler((m.params ?? {}) as Msg) as { error?: unknown } | undefined;
        if (out === SILENT) return;
        if (out && typeof out === "object" && "error" in out) reply({ id: m.id, error: out.error });
        else reply({ id: m.id, result: out ?? {} });
      });
    },
    host: { emit: (e) => events.push(e) },
    authority: "workspace-write",
    cwd: "/work",
    requestTimeoutMs: 200,
    ...opts,
  });
  const methods = () => written.filter((m) => m.method).map((m) => m.method);
  const find = (method: string) => written.find((m) => m.method === method) as { params: Msg } | undefined;
  return { session, written, events, reply, methods, find };
}

const init = (agentCapabilities: Msg = {}, extra: Msg = {}) => () => ({
  protocolVersion: 1,
  agentCapabilities,
  ...extra,
});

describe("AcpSession.start", () => {
  it("sends systemPrompt only when the agent advertises it, and reports it delivered", async () => {
    const yes = harness(
      { initialize: init({ sessionCapabilities: { systemPrompt: { mode: { override: {} } } } }), "session/new": () => ({ sessionId: "s" }) },
      { systemPrompt: "BRIEF" },
    );
    await yes.session.start();
    expect(yes.find("session/new")?.params.systemPrompt).toEqual({ mode: "append", content: [{ type: "text", text: "BRIEF" }] });
    expect(yes.session.briefDelivered).toBe(true);

    const no = harness({ initialize: init(), "session/new": () => ({ sessionId: "s" }) }, { systemPrompt: "BRIEF" });
    await no.session.start();
    expect(no.find("session/new")?.params).not.toHaveProperty("systemPrompt");
    expect(no.session.briefDelivered).toBe(false);

    const none = harness({ initialize: init({ sessionCapabilities: { systemPrompt: {} } }), "session/new": () => ({ sessionId: "s" }) });
    await none.session.start();
    expect(none.find("session/new")?.params).not.toHaveProperty("systemPrompt");
    expect(none.session.briefDelivered).toBe(false);
  });

  it("prefers session/resume over session/load, then load, then new", async () => {
    const both = harness({
      initialize: init({ loadSession: true, sessionCapabilities: { resume: {} } }),
      "session/resume": () => ({}),
      "session/load": () => ({}),
    });
    await both.session.start("old");
    expect(both.methods()).toEqual(["initialize", "session/resume"]);
    expect(both.find("session/resume")?.params).toMatchObject({ sessionId: "old", cwd: "/work", mcpServers: [] });
    expect(both.session.sessionId).toBe("old");

    const loadOnly = harness({ initialize: init({ loadSession: true }), "session/load": () => ({}) });
    await loadOnly.session.start("old");
    expect(loadOnly.methods()).toEqual(["initialize", "session/load"]);

    const broken = harness({
      initialize: init({ loadSession: true, sessionCapabilities: { resume: {} } }),
      "session/resume": () => ({ error: { code: -32002, message: "gone" } }),
      "session/load": () => ({ error: { code: -32002, message: "gone" } }),
      "session/new": () => ({ sessionId: "fresh" }),
    });
    await broken.session.start("old");
    expect(broken.methods()).toEqual(["initialize", "session/resume", "session/load", "session/new"]);
    expect(broken.session.sessionId).toBe("fresh");
  });

  it("does not resume without a resume id", async () => {
    const h = harness({ initialize: init({ sessionCapabilities: { resume: {} } }), "session/new": () => ({ sessionId: "s" }) });
    await h.session.start();
    expect(h.methods()).toEqual(["initialize", "session/new"]);
  });

  it("authenticates with the first agent method after auth_required, then retries", async () => {
    let attempts = 0;
    const h = harness({
      initialize: init({}, { authMethods: [{ id: "term", type: "terminal" }, { id: "oauth", type: "agent" }, { id: "key" }] }),
      authenticate: () => ({}),
      "session/new": () => (attempts++ === 0 ? { error: { code: -32000, message: "Authentication required" } } : { sessionId: "s" }),
    });
    await h.session.start();
    expect(h.find("authenticate")?.params).toEqual({ methodId: "oauth" });
    expect(h.methods()).toEqual(["initialize", "session/new", "authenticate", "session/new"]);
    expect(h.session.sessionId).toBe("s");
  });

  it("treats a method without a type as an agent method", async () => {
    let attempts = 0;
    const h = harness({
      initialize: init({}, { authMethods: [{ id: "plain" }] }),
      authenticate: () => ({}),
      "session/new": () => (attempts++ === 0 ? { error: { code: -32000, message: "auth" } } : { sessionId: "s" }),
    });
    await h.session.start();
    expect(h.find("authenticate")?.params).toEqual({ methodId: "plain" });
  });

  it("never authenticates a terminal method and tells the person what to run", async () => {
    const h = harness(
      {
        initialize: init({}, { authMethods: [{ id: "login", type: "terminal" }] }),
        authenticate: () => ({}),
        "session/new": () => ({ error: { code: -32000, message: "Authentication required" } }),
      },
      { authHint: "Run `kiro-cli login`." },
    );
    await expect(h.session.start()).rejects.toThrow("Run `kiro-cli login`.");
    expect(h.methods()).not.toContain("authenticate");
  });

  it("includes the hint when authenticate itself fails", async () => {
    const h = harness(
      {
        initialize: init({}, { authMethods: [{ id: "oauth", type: "agent" }] }),
        authenticate: () => ({ error: { code: -32603, message: "denied" } }),
        "session/new": () => ({ error: { code: -32000, message: "auth" } }),
      },
      { authHint: "Sign in with `agent login`." },
    );
    await expect(h.session.start()).rejects.toThrow(/denied.*agent login|agent login.*denied/s);
  });

  it("does not treat a local timeout as auth_required", async () => {
    const h = harness(
      { initialize: init({}, { authMethods: [{ id: "oauth" }] }), authenticate: () => ({}), "session/new": () => SILENT },
      { requestTimeoutMs: 20 },
    );
    await expect(h.session.start()).rejects.toThrow(/timed out/);
    expect(h.methods()).not.toContain("authenticate");
  });

  const model = {
    id: "model",
    category: "model",
    type: "select",
    currentValue: "a",
    options: [{ value: "a" }, { group: "g", name: "G", options: [{ value: "b" }] }],
  };
  const modeOpt = { id: "mode", category: "mode", type: "select", currentValue: "ask", options: [{ value: "ask" }, { value: "code" }] };

  it("applies model and mode through session/set_config_option", async () => {
    const h = harness(
      {
        initialize: init(),
        "session/new": () => ({ sessionId: "s", configOptions: [model, modeOpt] }),
        "session/set_config_option": (p) => ({
          configOptions: [model, modeOpt].map((o) => (o.id === p.configId ? { ...o, currentValue: p.value } : o)),
        }),
      },
      { modelId: "b", modeId: "code" },
    );
    await h.session.start();
    const calls = h.written.filter((m) => m.method === "session/set_config_option").map((m) => m.params);
    expect(calls).toEqual([
      { sessionId: "s", configId: "model", value: "b" },
      { sessionId: "s", configId: "mode", value: "code" },
    ]);
    expect(h.methods()).not.toContain("session/set_mode");
  });

  it("skips a value the agent does not offer or already has", async () => {
    const h = harness(
      { initialize: init(), "session/new": () => ({ sessionId: "s", configOptions: [model, modeOpt] }) },
      { modelId: "unknown", modeId: "ask" },
    );
    await h.session.start();
    expect(h.methods()).not.toContain("session/set_config_option");
  });

  it("falls back to session/set_mode when only legacy modes are returned", async () => {
    const h = harness(
      {
        initialize: init(),
        "session/new": () => ({ sessionId: "s", modes: { availableModes: [{ id: "plan" }] } }),
        "session/set_mode": () => ({}),
      },
      { modeId: "plan" },
    );
    await h.session.start();
    expect(h.find("session/set_mode")?.params).toEqual({ sessionId: "s", modeId: "plan" });
  });

  it("swallows a failed set_config_option", async () => {
    const h = harness(
      {
        initialize: init(),
        "session/new": () => ({ sessionId: "s", configOptions: [model] }),
        "session/set_config_option": () => ({ error: { code: -32602, message: "bad" } }),
      },
      { modelId: "b" },
    );
    await expect(h.session.start()).resolves.toBeUndefined();
  });

  it("tracks config_option_update and current_mode_update", async () => {
    const h = harness({ initialize: init(), "session/new": () => ({ sessionId: "s", configOptions: [model] }) });
    await h.session.start();
    expect(h.session.configOptions).toEqual([model]);
    h.reply({
      method: "session/update",
      params: { sessionId: "s", update: { sessionUpdate: "config_option_update", configOptions: [{ ...model, currentValue: "b" }] } },
    });
    h.reply({
      method: "session/update",
      params: { sessionId: "s", update: { sessionUpdate: "current_mode_update", currentModeId: "code" } },
    });
    expect(h.session.configOptions[0].currentValue).toBe("b");
    expect(h.session.currentModeId).toBe("code");
  });
});

describe("AcpSession.stop", () => {
  it("sends session/close when advertised and accepts already-closed", async () => {
    const h = harness({
      initialize: init({ sessionCapabilities: { close: {} } }),
      "session/new": () => ({ sessionId: "s" }),
      "session/close": () => ({ error: { code: -32002, message: "already closed" } }),
    });
    await h.session.start();
    await h.session.stop();
    expect(h.find("session/close")?.params).toEqual({ sessionId: "s" });
  });

  it("does not send session/close when not advertised", async () => {
    const h = harness({ initialize: init(), "session/new": () => ({ sessionId: "s" }) });
    await h.session.start();
    await h.session.stop();
    expect(h.methods()).not.toContain("session/close");
  });

  it("stops within the timeout when the agent never answers session/close", async () => {
    const h = harness({
      initialize: init({ sessionCapabilities: { close: {} } }),
      "session/new": () => ({ sessionId: "s" }),
      "session/close": () => SILENT,
    }, { closeTimeoutMs: 20 });
    await h.session.start();
    const began = Date.now();
    await expect(h.session.stop()).resolves.toBeUndefined();
    expect(Date.now() - began).toBeLessThan(150);
    expect(h.methods()).toContain("session/close");
  });
});

describe("AcpSession file system", () => {
  const files = new Map<string, string>([["/work/a.txt", "one\ntwo\nthree\nfour"]]);
  const writeRoots: string[][] = [];
  const fs = {
    readTextFile: async (path: string) => {
      const v = files.get(path);
      if (v === undefined) throw new Error("ENOENT");
      return v;
    },
    writeTextFile: async (path: string, content: string, roots: string[]) => {
      writeRoots.push(roots);
      files.set(path, content);
    },
  };
  const setup = (opts: Partial<AcpSessionOptions> = {}) => {
    const h = harness({ initialize: init(), "session/new": () => ({ sessionId: "s" }) }, { fs, ...opts });
    return h;
  };
  const call = async (h: ReturnType<typeof harness>, id: number, method: string, params: Msg) => {
    h.reply({ id, method, params: { sessionId: "s", ...params } });
    await new Promise((r) => setTimeout(r, 0));
    return h.written.find((m) => m.id === id && ("result" in m || "error" in m)) as Msg;
  };

  it("advertises fs only when handlers are supplied, never terminal", async () => {
    const withFs = setup();
    await withFs.session.start();
    expect(withFs.find("initialize")?.params.clientCapabilities).toEqual({
      fs: { readTextFile: true, writeTextFile: true },
      terminal: false,
    });
    const without = harness({ initialize: init(), "session/new": () => ({ sessionId: "s" }) });
    await without.session.start();
    expect(without.find("initialize")?.params.clientCapabilities).toEqual({
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    });
  });

  it("reads a file, honouring 1-based line and limit", async () => {
    const h = setup();
    expect(await call(h, 100, "fs/read_text_file", { path: "/work/a.txt" })).toMatchObject({ result: { content: "one\ntwo\nthree\nfour" } });
    expect(await call(h, 101, "fs/read_text_file", { path: "/work/a.txt", line: 2, limit: 2 })).toMatchObject({ result: { content: "two\nthree" } });
    expect(await call(h, 102, "fs/read_text_file", { path: "/work/a.txt", line: 4 })).toMatchObject({ result: { content: "four" } });
  });

  it("writes inside the root when workspace-write", async () => {
    const h = setup();
    expect(await call(h, 103, "fs/write_text_file", { path: "/work/new.txt", content: "hi" })).toMatchObject({ result: {} });
    // The writer re-checks symlinks against these roots, so they must reach it.
    expect(writeRoots.at(-1)?.length).toBeGreaterThan(0);
    expect(files.get("/work/new.txt")).toBe("hi");
  });

  it("denies a read outside the root without touching the file system", async () => {
    files.set("/etc/secret", "x");
    const h = setup();
    const r = await call(h, 104, "fs/read_text_file", { path: "/etc/secret" });
    expect(r).toHaveProperty("error");
    expect(JSON.stringify(r)).not.toContain('"x"');
  });

  it("denies writes when read-only and emits blocked", async () => {
    const h = setup({ authority: "read-only" });
    const r = await call(h, 105, "fs/write_text_file", { path: "/work/ro.txt", content: "no" });
    expect(r).toHaveProperty("error");
    expect(files.has("/work/ro.txt")).toBe(false);
    expect(h.events).toContainEqual({ kind: "blocked", tool: "write /work/ro.txt" });
  });

  it("denies writes to .git/hooks", async () => {
    const h = setup();
    const r = await call(h, 106, "fs/write_text_file", { path: "/work/.git/hooks/pre-commit", content: "#!/bin/sh" });
    expect(r).toHaveProperty("error");
    expect(files.has("/work/.git/hooks/pre-commit")).toBe(false);
  });

  it("reports IO failures as errors", async () => {
    const h = setup();
    expect(await call(h, 107, "fs/read_text_file", { path: "/work/missing.txt" })).toHaveProperty("error");
  });

  it("answers method-not-found when no handlers are supplied, and for terminal", async () => {
    const h = harness({ initialize: init(), "session/new": () => ({ sessionId: "s" }) });
    expect(await call(h, 108, "fs/read_text_file", { path: "/work/a.txt" })).toMatchObject({ error: { code: -32601 } });
    expect(await call(h, 109, "terminal/create", { command: "ls" })).toMatchObject({ error: { code: -32601 } });
  });

  it("uses additional roots when given", async () => {
    files.set("/extra/b.txt", "b");
    const h = setup({ roots: ["/work", "/extra"] });
    expect(await call(h, 110, "fs/read_text_file", { path: "/extra/b.txt" })).toMatchObject({ result: { content: "b" } });
  });
});

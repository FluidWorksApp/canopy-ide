// If this goes red, the companion will break in a cloud workspace.
//
// The companion belongs to no project and floats over the app, so its CLI runs
// on the computer showing the IDE in every mode. In a cloud workspace every
// command NOT in the workspace host's desktop-local set is sent to the VM,
// which answers "The Linux workspace does not support companion_spawn yet".
// A new companion command must join that set, not be routed case by case.
/// <reference types="node" />
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const calls: string[] = [];
const events: string[] = [];
vi.mock("./host", () => ({
  invoke: vi.fn(async (command: string) => {
    calls.push(command);
    return command === "companion_status" ? { running: false, generation: 0 } : null;
  }),
  invokeDesktop: vi.fn(async (command: string) => {
    calls.push(command);
    return {};
  }),
  listen: vi.fn(async (event: string) => {
    events.push(event);
    return () => {};
  }),
  createChannel: () => ({ onmessage: () => {} }),
  isRemoteHost: () => false,
  isWorkspaceHost: () => false,
  isReadOnlyHost: () => false,
}));

import * as ipc from "./ipc";
import { startOneshot, startStructured } from "./companionTransport";
import {
  COMPANION_DESKTOP_EVENTS,
  isDesktopLocal,
} from "./remoteExecution/NativeWorkspaceHost";

const launch = {
  bin: "codex",
  sessionId: "",
  systemPrompt: "BRIEF",
  roots: [],
  model: "",
  authority: "read" as const,
};

beforeEach(() => {
  calls.length = 0;
  events.length = 0;
});

describe("the companion runs on the desktop in a cloud workspace", () => {
  it("routes every command the transports invoke to the desktop", async () => {
    const host = { emit: () => {} };
    const oneshot = startOneshot("codex", launch, host, {
      sessionId: null,
      onSession: () => {},
    });
    await oneshot.send("hi");
    await oneshot.cancelTurn?.();
    await oneshot.stop();
    const structured = await startStructured(
      "claude",
      { ...launch, bin: "claude", sessionId: "s1" },
      host,
      { resume: false },
    );
    await structured.send("hi").catch(() => {});
    await structured.stop();
    expect(calls).toContain("companion_spawn");
    expect(calls).toContain("companion_kill");
    expect(calls.filter((c) => !isDesktopLocal(c))).toEqual([]);
  });

  it("routes the companion's own stores and bridge commands to the desktop", async () => {
    await ipc.companionWrite("{}");
    await ipc.companionStatus();
    await ipc.canopyStoreRead("memory.json");
    await ipc.canopyStoreWrite("memory.json", "{}");
    await ipc.companionSaveAttachment("a.png", "");
    await ipc.companionDispatchOrigin(null);
    await ipc.companionOpenRequests("slack:1");
    await ipc.browserResult(1, true, null);
    expect(calls.filter((c) => !isDesktopLocal(c))).toEqual([]);
  });

  it("hears the desktop bridge's companion events", async () => {
    await ipc.onCompanionReply(() => {});
    await ipc.onAgentUi(() => {});
    await ipc.onAgentAction(() => {});
    await ipc.onAgentBrowser(() => {});
    expect(events.filter((e) => !(COMPANION_DESKTOP_EVENTS as readonly string[]).includes(e))).toEqual([]);
  });

  it("covers every companion_* command anywhere in the app", () => {
    const src = join(process.cwd(), "src");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(name) && !/\.test\./.test(name)) files.push(path);
      }
    };
    walk(src);
    const commands = new Set<string>();
    for (const file of files) {
      for (const m of readFileSync(file, "utf8").matchAll(/invoke(?:<[^;]*?>)?\(\s*["'`](companion_[a-z_]+)["'`]/g)) {
        commands.add(m[1]);
      }
    }
    // And every one the desktop registers, called from the app or not yet.
    const lib = readFileSync(join(process.cwd(), "src-tauri/src/lib.rs"), "utf8");
    for (const m of lib.matchAll(/\b(?:companion|context)::(companion_[a-z_]+)/g)) commands.add(m[1]);
    expect(commands.size).toBeGreaterThan(5);
    expect([...commands].filter((c) => !isDesktopLocal(c))).toEqual([]);
  });
});

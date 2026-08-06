/** The task identity crosses four languages/surfaces. A partial propagation is
 * worse than none: the UI appears task-aware while hooks or bridge calls are
 * attributed to a PTY guess. Keep the reservation, spawn, event, digest and
 * authenticated caller vocabulary wired as one contract. */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

function rustFn(source: string, name: string): string {
  const start = source.search(new RegExp(`(^|\\s)fn\\s+${name}\\s*[(<]`, "m"));
  expect(start, `missing Rust fn ${name}`).toBeGreaterThanOrEqual(0);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    if (source[i] === "}") depth -= 1;
    if (depth === 0) return source.slice(open, i + 1);
  }
  throw new Error(`unterminated Rust fn ${name}`);
}

describe("managed attempt identity propagation", () => {
  it("validates reservations before either PTY command starts a process", () => {
    const pty = read("src-tauri/src/pty.rs");
    for (const name of ["pty_spawn", "pty_spawn_detached"]) {
      const body = rustFn(pty, name);
      expect(body).toContain("tasks.spawn_binding");
      expect(body).toContain("finish_task_spawn");
    }
    const finish = rustFn(pty, "finish_task_spawn");
    expect(finish).toContain("mark_launch_failed");
    expect(finish).toContain("mark_spawned");
    const spawn = rustFn(pty, "spawn");
    expect(spawn.indexOf("child.kill()")).toBeGreaterThan(
      spawn.indexOf("try_clone_reader()"),
    );
    expect(spawn.indexOf("child.wait()")).toBeGreaterThan(
      spawn.indexOf("try_clone_reader()"),
    );

    const tasks = read("src-tauri/src/tasks.rs");
    expect(rustFn(tasks, "spawn_binding")).toContain("a.state = 'reserved'");
    expect(rustFn(tasks, "spawn_binding")).toContain("state = 'launching'");
    expect(rustFn(tasks, "mark_launch_failed")).toContain("process-launch");
  });

  it("stamps only the store-proven identity after caller env", () => {
    const spawn = rustFn(read("src-tauri/src/pty.rs"), "spawn");
    const callerEnv = spawn.indexOf("extra_env.unwrap_or_default()");
    const runStamp = spawn.indexOf('cmd.env("CANOPY_RUN_ID"');
    const attemptStamp = spawn.indexOf('cmd.env("CANOPY_ATTEMPT_ID"');
    expect(callerEnv).toBeGreaterThanOrEqual(0);
    expect(runStamp).toBeGreaterThan(callerEnv);
    expect(attemptStamp).toBeGreaterThan(callerEnv);
    expect(spawn).toContain('"CANOPY_RUN_ID" | "CANOPY_ATTEMPT_ID"');
  });

  it("carries the same ids through hooks, digests, bridge identity and TS", () => {
    const hook = read("src-tauri/src/bin/canopy_hook.rs");
    expect(rustFn(hook, "publish_to_bus")).toContain("canopy_run_id");
    expect(rustFn(hook, "publish_to_bus")).toContain("canopy_attempt_id");
    expect(rustFn(hook, "authenticated_task_identity")).toContain(
      "/ctx/identity",
    );
    expect(rustFn(hook, "update_digest")).toContain('digest["run_id"]');
    expect(rustFn(hook, "update_digest")).toContain('digest["attempt_id"]');

    const context = read("src-tauri/src/context.rs");
    const identity = context.slice(
      context.indexOf("pub struct AgentIdentity"),
      context.indexOf("impl AgentIdentity"),
    );
    expect(identity).toContain("pub run_id: Option<String>");
    expect(identity).toContain("pub attempt_id: Option<String>");
    expect(
      context.slice(
        context.indexOf("pub fn mint_agent"),
        context.indexOf("pub fn mint_agent") + 400,
      ),
    ).toContain("AttemptBinding");
    expect(context).toContain('.route("/ctx/identity", get(identity))');

    const ipc = read("src/ipc.ts");
    expect(ipc).toContain("runId?: string");
    expect(ipc).toContain("attemptId?: string");
    const digest = ipc.slice(
      ipc.indexOf("export interface SessionDigest"),
      ipc.indexOf("export interface SessionDigest") + 5000,
    );
    expect(digest).toContain("run_id?: string");
    expect(digest).toContain("attempt_id?: string");

    const notifications = read("shared/notifications.ts");
    expect(notifications).toContain("parsed.canopy_run_id");
    expect(notifications).toContain("parsed.canopy_attempt_id");
  });
});

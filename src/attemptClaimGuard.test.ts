/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

describe("attempt-scoped claim lifecycle", () => {
  it("stores durable run and attempt identity on claims", () => {
    const context = read("src-tauri/src/context.rs");
    const claim = context.slice(
      context.indexOf("pub struct Claim"),
      context.indexOf("pub struct Refusal"),
    );
    expect(claim).toContain("pub run_id: Option<String>");
    expect(claim).toContain("pub attempt_id: Option<String>");
    expect(context).toContain("crate::mesh::ClaimStore");
    expect(read("src-tauri/src/mesh.rs")).toContain("PRAGMA journal_mode = WAL");
  });

  it("releases only after durable settlement succeeds", () => {
    const tasks = read("src-tauri/src/tasks.rs");
    const command = tasks.slice(
      tasks.indexOf("pub fn task_attempt_settle("),
      tasks.indexOf("pub fn task_attempt_wait("),
    );
    const settle = command.indexOf("store.settle_attempt(input)?");
    const release = command.indexOf("release_claims_for_attempt");
    expect(settle).toBeGreaterThan(-1);
    expect(release).toBeGreaterThan(settle);
    expect(command).toContain('release_claims_for_attempt(&app, &attempt_id, "settled")?');
  });

  it("does not release directly on job_done before verification and settlement", () => {
    const app = read("src/App.tsx");
    const done = app.slice(
      app.indexOf('if (a.kind === "job_done")'),
      app.indexOf("if (d?.projectId !== project.id)"),
    );
    expect(done).not.toContain("releaseClaim");
    expect(done).not.toContain("contextReleaseClaim");
  });

  it("releases crashed PTY and structured attempts through the death path", () => {
    const pty = read("src-tauri/src/pty.rs");
    expect(pty).toContain("release_claims_for_pty(&app, session.id)");
    const runner = read("src-tauri/src/structured_runner.rs");
    expect(runner).toContain('release_claims_for_attempt(&watch_app, &watch_attempt, "death")');
    expect(runner).toContain("mint_attempt(&cwd, &binding)");
  });

  it("exposes durable per-path history to the frontend and agents", () => {
    const ipc = read("src/ipc.ts");
    expect(ipc).toContain("context_claim_history_for_path");
    const hook = read("src-tauri/src/bin/canopy_hook.rs");
    expect(hook).toContain('["claim", "release", "history"]');
    expect(read("src-tauri/src/context.rs")).toContain('req.action == "history"');
    expect(read("src-tauri/src/context.rs")).toContain("path_is_within(&req.paths[0], cwd)");
  });
});

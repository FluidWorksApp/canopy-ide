import { webcrypto } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { applyMigrations, inspectMigrations, listProviderProjects, parseMigrationStatus, parseProviderProjects, type ProviderDeps } from "./buildProviders";

beforeAll(() => { vi.stubGlobal("crypto", webcrypto); });

function fixture() {
  let applied = false;
  const deps: ProviderDeps = {
    projectsViaMcp: vi.fn(async () => null),
    list: vi.fn(async () => ["202609070001_users.sql"]),
    read: vi.fn(async (path) => path.endsWith("project-ref") ? "project-one" : "create table users(id bigint);"),
    run: vi.fn(async (argv) => {
      if (argv.includes("up")) { applied = true; return "Applied"; }
      if (argv.includes("projects")) return JSON.stringify([{ id: "project-one", name: "App" }]);
      return `Local | Remote | Time\n202609070001 | ${applied ? "202609070001" : ""} | today`;
    }),
    acquire: vi.fn(async () => vi.fn(async () => {})),
  };
  return deps;
}

describe("verified provider access", () => {
  it("uses a working account tool before a CLI", async () => {
    const deps = fixture();
    deps.projectsViaMcp = async () => [{ id: "project-one", name: "App" }];
    expect(await listProviderProjects("supabase", "/app", deps)).toHaveLength(1);
    expect(deps.run).not.toHaveBeenCalled();
  });
  it("falls back to a JSON CLI response, never treating config presence as access", async () => {
    const deps = fixture();
    expect(await listProviderProjects("supabase", "/app", deps)).toEqual([{ id: "project-one", name: "App" }]);
    expect(deps.run).toHaveBeenCalledWith(["supabase", "projects", "list", "--output", "json"], "/app");
  });
  it("normalizes Firebase results and rejects malformed identities", () => {
    expect(parseProviderProjects({ result: [{ projectId: "my-app", displayName: "App" }] }, "firebase")).toEqual([{ id: "my-app", name: "App" }]);
    expect(() => parseProviderProjects([{ id: "--project=evil" }], "supabase")).toThrow();
    expect(() => parseProviderProjects({ error: "unauthorized" }, "supabase")).toThrow();
  });
});

describe("migration execution", () => {
  it("refuses drift instead of repairing remote history automatically", () => {
    expect(() => parseMigrationStatus("Local | Remote | Time\n | 202609070001 | today")).toThrow(/differs/);
    expect(() => parseMigrationStatus("Logged out")).toThrow(/history/);
  });
  it("persists intent before execution and observes applied history before success", async () => {
    const deps = fixture();
    const plan = await inspectMigrations("supabase", "/app", "project-one", "production", deps);
    const states: string[] = [];
    await applyMigrations(plan, plan.fingerprint, async (status) => { states.push(status); }, deps);
    expect(states).toEqual(["running", "succeeded"]);
    expect(deps.run).toHaveBeenCalledWith(["supabase", "migration", "up", "--linked", "--yes"], "/app");
  });
  it("rejects edits between review and approval without running a migration", async () => {
    const deps = fixture();
    const plan = await inspectMigrations("supabase", "/app", "local", "local", deps);
    deps.read = async () => "drop table users;";
    const persist = vi.fn();
    await expect(applyMigrations(plan, plan.fingerprint, persist, deps)).rejects.toThrow(/changed/);
    expect(persist).not.toHaveBeenCalled();
    expect(vi.mocked(deps.run).mock.calls.some(([argv]) => argv.includes("up"))).toBe(false);
  });
  it("does not execute if recording intent fails", async () => {
    const deps = fixture();
    const plan = await inspectMigrations("supabase", "/app", "local", "local", deps);
    await expect(applyMigrations(plan, plan.fingerprint, async () => { throw new Error("disk full"); }, deps)).rejects.toThrow("disk full");
    expect(vi.mocked(deps.run).mock.calls.some(([argv]) => argv.includes("up"))).toBe(false);
  });
  it("records unknown outcomes after an execution failure", async () => {
    const deps = fixture();
    const plan = await inspectMigrations("supabase", "/app", "local", "local", deps);
    const run = deps.run;
    deps.run = async (argv, cwd) => { if (argv.includes("up")) throw new Error("connection lost"); return run(argv, cwd); };
    const states: string[] = [];
    await expect(applyMigrations(plan, plan.fingerprint, async (status) => { states.push(status); }, deps)).rejects.toThrow("connection lost");
    expect(states).toEqual(["running", "unknown"]);
  });
  it("refuses a stale linked project", async () => {
    await expect(inspectMigrations("supabase", "/app", "wrong-project", "production", fixture())).rejects.toThrow(/different project/);
  });
  it("does not turn Firebase document migrations into a SQL operation", async () => {
    const deps = fixture();
    deps.read = async (path) => path.endsWith("firebase.json") ? JSON.stringify({ firestore: { rules: "firestore.rules", indexes: "firestore.indexes.json" } }) : "{}";
    const plan = await inspectMigrations("firebase", "/app", "local", "local", deps);
    await expect(applyMigrations(plan, plan.fingerprint, vi.fn(), deps)).rejects.toThrow(/emulators/);
    expect(deps.run).not.toHaveBeenCalled();
  });
});

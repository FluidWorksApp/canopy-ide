import { describe, expect, it } from "vitest";
import type { Component, RunCommand } from "../../projects";
import { vibeRunReady, vibeSetupGate } from "./helpers";

const serve: RunCommand = {
  id: "run-serve",
  name: "API server",
  command: "npm run dev",
  purpose: "serve",
};
const install: RunCommand = {
  id: "run-install",
  name: "Install packages",
  command: "npm install",
  purpose: "setup",
};
const component: Pick<Component, "id" | "commands"> = {
  id: "cmp-api",
  commands: [serve, install],
};

const notStarted = () => false;

describe("vibeSetupGate", () => {
  it("does not start the server before its setup has run", () => {
    // Today's bug: `ts-node-dev` launched into a checkout with no
    // node_modules, and Build showed a non-engineer the stack trace.
    const gate = vibeSetupGate(serve, component, [], notStarted);
    expect(gate.ready).toBe(false);
    expect(gate.start).toEqual([install]);
  });

  it("waits while setup is still running", () => {
    const gate = vibeSetupGate(
      serve,
      component,
      [{ componentId: "cmp-api", runCommandId: "run-install", exited: false }],
      () => true,
    );
    expect(gate.ready).toBe(false);
    expect(gate.start).toEqual([]);
    expect(gate.failed).toEqual([]);
  });

  it("starts the server once setup exits clean", () => {
    const gate = vibeSetupGate(
      serve,
      component,
      [{ componentId: "cmp-api", runCommandId: "run-install", exited: true, exitCode: 0 }],
      () => true,
    );
    expect(gate.ready).toBe(true);
  });

  it("treats a reaped setup chore as done, not as never-run", () => {
    // A successful chore closes its own tab (runReap). The auto-start ledger
    // is the surviving record; without this the gate would re-install forever.
    const gate = vibeSetupGate(serve, component, [], () => true);
    expect(gate.ready).toBe(true);
    expect(gate.start).toEqual([]);
  });

  it("blocks the server and reports the setup that failed", () => {
    const gate = vibeSetupGate(
      serve,
      component,
      [{ componentId: "cmp-api", runCommandId: "run-install", exited: true, exitCode: 1 }],
      () => true,
    );
    expect(gate.ready).toBe(false);
    expect(gate.failed).toEqual([install]);
  });

  it("never gates a setup command on itself", () => {
    const gate = vibeSetupGate(install, component, [], notStarted);
    expect(gate.ready).toBe(true);
    expect(gate.start).toEqual([]);
  });

  it("does not automatically apply a managed migration", () => {
    const managedMigration: RunCommand = {
      ...install,
      id: "run-managed-migration",
      name: "Push schema",
      automatic: false,
    };
    const gate = vibeSetupGate(
      serve,
      { ...component, commands: [serve, managedMigration] },
      [],
      notStarted,
    );
    expect(gate.ready).toBe(true);
    expect(gate.start).toEqual([]);
  });

  it("runs setup in declaration order instead of racing install and migration", () => {
    const migrate: RunCommand = {
      id: "run-migrate",
      name: "Apply local schema",
      command: "npm run db:migrate",
      purpose: "setup",
      automatic: true,
    };
    const withMigration = { ...component, commands: [serve, install, migrate] };
    expect(vibeSetupGate(serve, withMigration, [], notStarted).start).toEqual([install]);
    expect(vibeSetupGate(
      serve,
      withMigration,
      [{ componentId: "cmp-api", runCommandId: "run-install", exited: true, exitCode: 0 }],
      (id) => id === "run-install",
    ).start).toEqual([migrate]);
  });
});

describe("vibeRunReady", () => {
  it("waits for a declared port before releasing dependent processes", () => {
    const tab = { ptyId: 7, exited: false };
    const command = { readiness: { kind: "port" as const } };
    expect(vibeRunReady(tab, command, [{ id: 7, ports: [] }])).toBe(false);
    expect(vibeRunReady(tab, command, [{ id: 7, ports: [5432] }])).toBe(true);
  });

  it("accepts a live worker with process-alive readiness", () => {
    expect(vibeRunReady(
      { ptyId: 9, exited: false },
      { readiness: { kind: "process-alive" } },
      [],
      new Set([9]),
    )).toBe(true);
  });

  it("does not accept a live worker before output supervision verifies it", () => {
    expect(vibeRunReady(
      { ptyId: 9, exited: false },
      { readiness: { kind: "process-alive" } },
      [],
      new Set(),
    )).toBe(false);
  });
});

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AgentRelays, relayFrom, type RelayOp, type RelaySource } from "./agentRelay";
import { ALLOW, DECLINE, consentQuestion, consentThrough, forgetConsent, handleMachineOp, hasConsent } from "./directory";
import { forgetCheckouts, type KnownMachine, type MachineDirectory } from "./ops";
import { desktopMachine, dispose, workspaceMachine, type TestMachine } from "./testMachines";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

interface Relay {
  submit(op: Record<string, unknown>): Promise<{ ok: boolean; body: string }>;
  poll(args: unknown): Promise<unknown>;
  result(args: unknown): unknown;
  close(): Promise<void>;
}

/** The host's real relay (packages/remote-host/machine-relay.mjs), reached the
 *  way the window reaches it: as two host commands. */
async function hostRelay(): Promise<{ relay: Relay; source: RelaySource; calls: string[] }> {
  const { MachineRelay } = await import(/* @vite-ignore */ path.resolve(__dirname, "../../packages/remote-host/machine-relay.mjs"));
  const relay = new MachineRelay({}) as Relay;
  const calls: string[] = [];
  const source: RelaySource = {
    id: "work-0a1b2c3d",
    name: "Build Box",
    invoke: async (command, args) => {
      calls.push(command);
      if (command === "machine_relay_poll") return relay.poll(args);
      if (command === "machine_relay_result") return relay.result(args);
      throw new Error(`The Linux workspace does not support ${command} yet`);
    },
  };
  return { relay, source, calls };
}

const op = (extra: Record<string, unknown> = {}) => ({ op: "machine", machineOp: "list", machineArgs: {}, cwd: "/workspace/app", ptyId: 4, ...extra });
const until = async (check: () => boolean) => {
  for (let i = 0; i < 400 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(check()).toBe(true);
};

describe("the window's relay loop", () => {
  const stops: Array<() => void> = [];
  afterEach(() => {
    for (const stop of stops.splice(0)) stop();
  });

  it("carries out what an agent on the machine asked and returns the answer", async () => {
    const { relay, source } = await hostRelay();
    const seen: RelayOp[] = [];
    stops.push(
      relayFrom(source, {
        waitMs: 50,
        handle: async (taken, from) => {
          seen.push(taken);
          return { machines: [from.name] };
        },
      }),
    );
    await until(() => true);
    await relay.poll({ wait: 0 });
    const reply = await relay.submit(op({ machineArgs: { verbose: true } }));
    expect(reply).toEqual({ ok: true, body: '{"machines":["Build Box"]}' });
    expect(seen).toEqual([{ id: "1", machineOp: "list", machineArgs: { verbose: true }, cwd: "/workspace/app", ptyId: 4 }]);
  });

  it("returns a refusal as the agent's error, in its own words", async () => {
    const { relay, source } = await hostRelay();
    stops.push(
      relayFrom(source, {
        waitMs: 50,
        handle: async () => {
          throw new Error("Build Box has changes of its own.");
        },
      }),
    );
    await relay.poll({ wait: 0 });
    expect(await relay.submit(op({ machineOp: "sync" }))).toEqual({ ok: false, body: "Build Box has changes of its own." });
  });

  it("keeps asking while an op is still being carried out", async () => {
    const { relay, source, calls } = await hostRelay();
    let finish: (value: unknown) => void = () => {};
    const order: string[] = [];
    stops.push(
      relayFrom(source, {
        waitMs: 20,
        handle: (taken) => {
          order.push(taken.machineOp);
          return taken.machineOp === "run" ? new Promise((resolve) => (finish = resolve)) : Promise.resolve("quick");
        },
      }),
    );
    await relay.poll({ wait: 0 });
    const slow = relay.submit(op({ machineOp: "run" }));
    await until(() => order.includes("run"));
    const polls = calls.filter((c) => c === "machine_relay_poll").length;
    // A second op is taken and answered while the first is still running.
    expect(await relay.submit(op())).toEqual({ ok: true, body: "quick" });
    await until(() => calls.filter((c) => c === "machine_relay_poll").length > polls + 1);
    finish({ code: 0 });
    expect(await slow).toEqual({ ok: true, body: '{"code":0}' });
  });

  it("stops asking a host that has no relay, and backs off from one that is unreachable", async () => {
    const calls: string[] = [];
    const sleeps: number[] = [];
    stops.push(
      relayFrom(
        {
          id: "old",
          name: "Old Host",
          invoke: async (command) => {
            calls.push(command);
            throw new Error("The Linux workspace does not support machine_relay_poll yet");
          },
        },
        { handle: async () => null, sleep: async (ms) => void sleeps.push(ms) },
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls).toEqual(["machine_relay_poll"]);
    expect(sleeps).toEqual([]);
    // The window's own workspace words the same thing as an older host.
    stops.push(
      relayFrom(
        {
          id: "old-active",
          name: "Old Active",
          invoke: async (command) => {
            calls.push(`active:${command}`);
            throw new Error("This workspace is running an older Canopy host. Restart or update the workspace to use everything in this version of Canopy.");
          },
        },
        { handle: async () => null, sleep: async (ms) => void sleeps.push(ms) },
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls).toEqual(["machine_relay_poll", "active:machine_relay_poll"]);
    expect(sleeps).toEqual([]);

    let failures = 0;
    const { relay, source } = await hostRelay();
    const flaky: RelaySource = {
      ...source,
      invoke: async (command, args) => {
        if (command === "machine_relay_poll" && failures++ < 3) throw new Error("connection lost");
        return source.invoke(command, args);
      },
    };
    stops.push(relayFrom(flaky, { waitMs: 20, handle: async () => "back", sleep: async (ms) => void sleeps.push(ms) }));
    await until(() => failures > 3);
    expect(sleeps).toEqual([1000, 2000, 5000]);
    expect(await relay.submit(op())).toEqual({ ok: true, body: "back" });
  });

  it("answers for each machine once, and lets go of one that is gone", async () => {
    const a = await hostRelay();
    const b = await hostRelay();
    b.source.id = "work-b";
    const relays = new AgentRelays({ waitMs: 20, handle: async (_taken, from) => from.id });
    stops.push(() => relays.stop());
    relays.set([a.source, b.source]);
    relays.set([a.source, b.source]);
    expect(relays.ids()).toEqual(["work-0a1b2c3d", "work-b"]);
    await a.relay.poll({ wait: 0 });
    await b.relay.poll({ wait: 0 });
    expect(await a.relay.submit(op())).toEqual({ ok: true, body: "work-0a1b2c3d" });
    expect(await b.relay.submit(op())).toEqual({ ok: true, body: "work-b" });

    relays.set([a.source]);
    expect(relays.ids()).toEqual(["work-0a1b2c3d"]);
    await new Promise((resolve) => setTimeout(resolve, 60));
    const before = b.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(b.calls.length).toBe(before);

    // The same machine on a new connection gets a loop on that connection.
    const again = { ...a.source, invoke: vi.fn(a.source.invoke) };
    relays.set([again]);
    await until(() => again.invoke.mock.calls.length > 0);
  });
});

describe("consent", () => {
  const request = { from: { id: "work-1", name: "Build Box" }, to: { id: "local", name: "This Mac" }, repository: "github.com/acme/app" };
  beforeEach(() => forgetConsent());

  it("asks once, remembers a yes, and asks again after a no", async () => {
    const questions: string[] = [];
    let reply = DECLINE;
    const consent = consentThrough(async (question, options) => {
      questions.push(question);
      expect(options).toEqual([ALLOW, DECLINE]);
      return reply;
    });
    expect(await consent(request)).toBe(false);
    expect(hasConsent(request)).toBe(false);
    reply = ALLOW;
    expect(await consent(request)).toBe(true);
    expect(await consent(request)).toBe(true);
    expect(questions).toEqual([consentQuestion(request), consentQuestion(request)]);
    expect(questions[0]).toBe("Let agents on Build Box run commands and move files on This Mac for github.com/acme/app?");
    // The other direction, and another repository, are their own questions.
    expect(hasConsent({ ...request, from: request.to, to: request.from })).toBe(false);
    expect(hasConsent({ ...request, repository: "github.com/acme/other" })).toBe(false);
  });

  it("puts one dialog up for requests that arrive together, and treats a closed one as no", async () => {
    let asked = 0;
    let settle: (answer: string) => void = () => {};
    const consent = consentThrough(() => {
      asked++;
      return new Promise<string>((resolve) => (settle = resolve));
    });
    const both = Promise.all([consent(request), consent(request)]);
    settle(ALLOW);
    expect(await both).toEqual([true, true]);
    expect(asked).toBe(1);

    forgetConsent();
    const failing = consentThrough(async () => {
      throw new Error("window closed");
    });
    expect(await failing(request)).toBe(false);
    expect(hasConsent(request)).toBe(false);
  });
});

describe("an agent on the build machine, end to end", () => {
  let mac: TestMachine;
  let box: TestMachine;
  let hereDir: string;
  let thereDir: string;
  let stop: () => void = () => {};
  let relay: Relay;
  const questions: string[] = [];

  const git = (dir: string, ...args: string[]) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } }).trim();

  beforeAll(async () => {
    forgetConsent();
    forgetCheckouts();
    mac = desktopMachine();
    box = await workspaceMachine();
    const origin = path.join(mac.home, "origin.git");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
    hereDir = path.join(mac.home, "code", "app");
    thereDir = path.join(box.home, "root", "app");
    for (const dir of [hereDir, thereDir]) {
      mkdirSync(path.dirname(dir), { recursive: true });
      execFileSync("git", ["clone", "-q", origin, dir], { stdio: "ignore" });
      git(dir, "config", "user.name", "Test");
      git(dir, "config", "user.email", "test@example.invalid");
    }
    writeFileSync(path.join(thereDir, "main.c"), "int main(void) { return 0; }\n");
    writeFileSync(path.join(thereDir, ".gitignore"), "build/\n");
    git(thereDir, "add", "-A");
    git(thereDir, "commit", "-q", "-m", "first");
    git(thereDir, "push", "-q", "origin", "HEAD:main");
    git(hereDir, "pull", "-q", "origin", "main");
    git(hereDir, "remote", "set-url", "origin", "git@github.com:acme/app.git");
    git(thereDir, "remote", "set-url", "origin", "https://github.com/acme/app");
    mac.projects.push(hereDir);
    box.projects.push(path.dirname(thereDir));

    const known = (): KnownMachine[] => [
      { id: "local", name: "This Mac", kind: "this-mac", reachable: true },
      { id: box.id, name: box.name, kind: "own", reachable: true },
    ];
    const directory: MachineDirectory = {
      list: async () => known(),
      open: async (id) => (id === "local" ? mac : box),
    };
    const host = await hostRelay();
    relay = host.relay;
    // What App.tsx does: the op comes from the machine whose relay it was on.
    stop = relayFrom(
      { ...host.source, id: box.id, name: box.name },
      {
        waitMs: 50,
        handle: (taken, from) =>
          handleMachineOp(
            { kind: taken.machineOp, args: taken.machineArgs, originId: from.id, cwd: taken.cwd },
            async (question) => {
              questions.push(question);
              return ALLOW;
            },
            directory,
          ),
      },
    );
    await relay.poll({ wait: 0 });
  });
  afterAll(async () => {
    stop();
    await relay.close();
    dispose(mac, box);
  });

  it("builds where it is and installs on this Mac, asking the person once", async () => {
    // The agent edits and builds on its own machine...
    writeFileSync(path.join(thereDir, "main.c"), "int main(void) { return 42; }\n");
    mkdirSync(path.join(thereDir, "build"), { recursive: true });
    writeFileSync(path.join(thereDir, "build", "app.bin"), "binary-42");
    // ...ships the artifact to the Mac...
    const copied = await relay.submit(op({ machineOp: "copy", machineArgs: { from: "here", to: "this-mac", path: "build/app.bin" }, cwd: thereDir }));
    expect(copied.ok, copied.body).toBe(true);
    // ...and runs the install there, where the device is plugged in. A run
    // first brings that checkout in line with the agent's, so the command
    // sees the same source the artifact was built from.
    const ran = await relay.submit(op({ machineOp: "run", machineArgs: { machine: "this-mac", command: "cat build/app.bin main.c" }, cwd: thereDir }));
    expect(ran.ok, ran.body).toBe(true);
    const result = JSON.parse(ran.body) as { stdout?: string; output?: string };
    expect(JSON.stringify(result)).toContain("binary-42");
    expect(JSON.stringify(result)).toContain("return 42");
    expect(questions).toEqual(["Let agents on Build Box run commands and move files on This Mac for github.com/acme/app?"]);
  });

  it("tells the agent what was wrong when the request cannot be carried out", async () => {
    const reply = await relay.submit(op({ machineOp: "run", machineArgs: { machine: "Nowhere", command: "true" }, cwd: thereDir }));
    expect(reply.ok).toBe(false);
    expect(reply.body).toMatch(/Nowhere/);
  });
});

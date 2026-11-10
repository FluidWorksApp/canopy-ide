// The companion normally starts with no cwd and Rust places it in its own
// directory. An ACP agent refuses a session that has no absolute working
// directory ("ACP needs an absolute working directory."), which is how a
// companion on Kiro failed on its first message.
import { beforeEach, describe, expect, it, vi } from "vitest";

const launches: { cwd?: string }[] = [];
let tier: "acp" | "structured" = "acp";

vi.mock("./ipc", () => ({
  companionDir: vi.fn(async () => "/Users/someone/.canopy/companion"),
  companionSpawn: vi.fn(),
  companionWrite: vi.fn(),
  companionKill: vi.fn(),
}));
vi.mock("./projects", () => ({
  structuredRunnerFor: () => ({ tier }),
  shellBin: (b: string) => b,
  shellQuote: (t: string) => t,
}));
vi.mock("./projectRunner", () => ({
  startStructured: vi.fn(async (_kind: string, _cli: string, launch: { policy: { cwd?: string } }) => {
    launches.push({ cwd: launch.policy.cwd });
    return { send: async () => {}, stop: async () => {} };
  }),
  withSessionEnv: (e: unknown) => e,
}));

import * as ipc from "./ipc";
import { startStructured } from "./companionTransport";

const launch = {
  bin: "kiro-cli",
  sessionId: "s",
  systemPrompt: "brief",
  roots: [],
  model: "",
  authority: "read-only",
} as never;

beforeEach(() => {
  launches.length = 0;
  vi.mocked(ipc.companionDir).mockClear();
});

describe("startStructured", () => {
  it("gives an ACP companion its own absolute directory", async () => {
    tier = "acp";
    await startStructured("kiro", launch, { emit: () => {} } as never, { resume: false });
    expect(ipc.companionDir).toHaveBeenCalledOnce();
    expect(launches[0].cwd).toBe("/Users/someone/.canopy/companion");
  });

  it("leaves a stream-json CLI without a cwd, as before", async () => {
    tier = "structured";
    await startStructured("claude", launch, { emit: () => {} } as never, { resume: false });
    expect(ipc.companionDir).not.toHaveBeenCalled();
    expect(launches[0].cwd).toBeUndefined();
  });

  it("keeps a cwd the caller chose", async () => {
    tier = "acp";
    await startStructured("kiro", launch, { emit: () => {} } as never, { resume: false, cwd: "/work/x" });
    expect(ipc.companionDir).not.toHaveBeenCalled();
    expect(launches[0].cwd).toBe("/work/x");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const spotSaveContextText = vi.fn(async (_dir: string, _text: string) => "/repo/.canopy/spot/brief-1.md");
const jsLog = vi.fn(async (_level: string, _msg: string) => {});

vi.mock("./ipc", () => ({
  spotSaveContextText: (dir: string, text: string) => spotSaveContextText(dir, text),
  jsLog: (level: string, msg: string) => jsLog(level, msg),
}));

import {
  MAX_CANON,
  SAFE_LINE_BYTES,
  byteLength,
  briefPointer,
  fitsOnOneLine,
  pickLaunchCli,
  startCommandParked,
} from "./agentSeed";
import { AGENT_CLIS } from "./projects";
import { updateSettings } from "./settings";

beforeEach(() => {
  spotSaveContextText.mockClear();
  jsLog.mockClear();
  spotSaveContextText.mockResolvedValue("/repo/.canopy/spot/brief-1.md");
});

describe("byteLength", () => {
  it("counts bytes, not characters", () => {
    // The distinction that made the original bug invisible to a length check:
    // an em-dash is one character and three bytes.
    expect("—".length).toBe(1);
    expect(byteLength("—")).toBe(3);
  });
});

describe("fitsOnOneLine", () => {
  it("passes an ordinary command", () => {
    expect(fitsOnOneLine("claude 'fix the failing test in src/foo.ts'")).toBe(true);
  });

  it("stays under what a canonical-mode tty will hold", () => {
    expect(SAFE_LINE_BYTES).toBeLessThan(MAX_CANON);
  });

  it("rejects the brief that was silently truncated", () => {
    // The real one, rebuilt: four screenshots with their paths, the serving
    // component, and a note each. It reached 1024 bytes inside the fourth path
    // and the shell was left at a `quote>` prompt.
    const shot = (n: number) =>
      `(${n}) /Users/shoaib/Documents/GitHub/coraa-app/coraa-agent/.canopy/spot/ctx-178529325${n}.png, ` +
      `a region of the page at http://localhost:3000/ — a note about what to change here`;
    const brief =
      `I took 4 screenshots of this project's running page at http://localhost:3000/. ` +
      `The page is served by the "website" run (\`pnpm run dev\`) working in the "coraa-ai" ` +
      `component, \`/Users/shoaib/Documents/GitHub/coraa-ai\` — that is the codebase to change. ` +
      `Read the image file(s) — they are PNGs on disk — then do what each note asks: ` +
      `${[1, 2, 3, 4].map(shot).join(" ")}`;
    expect(byteLength(brief)).toBeGreaterThan(MAX_CANON);
    expect(fitsOnOneLine(`claude '${brief}'`)).toBe(false);
  });

  it("counts the carriage return that is written after it", () => {
    // A line of exactly the budget still has a CR to follow, so it does not fit.
    expect(fitsOnOneLine("x".repeat(SAFE_LINE_BYTES))).toBe(false);
    expect(fitsOnOneLine("x".repeat(SAFE_LINE_BYTES - 1))).toBe(true);
  });

  it("is not fooled by multi-byte characters near the boundary", () => {
    // 300 em-dashes is 300 characters and 900 bytes.
    const dashes = "—".repeat(300);
    expect(dashes.length).toBeLessThan(SAFE_LINE_BYTES);
    expect(fitsOnOneLine(dashes)).toBe(false);
  });
});

describe("briefPointer", () => {
  it("names the file and is short enough to type", () => {
    const line = `claude '${briefPointer("/Users/x/p/.canopy/spot/brief-1785293237.md")}'`;
    expect(line).toContain("/Users/x/p/.canopy/spot/brief-1785293237.md");
    expect(fitsOnOneLine(line)).toBe(true);
  });
});

// The guard every launch site goes through — a ticket, a PR, a diff surface and
// a micro-task all build briefs with no length limit, and a guard at one of
// them is a guard at the one that happened to get reported.
describe("startCommandParked", () => {
  const long = "x".repeat(2000);

  it("types a short brief as it always did", async () => {
    const start = await startCommandParked("claude", "fix the failing test", "/repo");
    // Brief on the line, plus the working mode every task launch pins (see
    // AgentCli.unattended) — the parking guard is what's not triggered here.
    expect(start?.command).toBe("claude 'fix the failing test' --permission-mode auto");
    expect(spotSaveContextText).not.toHaveBeenCalled();
  });

  it("parks a long brief and points the agent at the file", async () => {
    const start = await startCommandParked("claude", long, "/repo");
    expect(spotSaveContextText).toHaveBeenCalledWith("/repo", long);
    expect(start?.command).toContain("/repo/.canopy/spot/brief-1.md");
    expect(start?.command).not.toContain(long);
    // The whole point: what is typed now fits.
    expect(fitsOnOneLine(start!.command)).toBe(true);
  });

  it("keeps the brief whole — nothing is trimmed to fit", async () => {
    await startCommandParked("claude", long, "/repo");
    expect(spotSaveContextText.mock.calls[0][1]).toHaveLength(long.length);
  });

  it("falls back to the old command when the brief cannot be written", async () => {
    spotSaveContextText.mockRejectedValue(new Error("outside every workspace root"));
    const start = await startCommandParked("claude", long, "/repo");
    expect(start?.command).toContain(long);
    expect(jsLog).toHaveBeenCalledWith("warn", expect.stringContaining("could not park"));
  });

  it("leaves a typed-prompt CLI alone — its text goes to a TUI, not a shell", async () => {
    // Aider takes no prompt argument: it launches bare and the brief is typed
    // in once its TUI is up, by which point the tty is in raw mode and has no
    // line limit. Nothing to park, and parking it would lose the prompt.
    const start = await startCommandParked("aider", long, "/repo");
    expect(start?.typePrompt).toBe(true);
    expect(start?.command).not.toContain("brief-1.md");
    expect(spotSaveContextText).not.toHaveBeenCalled();
  });

  it("says nothing about an agent it does not know", async () => {
    expect(await startCommandParked("not-an-agent", long, "/repo")).toBeNull();
  });
});

describe("pickLaunchCli", () => {
  // The registry is the real one, so these ids are the ones a user sees in
  // Settings. `installed` is the only thing stubbed, because "is it on this
  // machine" is the one input a test cannot have an opinion about.
  const only = (...bins: string[]) => (bin: string) => bins.includes(bin);
  const idOf = (bin: string) => AGENT_CLIS.find((c) => c.bin === bin)?.id;

  it("runs on the default agent, not on claude", () => {
    // The regression this exists for: Settings said OpenCode and every task and
    // every review still started Claude, because the micro-task launcher put
    // the name `claude` ahead of the setting.
    updateSettings({ defaultAgent: "opencode" });
    expect(pickLaunchCli(undefined, only("claude", "opencode"))?.id).toBe("opencode");
  });

  it("still picks claude when claude IS the default", () => {
    updateSettings({ defaultAgent: "claude" });
    expect(pickLaunchCli(undefined, only("claude", "opencode"))?.id).toBe("claude");
  });

  it("falls back to an installed CLI when the default isn't on this machine", () => {
    // A preference carried over from another machine must not launch nothing.
    updateSettings({ defaultAgent: "opencode" });
    expect(pickLaunchCli(undefined, only("codex"))?.id).toBe(idOf("codex"));
  });

  it("names the default even when nothing is detected on PATH", () => {
    // Detection lags a fresh install; endorsing the registry's first entry
    // there would put claude back in front of a setting that says otherwise.
    updateSettings({ defaultAgent: "amp" });
    expect(pickLaunchCli(undefined, () => false)?.id).toBe("amp");
  });

  it("lets an explicitly chosen CLI beat the default", () => {
    // What the split-button menus pass: the agent the user picked for this one
    // run, which is a stronger statement than the standing preference.
    updateSettings({ defaultAgent: "opencode" });
    expect(pickLaunchCli("codex", only("claude", "opencode", "codex"))?.id).toBe("codex");
  });

  it("returns nothing for a CLI the registry has never heard of", () => {
    // The callers turn this into "Unknown agent" rather than silently running
    // something else in its place.
    updateSettings({ defaultAgent: "claude" });
    expect(pickLaunchCli("not-an-agent", only("claude"))).toBeUndefined();
  });
});

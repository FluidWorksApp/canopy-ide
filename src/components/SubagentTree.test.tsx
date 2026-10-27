import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import type { SessionActivity, SubagentRun } from "../ipc";
import { ACTIVITY_FAST_MS, setSessionActivityReaderForTests, useSessionActivity } from "../sessionActivity";
import { SubagentTree } from "./SubagentTree";
import { fmtSpan, subagentCounts } from "../sessionActivity";
import { ContextControls } from "./ContextControls";
import { useCompaction, type CompactionDeps } from "../useCompaction";

const run = (over: Partial<SubagentRun>): SubagentRun => ({
  id: "t1",
  agent_id: null,
  description: "Find the bug",
  kind: "general-purpose",
  status: "running",
  background: false,
  started_ms: 1_000,
  ended_ms: null,
  duration_ms: null,
  tokens: null,
  tool_uses: null,
  result: null,
  ...over,
});
const activity = (over: Partial<SessionActivity> = {}): SessionActivity => ({ subagents: [], context: null, compactions: [], ...over });
const KEY = { agent: "claude", sessionId: "s1", cwd: "/repo" };

afterEach(() => {
  cleanup();
  setSessionActivityReaderForTests(null);
  vi.useRealTimers();
});

describe("the subagent tree", () => {
  it("lists what each subagent was asked, its state, time and result", async () => {
    setSessionActivityReaderForTests(async () =>
      activity({
        subagents: [
          run({ id: "a", description: "Map the auth flow", status: "done", duration_ms: 185_000, tokens: 74_476, tool_uses: 22, result: "Login goes through middleware." }),
          run({ id: "b", description: "Too many", status: "failed", result: "Concurrent subagent limit reached." }),
          run({ id: "c", description: "Write tests", status: "running", background: true, kind: "tester" }),
        ],
      }),
    );
    render(<SubagentTree activityKey={KEY} />);
    expect(await screen.findByText("Map the auth flow")).toBeTruthy();
    expect(screen.getByText("3m 05s")).toBeTruthy();
    expect(screen.getByText("74.5k tokens")).toBeTruthy();
    expect(screen.getByText("22 tool calls")).toBeTruthy();
    expect(screen.getByText("Login goes through middleware.")).toBeTruthy();
    expect(screen.getByText("failed")).toBeTruthy();
    expect(screen.getByText("tester")).toBeTruthy();
    expect(screen.getByText("background")).toBeTruthy();
    expect(screen.getByText("1 running · 1 done · 1 failed")).toBeTruthy();
  });

  it("is a one-line count on the Agents views that opens into the list", async () => {
    setSessionActivityReaderForTests(async () => activity({ subagents: [run({}), run({ id: "t2", status: "done" })] }));
    render(<SubagentTree activityKey={KEY} compact />);
    const toggle = await screen.findByRole("button", { name: /2 subagents · 1 running · 1 done/ });
    expect(screen.queryByText("Find the bug")).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getAllByText("Find the bug").length).toBe(2);
  });

  it("renders nothing for a CLI whose transcript records no subagents", async () => {
    const read = vi.fn(async () => activity({ subagents: [run({})] }));
    setSessionActivityReaderForTests(read);
    const { container } = render(<SubagentTree activityKey={{ ...KEY, agent: "codex" }} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(container.textContent).toBe("");
    expect(read).not.toHaveBeenCalled();
  });

  it("updates live: polls fast while a subagent runs, and one poller serves every surface", async () => {
    vi.useFakeTimers();
    let n = 0;
    const read = vi.fn(async () =>
      activity({ subagents: [run({ status: n++ < 1 ? "running" : "done", result: n > 1 ? "Found it." : null })] }),
    );
    setSessionActivityReaderForTests(read);
    render(
      <>
        <SubagentTree activityKey={KEY} />
        <SubagentTree activityKey={KEY} compact />
      </>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(read).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ACTIVITY_FAST_MS + 10);
    });
    expect(read).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Found it.")).toBeTruthy();
  });

  it("formats spans and counts", () => {
    expect(fmtSpan(42_000)).toBe("42s");
    expect(fmtSpan(3_725_000)).toBe("1h 02m");
    expect(subagentCounts([run({}), run({ status: "stopped" })])).toBe("1 running · 1 stopped");
  });
});

function Harness({ life, deps, initial }: { life: string; deps: CompactionDeps; initial: SessionActivity }) {
  const [act0, setAct] = useState(initial);
  const compaction = useCompaction({
    agent: "claude",
    sessionId: "s1",
    cwd: "/repo",
    live: true,
    lifeState: life,
    remote: false,
    activity: act0,
    deps,
    refresh: () => {},
  });
  return (
    <>
      <ContextControls activity={act0} compaction={compaction} />
      <button onClick={() => compaction.ask({ kind: "from", turn: { n: 2, prompt: "Add tests" } })}>from 2</button>
      <button
        onClick={() =>
          setAct((a) => ({ ...a, compactions: [...a.compactions, { at_ms: 1, trigger: "manual", pre_tokens: 109_269, post_tokens: 11_379 }] }))
        }
      >
        transcript compacted
      </button>
    </>
  );
}

describe("context controls", () => {
  it("shows the context in use and waits for an idle prompt before typing /compact", async () => {
    const type = vi.fn();
    const deps: CompactionDeps = { type, headless: vi.fn() };
    const initial = activity({ context: { model: "never-reported", tokens: 44_846, at_ms: 1 } });
    const { rerender } = render(<Harness life="working" deps={deps} initial={initial} />);
    expect(screen.getByText("44.8k")).toBeTruthy();

    fireEvent.click(screen.getByText("from 2"));
    expect(screen.getByText("Summarize from here")).toBeTruthy();
    expect(screen.getByText(/Keep everything before turn 2 \("Add tests"\)/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Extra instructions"), { target: { value: "the schema" } });
    fireEvent.click(screen.getByRole("button", { name: "Compact when this turn ends" }));
    expect(screen.getByText(/Waiting for the agent to finish this turn/)).toBeTruthy();
    expect(type).not.toHaveBeenCalled();

    // The turn ends: now, and only now, it is typed.
    rerender(<Harness life="idle" deps={deps} initial={initial} />);
    await waitFor(() => expect(type).toHaveBeenCalledTimes(1));
    expect(type.mock.calls[0][0]).toMatch(/^\/compact Keep everything before turn 2 .* Also: the schema$/);
    expect(screen.getByText(/Sent — compacting/)).toBeTruthy();

    // Proven by the transcript, not assumed.
    fireEvent.click(screen.getByText("transcript compacted"));
    expect(await screen.findByText("Compacted: 109.3k → 11.4k tokens")).toBeTruthy();
  });

  it("never types while the agent is waiting on a question", () => {
    const type = vi.fn();
    render(<Harness life="waiting" deps={{ type, headless: vi.fn() }} initial={activity()} />);
    fireEvent.click(screen.getByText("from 2"));
    const go = screen.getByRole("button", { name: "Compact" }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    expect(screen.getByText(/waiting for your answer/)).toBeTruthy();
    expect(type).not.toHaveBeenCalled();
  });
});

// Keep the hook itself honest about unsupported CLIs.
function Probe({ agent }: { agent: string }) {
  const a = useSessionActivity({ ...KEY, agent });
  return <span>{a ? "has" : "none"}</span>;
}
it("useSessionActivity reads nothing for unsupported CLIs", async () => {
  const read = vi.fn(async () => activity());
  setSessionActivityReaderForTests(read);
  render(<Probe agent="other" />);
  await new Promise((r) => setTimeout(r, 10));
  expect(read).not.toHaveBeenCalled();
});

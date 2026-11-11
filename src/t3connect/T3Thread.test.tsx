import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { T3Thread } from "./T3Thread";
import type { ThreadProjection } from "./contracts";
import type { T3RpcClient } from "./rpc";

const projection = (over: Partial<ThreadProjection> = {}): ThreadProjection => ({
  thread: { id: "t1", projectId: "p", title: "Fix the build", providerInstanceId: "claudeAgent", runtimeMode: "full-access", branch: "main", worktreePath: null },
  runs: [{ id: "r1", status: "completed" }],
  messages: [
    { id: "m1", role: "user", text: "Fix the build", streaming: false, createdAt: "" },
    { id: "m2", role: "assistant", text: "Done: it builds.", streaming: false, createdAt: "" },
    { id: "m3", role: "system", text: "internal", streaming: false, createdAt: "" },
  ],
  ...over,
}) as ThreadProjection;

function fakeRpc(initial: ThreadProjection) {
  let current = initial;
  let onValues: ((v: unknown[]) => void) | undefined;
  const calls: Array<[string, unknown]> = [];
  const cancel = vi.fn();
  const rpc = {
    call: vi.fn(async (method: string, payload: unknown) => {
      calls.push([method, payload]);
      return method === "orchestration.getThreadProjection" ? current : { sequence: 1 };
    }),
    stream: vi.fn((_m: string, _p: unknown, on: (v: unknown[]) => void) => { onValues = on; return { cancel, done: new Promise<void>(() => {}) }; }),
  } as unknown as T3RpcClient;
  return { rpc, calls, cancel, set: (next: ThreadProjection) => { current = next; }, emit: () => onValues?.([{ kind: "event" }]) };
}

describe("T3Thread", () => {
  it("shows what was said (never the system's lines) and that the thread is done", async () => {
    const { rpc } = fakeRpc(projection());
    render(<T3Thread rpc={rpc} threadId="t1" canOperate />);
    expect(await screen.findByText("Done: it builds.")).toBeInTheDocument();
    expect(screen.getByText("Fix the build", { selector: "pre" })).toBeInTheDocument();
    expect(screen.queryByText("internal")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("Done");
  });

  it("reads the thread again when its stream speaks, and follows it to a new state", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const fake = fakeRpc(projection({ runs: [{ id: "r1", status: "running" }] }));
      render(<T3Thread rpc={fake.rpc} threadId="t1" canOperate />);
      await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Working"));
      fake.set(projection());
      act(() => { fake.emit(); vi.advanceTimersByTime(300); });
      await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Done"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends a message queued after the active run, and clears the box", async () => {
    const { rpc, calls } = fakeRpc(projection());
    render(<T3Thread rpc={rpc} threadId="t1" canOperate />);
    const box = await screen.findByLabelText("Message the agent");
    fireEvent.change(box, { target: { value: "Now add tests" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(calls.some(([m]) => m === "orchestration.dispatchCommand")).toBe(true));
    const [, payload] = calls.find(([m]) => m === "orchestration.dispatchCommand")!;
    expect(payload).toMatchObject({ type: "message.dispatch", threadId: "t1", text: "Now add tests", createdBy: "user", dispatchMode: { type: "queue_after_active" } });
    await waitFor(() => expect((box as HTMLTextAreaElement).value).toBe(""));
  });

  it("does not send on Shift+Enter, which is a new line", async () => {
    const { rpc, calls } = fakeRpc(projection());
    render(<T3Thread rpc={rpc} threadId="t1" canOperate />);
    const box = await screen.findByLabelText("Message the agent");
    fireEvent.change(box, { target: { value: "line one" } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(calls.some(([m]) => m === "orchestration.dispatchCommand")).toBe(false);
  });

  it("offers Stop only while working, and stops the thread", async () => {
    const { rpc, calls } = fakeRpc(projection({ runs: [{ id: "r1", status: "running" }] }));
    render(<T3Thread rpc={rpc} threadId="t1" canOperate />);
    fireEvent.click(await screen.findByRole("button", { name: "Stop" }));
    await waitFor(() => expect(calls.some(([, p]) => (p as { type?: string }).type === "thread.stop")).toBe(true));
  });

  it("is read-only, and says why, when the machine did not grant orchestration:operate", async () => {
    const { rpc } = fakeRpc(projection({ runs: [{ id: "r1", status: "running" }] }));
    render(<T3Thread rpc={rpc} threadId="t1" canOperate={false} />);
    expect(await screen.findByText(/did not grant orchestration:operate/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Message the agent")).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  });

  it("lets go of the stream when it closes", async () => {
    const fake = fakeRpc(projection());
    const { unmount } = render(<T3Thread rpc={fake.rpc} threadId="t1" canOperate />);
    await screen.findByText("Done: it builds.");
    unmount();
    expect(fake.cancel).toHaveBeenCalled();
  });
});

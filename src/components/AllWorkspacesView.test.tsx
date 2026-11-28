import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ForeignSession } from "../environments/allProjects";

vi.mock("./Term", () => ({
  Term: (props: { attachId?: number; machine?: string; killAttachedOnClose?: boolean }) => (
    <div data-testid="term" data-attach={props.attachId} data-machine={props.machine} data-kill={String(props.killAttachedOnClose)} />
  ),
}));
const { AllWorkspacesView } = await import("./AllWorkspacesView");

const session = (id: number, title: string, env = "local", machineName = "This Mac"): ForeignSession => ({
  env,
  machineName,
  session: { id, cwd: "/u/x", title },
});
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

describe("AllWorkspacesView", () => {
  it("attaches each live terminal from its machine, never starting one here", async () => {
    const reconnect = vi.fn(async (_env: string, id: number) => ({ kind: "attached" as const, alias: 1000 + id, machineName: "x" }));
    render(<AllWorkspacesView name="Side" machines={["This Mac"]} sessions={[session(1, "agent one"), session(2, "agent two", "remote:w", "w")]} visible reconnect={reconnect} />);
    await flush();
    expect(reconnect).toHaveBeenCalledWith("local", 1);
    expect(reconnect).toHaveBeenCalledWith("remote:w", 2);
    const terms = screen.getAllByTestId("term");
    expect(terms.map((t) => t.dataset.attach)).toEqual(["1001", "1002"]);
    expect(terms.map((t) => t.dataset.machine)).toEqual(["local", "remote:w"]);
    expect(terms.every((t) => t.dataset.kill === "false")).toBe(true);
    expect(screen.getByText("agent two").parentElement?.textContent).toContain("w");
  });

  it("does not bring back a tab the person closed, and drops one whose session ended", async () => {
    const reconnect = vi.fn(async (_env: string, id: number) => ({ kind: "attached" as const, alias: id, machineName: "x" }));
    const { rerender } = render(<AllWorkspacesView name="P" machines={["m"]} sessions={[session(1, "one"), session(2, "two")]} visible reconnect={reconnect} />);
    await flush();
    fireEvent.click(screen.getByLabelText("Close one"));
    rerender(<AllWorkspacesView name="P" machines={["m"]} sessions={[session(1, "one"), session(2, "two")]} visible reconnect={reconnect} />);
    await flush();
    expect(screen.queryByText("one")).toBeNull();
    expect(reconnect).toHaveBeenCalledTimes(2);
    rerender(<AllWorkspacesView name="P" machines={["m"]} sessions={[]} visible reconnect={reconnect} />);
    await flush();
    expect(screen.queryByTestId("term")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("Nothing is running in this project.");
  });

  it("says why it could not attach, and offers waking a project asleep here", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const onWake = vi.fn();
    render(
      <AllWorkspacesView
        name="Sleeper"
        machines={["This Mac"]}
        sessions={[session(3, "three")]}
        visible
        onWake={onWake}
        reconnect={async () => ({ kind: "failed", reason: "Could not connect: timed out" })}
      />,
    );
    await flush();
    expect(screen.getByRole("status").textContent).toContain("timed out");
    expect(screen.getByText(/Asleep here/).textContent).toContain("This Mac");
    fireEvent.click(screen.getByText("Wake here"));
    expect(onWake).toHaveBeenCalled();
  });

  it("waits until it is shown before attaching", async () => {
    const reconnect = vi.fn(async () => ({ kind: "attached" as const, alias: 9, machineName: "x" }));
    render(<AllWorkspacesView name="P" machines={["m"]} sessions={[session(1, "one")]} visible={false} reconnect={reconnect} />);
    await flush();
    expect(reconnect).not.toHaveBeenCalled();
  });
});

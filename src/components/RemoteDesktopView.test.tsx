import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { mockCommands } from "../test/setup";
import { createFrameBus, type DeskStateEvent } from "../desk";
import type { RelayHandle } from "../types";
import {
  DeskOverlay,
  RemoteDesktopMembers,
  RemoteDesktopView,
} from "./RemoteDesktopView";

const ev = (o: Partial<DeskStateEvent> = {}): DeskStateEvent => ({
  session: "s1",
  state: "requested",
  role: "target",
  peer: "ada",
  peer_name: "Ada",
  mode: null,
  ...o,
});

describe("consent dialog", () => {
  it("accepting view-only calls desk_respond with view-only", async () => {
    const respond = vi.fn(() => null);
    mockCommands({ desk_respond: respond });
    render(<DeskOverlay desk={ev()} frames={createFrameBus()} onDismiss={() => {}} />);
    fireEvent.click(screen.getByText("Accept view-only"));
    await waitFor(() => expect(respond).toHaveBeenCalled());
    expect(respond).toHaveBeenCalledWith({ session: "s1", accept: true, mode: "view-only" });
  });

  it("accepting control and denying are distinct calls", async () => {
    const respond = vi.fn(() => null);
    mockCommands({ desk_respond: respond });
    const { unmount } = render(
      <DeskOverlay desk={ev()} frames={createFrameBus()} onDismiss={() => {}} />,
    );
    fireEvent.click(screen.getByText("Accept control"));
    await waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
    expect(respond).toHaveBeenLastCalledWith({ session: "s1", accept: true, mode: "control" });
    unmount();
    render(<DeskOverlay desk={ev()} frames={createFrameBus()} onDismiss={() => {}} />);
    fireEvent.click(screen.getByText("Deny"));
    await waitFor(() => expect(respond).toHaveBeenCalledTimes(2));
    expect(respond.mock.calls[1]).toEqual([{ session: "s1", accept: false, mode: "view-only" }]);
  });

  it("shows nothing to consent to once the session is not requested", () => {
    render(
      <DeskOverlay
        desk={ev({ state: "ended", reason: "x" })}
        frames={createFrameBus()}
        onDismiss={() => {}}
      />,
    );
    expect(screen.queryByText("Accept control")).toBeNull();
  });
});

describe("controlled banner", () => {
  it("is shown while active and Stop calls desk_end", async () => {
    const end = vi.fn(() => null);
    mockCommands({ desk_end: end });
    render(
      <DeskOverlay
        desk={ev({ state: "active", mode: "control" })}
        frames={createFrameBus()}
        onDismiss={() => {}}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Ada is controlling your screen");
    fireEvent.click(screen.getByText("Stop"));
    await waitFor(() => expect(end).toHaveBeenCalledWith({ session: "s1" }));
  });
});

describe("viewer input", () => {
  const view = (mode: "view-only" | "control") =>
    ev({ role: "viewer", state: "active", mode });
  const frame = (bus: ReturnType<typeof createFrameBus>) =>
    bus.publish({
      id: "i",
      from: "ada",
      from_name: "Ada",
      to: "me",
      session: "s1",
      ts: 1,
      body: { kind: "frame", seq: 1, w: 100, h: 100, jpeg_b64: "QQ==" },
    });
  const rig = (mode: "view-only" | "control") => {
    const input = vi.fn(() => null);
    mockCommands({ desk_send_input: input });
    const bus = createFrameBus();
    render(<RemoteDesktopView view={view(mode)} frames={bus} onClose={() => {}} />);
    const canvas = screen.getByLabelText("Remote screen");
    canvas.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100 }) as DOMRect;
    frame(bus);
    return { input, canvas };
  };

  it("sends nothing in view-only mode", async () => {
    const { input, canvas } = rig("view-only");
    fireEvent.mouseMove(canvas, { clientX: 50, clientY: 50 });
    fireEvent.mouseDown(canvas, { clientX: 50, clientY: 50, button: 0 });
    fireEvent.mouseUp(canvas, { button: 0 });
    fireEvent.wheel(canvas, { deltaY: 10 });
    fireEvent.keyDown(canvas, { code: "KeyA" });
    await new Promise((r) => setTimeout(r, 20));
    expect(input).not.toHaveBeenCalled();
    expect(screen.getAllByText("View only").length).toBeGreaterThan(0);
  });

  it("sends mapped input in control mode, and only allowed keys", async () => {
    const { input, canvas } = rig("control");
    fireEvent.mouseDown(canvas, { clientX: 50, clientY: 25, button: 0 });
    await waitFor(() => expect(input).toHaveBeenCalledTimes(2));
    expect(input.mock.calls[0]).toEqual([
      { session: "s1", event: { kind: "mouse-move", x: 0.5, y: 0.25 } },
    ]);
    expect(input.mock.calls[1]).toEqual([
      { session: "s1", event: { kind: "mouse-button", button: "left", down: true } },
    ]);
    fireEvent.keyDown(canvas, { code: "AudioVolumeUp" });
    fireEvent.keyDown(canvas, { code: "KeyA" });
    await waitFor(() => expect(input).toHaveBeenCalledTimes(3));
    expect(input.mock.calls[2]).toEqual([
      { session: "s1", event: { kind: "key", code: "KeyA", down: true } },
    ]);
  });

  it("End button calls desk_end", async () => {
    const end = vi.fn(() => null);
    mockCommands({ desk_end: end });
    render(<RemoteDesktopView view={view("view-only")} frames={createFrameBus()} onClose={() => {}} />);
    fireEvent.click(screen.getByText("End"));
    await waitFor(() => expect(end).toHaveBeenCalledWith({ session: "s1" }));
  });

  it("reports waiting and denied states", () => {
    const { rerender } = render(
      <RemoteDesktopView view={ev({ role: "viewer" })} frames={createFrameBus()} onClose={() => {}} />,
    );
    expect(screen.getByText("Waiting for consent")).toBeInTheDocument();
    rerender(
      <RemoteDesktopView
        view={ev({ role: "viewer", state: "ended", reason: "Declined." })}
        frames={createFrameBus()}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText("Denied: Declined.")).toBeInTheDocument();
  });
});

describe("Remote desktop action", () => {
  const relay = (): RelayHandle =>
    ({
      status: {
        role: "client",
        self_id: "me",
        members: [
          { id: "me", name: "Me", joined_ms: 1, is_host: false, key: null, trust: "self" },
          { id: "ada", name: "Ada", joined_ms: 1, is_host: true, key: null, trust: "known" },
        ],
      },
      desk: null,
      deskRequest: vi.fn(() => Promise.resolve()),
    }) as unknown as RelayHandle;

  it("is offered for teammates, never for self", () => {
    const r = relay();
    render(<RemoteDesktopMembers relay={r} />);
    expect(screen.getByLabelText("Remote desktop with Ada")).toBeInTheDocument();
    expect(screen.queryByLabelText("Remote desktop with Me")).toBeNull();
    fireEvent.click(screen.getByLabelText("Remote desktop with Ada"));
    expect(r.deskRequest).toHaveBeenCalledWith("ada", "control");
  });

  it("is hidden when the relay is off", () => {
    const r = relay();
    r.status.role = "off";
    const { container } = render(<RemoteDesktopMembers relay={r} />);
    expect(container).toBeEmptyDOMElement();
  });
});

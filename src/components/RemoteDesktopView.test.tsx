import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  requested: "control",
  ...o,
});

const relay = (): RelayHandle =>
  ({
    status: {
      role: "client",
      self_id: "me",
      members: [
        { id: "me", name: "Me", joined_ms: 1, is_host: false, key: null, trust: "self" },
        { id: "ada", name: "Ada", joined_ms: 1, is_host: true, key: "aabbccddeeff0011", trust: "known" },
      ],
    },
    desk: null,
    deskRequest: vi.fn(() => Promise.resolve()),
  }) as unknown as RelayHandle;

afterEach(() => vi.unstubAllGlobals());

describe("consent dialog", () => {
  it("hides Accept control when the viewer only asked to view", () => {
    render(
      <DeskOverlay desk={ev({ requested: "view-only" })} frames={createFrameBus()} onDismiss={() => {}} />,
    );
    expect(screen.getByText("Accept view-only")).toBeTruthy();
    expect(screen.queryByText("Accept control")).toBeNull();
  });

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

  it.each([
    ["known", "aabbccddeeff0011", "Known device. Key AABB CCDD EEFF."],
    ["changed", "112233445566", "Warning: this device key changed. Key 1122 3344 5566."],
    ["relayed", null, "Identity is asserted by the relay host, not verified directly."],
    ["", null, "Device identity is unavailable."],
  ] as const)("shows %s identity evidence and the display-name warning", (trust, key, evidence) => {
    const handle = relay();
    const member = handle.status.members.find((candidate) => candidate.id === "ada")!;
    member.trust = trust;
    member.key = key;
    render(<DeskOverlay desk={ev()} frames={createFrameBus()} relay={handle} onDismiss={() => {}} />);
    expect(screen.getByText(new RegExp(evidence.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))).toBeInTheDocument();
    expect(screen.getByText(/Names are chosen by each person/)).toBeInTheDocument();
  });

  it("reports unavailable identity metadata when the member is absent", () => {
    const handle = relay();
    handle.status.members = handle.status.members.filter((member) => member.id !== "ada");
    render(<DeskOverlay desk={ev()} frames={createFrameBus()} relay={handle} onDismiss={() => {}} />);
    expect(screen.getByText(/Device identity is unavailable for this member/)).toBeInTheDocument();
  });

  it("shows nothing to consent to once the session is not requested", () => {
    render(
      <DeskOverlay desk={ev({ state: "ended", reason: "x" })} frames={createFrameBus()} onDismiss={() => {}} />,
    );
    expect(screen.queryByText("Accept control")).toBeNull();
  });
});

describe("controlled banner", () => {
  it("is shown while active and Stop calls desk_end", async () => {
    const end = vi.fn(() => null);
    mockCommands({ desk_end: end });
    render(
      <DeskOverlay desk={ev({ state: "active", mode: "control" })} frames={createFrameBus()} onDismiss={() => {}} />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Ada is controlling your screen");
    fireEvent.click(screen.getByText("Stop"));
    await waitFor(() => expect(end).toHaveBeenCalledWith({ session: "s1" }));
  });
});

describe("viewer input and frames", () => {
  const view = (mode: "view-only" | "control") => ev({ role: "viewer", state: "active", mode });
  const frame = (bus: ReturnType<typeof createFrameBus>, seq = 1, w = 100, h = 100) =>
    bus.publish({
      id: "i",
      from: "ada",
      from_name: "Ada",
      to: "me",
      session: "s1",
      ts: 1,
      body: { kind: "frame", seq, w, h, jpeg_b64: "QQ==" },
    });

  const rig = async (mode: "view-only" | "control") => {
    const input = vi.fn(() => null);
    const drawImage = vi.fn();
    mockCommands({ desk_send_input: input });
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 100, height: 100, close: vi.fn() })));
    const bus = createFrameBus();
    render(<RemoteDesktopView view={view(mode)} frames={bus} onClose={() => {}} />);
    const canvas = screen.getByLabelText("Remote screen") as HTMLCanvasElement;
    canvas.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100 }) as DOMRect;
    canvas.getContext = vi.fn(() => ({ drawImage })) as unknown as typeof canvas.getContext;
    frame(bus);
    await waitFor(() => expect(drawImage).toHaveBeenCalledTimes(1));
    return { input, canvas, drawImage, bus };
  };

  it("sends nothing in view-only mode", async () => {
    const { input, canvas } = await rig("view-only");
    fireEvent.pointerMove(canvas, { clientX: 50, clientY: 50, pointerId: 1 });
    fireEvent.pointerDown(canvas, { clientX: 50, clientY: 50, button: 0, pointerId: 1 });
    fireEvent.pointerUp(canvas, { button: 0, pointerId: 1 });
    fireEvent.wheel(canvas, { deltaY: 10 });
    fireEvent.keyDown(canvas, { code: "KeyA" });
    expect(input).not.toHaveBeenCalled();
    expect(screen.getAllByText("View only").length).toBeGreaterThan(0);
  });

  it("sends mapped input and remote Escape in control mode", async () => {
    const { input, canvas } = await rig("control");
    fireEvent.pointerDown(canvas, { clientX: 50, clientY: 25, button: 0, pointerId: 1 });
    await waitFor(() => expect(input).toHaveBeenCalledTimes(2));
    expect(input.mock.calls[0]).toEqual([
      { session: "s1", event: { kind: "mouse-move", x: 0.5, y: 0.25 } },
    ]);
    fireEvent.keyDown(canvas, { code: "AudioVolumeUp" });
    fireEvent.keyDown(canvas, { code: "Escape" });
    await waitFor(() => expect(input).toHaveBeenCalledTimes(3));
    expect(input.mock.calls[2]).toEqual([
      { session: "s1", event: { kind: "key", code: "Escape", down: true } },
    ]);
  });

  it("does not let an older asynchronous decode repaint a newer frame", async () => {
    const resolvers: Array<(bitmap: ImageBitmap) => void> = [];
    vi.stubGlobal("createImageBitmap", vi.fn(() => new Promise<ImageBitmap>((resolve) => resolvers.push(resolve))));
    const bus = createFrameBus();
    render(<RemoteDesktopView view={view("view-only")} frames={bus} onClose={() => {}} />);
    const canvas = screen.getByLabelText("Remote screen") as HTMLCanvasElement;
    const drawImage = vi.fn();
    canvas.getContext = vi.fn(() => ({ drawImage })) as unknown as typeof canvas.getContext;
    frame(bus, 1);
    frame(bus, 2);
    const newest = { width: 100, height: 100, close: vi.fn() } as unknown as ImageBitmap;
    const oldest = { width: 100, height: 100, close: vi.fn() } as unknown as ImageBitmap;
    resolvers[1](newest);
    await waitFor(() => expect(drawImage).toHaveBeenCalledWith(newest, 0, 0));
    resolvers[0](oldest);
    await waitFor(() => expect(oldest.close).toHaveBeenCalled());
    expect(drawImage).toHaveBeenCalledTimes(1);
  });

  it("rejects mismatched decoded dimensions before pointer mapping", async () => {
    const input = vi.fn(() => null);
    mockCommands({ desk_send_input: input });
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 90, height: 100, close: vi.fn() })));
    const bus = createFrameBus();
    render(<RemoteDesktopView view={view("control")} frames={bus} onClose={() => {}} />);
    const canvas = screen.getByLabelText("Remote screen") as HTMLCanvasElement;
    canvas.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100 }) as DOMRect;
    const drawImage = vi.fn();
    canvas.getContext = vi.fn(() => ({ drawImage })) as unknown as typeof canvas.getContext;
    frame(bus);
    await waitFor(() => expect(createImageBitmap).toHaveBeenCalled());
    fireEvent.pointerDown(canvas, { clientX: 50, clientY: 50, button: 0, pointerId: 1 });
    expect(drawImage).not.toHaveBeenCalled();
    expect(input).not.toHaveBeenCalled();
  });

  it("focuses once when control activates and not on later frames", async () => {
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 100, height: 100, close: vi.fn() })));
    const bus = createFrameBus();
    const { rerender } = render(
      <RemoteDesktopView view={ev({ role: "viewer", state: "requested" })} frames={bus} onClose={() => {}} />,
    );
    const canvas = screen.getByLabelText("Remote screen") as HTMLCanvasElement;
    canvas.getContext = vi.fn(() => ({ drawImage: vi.fn() })) as unknown as typeof canvas.getContext;
    rerender(<RemoteDesktopView view={view("control")} frames={bus} onClose={() => {}} />);
    expect(document.activeElement).toBe(canvas);
    const end = screen.getByText("End");
    end.focus();
    frame(bus);
    await waitFor(() => expect(createImageBitmap).toHaveBeenCalled());
    expect(document.activeElement).toBe(end);
  });

  it("prevents wheel and context-menu leakage", async () => {
    const { canvas } = await rig("view-only");
    expect(fireEvent.wheel(canvas, { deltaY: 10, cancelable: true })).toBe(false);
    expect(fireEvent.contextMenu(canvas, { cancelable: true })).toBe(false);
  });

  it("contains focus for both grants and restores the previous focus", () => {
    const before = document.createElement("button");
    document.body.append(before);
    before.focus();
    const { unmount } = render(
      <RemoteDesktopView view={view("view-only")} frames={createFrameBus()} onClose={() => {}} />,
    );
    const dialog = screen.getByRole("dialog");
    const canvas = screen.getByLabelText("Remote screen");
    const end = screen.getByText("End");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(document.activeElement).toBe(canvas);
    fireEvent.keyDown(canvas, { key: "Tab" });
    expect(document.activeElement).toBe(end);
    fireEvent.keyDown(end, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(canvas);
    unmount();
    expect(document.activeElement).toBe(before);
    before.remove();
  });

  it("keeps modal Tab navigation local in control mode", () => {
    const input = vi.fn(() => null);
    mockCommands({ desk_send_input: input });
    render(
      <RemoteDesktopView view={view("control")} frames={createFrameBus()} onClose={() => {}} />,
    );
    const canvas = screen.getByLabelText("Remote screen");
    const end = screen.getByText("End");
    expect(document.activeElement).toBe(canvas);
    fireEvent.keyDown(canvas, { key: "Tab", code: "Tab" });
    expect(document.activeElement).toBe(end);
    expect(input).not.toHaveBeenCalled();
  });

  it("End button calls desk_end and status is live", async () => {
    const end = vi.fn(() => null);
    mockCommands({ desk_end: end });
    render(<RemoteDesktopView view={view("view-only")} frames={createFrameBus()} onClose={() => {}} />);
    expect(screen.getByRole("status")).toHaveTextContent("View only");
    fireEvent.click(screen.getByText("End"));
    await waitFor(() => expect(end).toHaveBeenCalledWith({ session: "s1" }));
  });

  it("reports waiting and denied states", () => {
    const { rerender } = render(
      <RemoteDesktopView view={ev({ role: "viewer" })} frames={createFrameBus()} onClose={() => {}} />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Waiting for consent");
    rerender(
      <RemoteDesktopView view={ev({ role: "viewer", state: "ended", reason: "Declined." })} frames={createFrameBus()} onClose={() => {}} />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Denied: Declined.");
  });
});

describe("Remote desktop actions", () => {
  it("offers separate view and control requests for teammates, never self", async () => {
    const handle = relay();
    render(<RemoteDesktopMembers relay={handle} />);
    expect(screen.getByLabelText("View Ada's desktop")).toBeInTheDocument();
    expect(screen.getByLabelText("Control Ada's desktop")).toBeInTheDocument();
    expect(screen.queryByLabelText("View Me's desktop")).toBeNull();
    fireEvent.click(screen.getByLabelText("View Ada's desktop"));
    expect(handle.deskRequest).toHaveBeenCalledWith("ada", "view-only");
    await waitFor(() => expect(screen.queryByText("Requesting view only…")).toBeNull());
  });

  it("shows per-request pending feedback and blocks duplicate requests", async () => {
    let finish!: () => void;
    const handle = relay();
    handle.deskRequest = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    render(<RemoteDesktopMembers relay={handle} />);
    fireEvent.click(screen.getByLabelText("Control Ada's desktop"));
    expect(screen.getByRole("status")).toHaveTextContent("Requesting control");
    expect(screen.getByLabelText("View Ada's desktop")).toBeDisabled();
    fireEvent.click(screen.getByLabelText("Control Ada's desktop"));
    expect(handle.deskRequest).toHaveBeenCalledTimes(1);
    finish();
    await waitFor(() => expect(screen.queryByText("Requesting control…")).toBeNull());
  });

  it("shows request errors in the member row", async () => {
    const handle = relay();
    handle.deskRequest = vi.fn(() => Promise.reject(new Error("Peer unavailable")));
    render(<RemoteDesktopMembers relay={handle} />);
    fireEvent.click(screen.getByLabelText("View Ada's desktop"));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Peer unavailable"));
  });

  it("is hidden when the relay is off", () => {
    const handle = relay();
    handle.status.role = "off";
    const { container } = render(<RemoteDesktopMembers relay={handle} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("held input", () => {
  it("releases a held mouse button when the pointer is released outside the canvas", async () => {
    const send = vi.fn(() => null);
    mockCommands({ desk_send_input: send });
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 100, height: 100, close: vi.fn() })));
    const frames = createFrameBus();
    render(
      <RemoteDesktopView view={ev({ role: "viewer", state: "active", mode: "control" })} frames={frames} onClose={() => {}} />,
    );
    const canvas = screen.getByLabelText("Remote screen") as HTMLCanvasElement;
    canvas.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100 }) as DOMRect;
    canvas.getContext = vi.fn(() => ({ drawImage: vi.fn() })) as unknown as typeof canvas.getContext;
    frames.publish({
      id: "i",
      from: "ada",
      from_name: "Ada",
      to: "me",
      session: "s1",
      ts: 1,
      body: { kind: "frame", seq: 1, w: 100, h: 100, jpeg_b64: "QQ==" },
    });
    await waitFor(() => expect(canvas.width).toBe(100));
    fireEvent.pointerDown(canvas, { clientX: 50, clientY: 50, button: 0, pointerId: 7 });
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    fireEvent.pointerUp(window, { button: 0, pointerId: 7 });
    await waitFor(() =>
      expect(send).toHaveBeenLastCalledWith({
        session: "s1",
        event: { kind: "mouse-button", button: "left", down: false },
      }),
    );
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("releases held input under its originating session when the viewer changes", async () => {
    const send = vi.fn(() => null);
    mockCommands({ desk_send_input: send });
    const frames = createFrameBus();
    const { rerender } = render(
      <RemoteDesktopView view={ev({ role: "viewer", state: "active", mode: "control" })} frames={frames} onClose={() => {}} />,
    );
    const canvas = screen.getByLabelText("Remote screen");
    fireEvent.keyDown(canvas, { code: "ControlLeft" });
    rerender(
      <RemoteDesktopView view={ev({ session: "s2", role: "viewer", state: "active", mode: "control" })} frames={frames} onClose={() => {}} />,
    );
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith({
        session: "s1",
        event: { kind: "key", code: "ControlLeft", down: false },
      }),
    );
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({
      session: "s2",
      event: { kind: "key", code: "ControlLeft", down: false },
    }));
  });

  it("releases a held key when the canvas loses focus", async () => {
    const send = vi.fn(() => null);
    mockCommands({ desk_send_input: send });
    render(
      <RemoteDesktopView view={ev({ role: "viewer", state: "active", mode: "control" })} frames={createFrameBus()} onClose={() => {}} />,
    );
    const canvas = screen.getByLabelText("Remote screen");
    fireEvent.keyDown(canvas, { code: "ControlLeft" });
    fireEvent.blur(canvas);
    await waitFor(() =>
      expect(send).toHaveBeenLastCalledWith({
        session: "s1",
        event: { kind: "key", code: "ControlLeft", down: false },
      }),
    );
  });
});

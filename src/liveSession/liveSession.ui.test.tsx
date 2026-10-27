import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const openSessionDoc = vi.fn();
vi.mock("../sessionDoc/events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../sessionDoc/events")>()),
  openSessionDoc: (...a: unknown[]) => openSessionDoc(...a),
}));

import { ChatCard, type ChatCardDeps } from "../components/ChatCard";
import { cardText, type HandoffCard, type LiveSessionCard } from "../teamMessaging/cardSchema";
import type { ChatMessage } from "../teamMessaging/client";
import type { LiveOp } from "../teamMessaging/liveEvents";
import type { TeamLiveEvent } from "../teamMessaging/session";
import { LiveGuest } from "./guest";
import { LiveSessionView } from "./LiveSessionView";
import { LiveRoomControls, LiveRoomsHost } from "./LiveRoomControls";
import { LiveRooms } from "./rooms";

afterEach(() => {
  cleanup();
  openSessionDoc.mockClear();
});
const ROOM = "0f8fad5b-d9cb-469f-a165-70867728950e";
const deps = {} as ChatCardDeps;
const message = (card: LiveSessionCard | HandoffCard, sender = "sam"): ChatMessage => ({
  id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  sender,
  recipient: null,
  text: cardText(card),
  created: 1,
  card,
});
const live: LiveSessionCard = { type: "live-session", v: 1, room: ROOM, title: "Fix login", agent: "claude", dir: "web" };
const name = (id: string) => ({ sam: "Sam", ana: "Ana" })[id] ?? id;

describe("live session cards in chat", () => {
  it("offers Join to teammates and opens the live view through the card's team", () => {
    render(<ChatCard message={message(live)} userId="ana" teamId="core" messages={[]} name={name} deps={deps} />);
    expect(screen.getByText(/Sam's claude session is running/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Join" }));
    expect(openSessionDoc).toHaveBeenCalledWith({ kind: "join", team: "core", owner: "sam", ownerName: "Sam", room: ROOM, title: "Fix login", agent: "claude" });
  });
  it("shows no Join on the owner's own card", () => {
    render(<ChatCard message={message(live, "ana")} userId="ana" teamId="core" messages={[]} name={name} deps={deps} />);
    expect(screen.queryByRole("button", { name: "Join" })).toBeNull();
  });
  it("adds Join live to a hand-off of a session that is still open to join", () => {
    const handoff: HandoffCard = { type: "handoff", v: 1, title: "Fix login", agent: "claude", session: "abc", packet: "## State", room: ROOM };
    render(<ChatCard message={message(handoff)} userId="ana" teamId="core" messages={[]} name={name} deps={deps} />);
    fireEvent.click(screen.getByRole("button", { name: "Join live" }));
    expect(openSessionDoc).toHaveBeenCalledWith(expect.objectContaining({ kind: "join", room: ROOM, owner: "sam" }));
  });
});

describe("watching a live session", () => {
  it("shows who is watching, the turns, and sends a message for the owner to approve", async () => {
    let listener: ((e: TeamLiveEvent) => void) | null = null;
    const sent: LiveOp[] = [];
    const join = { team: "core", owner: "sam", ownerName: "Sam", room: ROOM, title: "Fix login", agent: "claude" };
    const start = () =>
      new LiveGuest(join, {
        send: async (_t, _p, _r, op) => {
          sent.push(op);
          return 1;
        },
        subscribe: (fn) => {
          listener = fn;
          return () => {
            listener = null;
          };
        },
        now: () => Date.now(),
      });
    const onClose = vi.fn();
    render(<LiveSessionView join={join} onClose={onClose} start={start} names={(id) => ({ ana: "Ana", bo: "Bo" })[id]} />);
    expect(sent).toEqual([{ op: "join" }]);
    expect(screen.getByText("Joining Sam's session…")).toBeTruthy();
    act(() =>
      listener!({
        team: "core",
        user: "ana",
        sender: "sam",
        event: {
          type: "live",
          target: ROOM,
          op: "state",
          title: "Fix login",
          agent: "claude",
          direct: false,
          viewers: ["ana", "bo"],
          turns: [{ id: "p:1", at: 1, kind: "prompt", text: "Fix the login bug" }],
        },
      }),
    );
    expect(screen.getByText("Bo")).toBeTruthy();
    expect(screen.getByText("Fix the login bug")).toBeTruthy();
    expect(screen.getByText(/Sam sees your message first/)).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "Message for the agent" }), { target: { value: "Use the v2 API" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask Sam" }));
    await waitFor(() => expect(sent.at(-1)).toMatchObject({ op: "say", text: "Use the v2 API" }));
    expect(await screen.findByText("Waiting for Sam")).toBeTruthy();
    act(() => listener!({ team: "core", user: "ana", sender: "sam", event: { type: "live", target: ROOM, op: "bye", reason: "removed" } }));
    expect(screen.getByText("Sam removed you from this session.")).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "Message for the agent" }) as HTMLTextAreaElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Leave" }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe("owning a live session", () => {
  const setup = () => {
    const sent: { peer: string; op: LiveOp }[] = [];
    const deliver = vi.fn(async () => ({ delivered: true, note: "Sent." }));
    const rooms = new LiveRooms({
      send: async (_t, peer, _r, op) => {
        sent.push({ peer, op });
        return 1;
      },
      members: () => ({ ana: "Ana", sam: "Sam" }),
      now: () => 1,
    });
    const r = rooms.open({ sessionId: "s1", title: "Fix login", agent: "claude", deliver });
    rooms.allow(r.id, { team: "core", peer: null });
    rooms.handle({ team: "core", sender: "ana", senderName: "Ana", event: { target: r.id, op: "join" } });
    rooms.handle({ team: "core", sender: "ana", senderName: "Ana", event: { target: r.id, op: "say", request: "7c9e6679-7425-40de-944b-e07fc1f90ae7", text: "Use v2" } });
    return { rooms, id: r.id, sent, deliver };
  };
  it("asks before anything reaches the agent: Send, Edit or Decline", async () => {
    const { rooms, id, deliver } = setup();
    render(<LiveRoomsHost rooms={rooms} />);
    expect(screen.getByText(/1 watching · 1 waiting/)).toBeTruthy();
    expect(screen.getByText("Use v2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Message for the agent" }), { target: { value: "Use the v2 API" } });
    fireEvent.click(screen.getByRole("button", { name: "Send edited" }));
    await waitFor(() => expect(deliver).toHaveBeenCalledWith(expect.stringContaining("Use the v2 API")));
    expect(rooms.room(id)!.requests).toEqual([]);
  });
  it("removes a watcher and lets teammates talk directly", () => {
    const { rooms, id, sent } = setup();
    const onInvite = vi.fn();
    const { rerender } = render(<LiveRoomControls room={rooms.room(id)!} rooms={rooms} onInvite={onInvite} />);
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    expect(sent.at(-1)).toMatchObject({ peer: "ana", op: { op: "answer", outcome: "declined" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /talk to the agent directly/ }));
    expect(rooms.room(id)!.direct).toBe(true);
    rerender(<LiveRoomControls room={rooms.room(id)!} rooms={rooms} onInvite={onInvite} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove Ana" }));
    expect(sent.at(-1)).toMatchObject({ peer: "ana", op: { op: "bye", reason: "removed" } });
    fireEvent.click(screen.getByRole("button", { name: "Invite to join…" }));
    expect(onInvite).toHaveBeenCalled();
  });
});

describe("letting teammates join from the session document", () => {
  it("opens a room and shares a live-session card; the conversation it went to may join", async () => {
    const { LiveRoomPanel } = await import("./LiveRoomPanel");
    const { liveRooms, endLiveRoom } = await import("./live");
    const { OPEN_SHARE_DIALOG_EVENT } = await import("../shareCards");
    const shared: unknown[] = [];
    const listen = (e: Event) => shared.push((e as CustomEvent).detail);
    window.addEventListener(OPEN_SHARE_DIALOG_EVENT, listen);
    try {
      const deliver = vi.fn(async () => ({ delivered: true, note: "" }));
      render(<LiveRoomPanel sessionId="s-doc" title="Fix login" agent="claude" cwd="/code/web" turns={() => []} deliver={deliver} />);
      fireEvent.click(screen.getByRole("button", { name: "Let teammates join…" }));
      await waitFor(() => expect(shared).toHaveLength(1));
      const request = shared[0] as { kind: string; card: LiveSessionCard; onSent: (t: string, p: string | null) => void };
      const room = liveRooms.forSession("s-doc")!;
      expect(request.card).toEqual({ type: "live-session", v: 1, room: room.id, title: "Fix login", agent: "claude", dir: "web" });
      request.onSent("core", "ana");
      expect(liveRooms.room(room.id)!.audiences).toEqual([{ team: "core", peer: "ana" }]);
      expect(await screen.findByText(/Nobody is watching yet/)).toBeTruthy();
      await endLiveRoom(room.id);
      expect(liveRooms.forSession("s-doc")).toBeUndefined();
    } finally {
      window.removeEventListener(OPEN_SHARE_DIALOG_EVENT, listen);
    }
  });
});

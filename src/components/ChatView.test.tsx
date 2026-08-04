import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { RelayHandle } from "../types";
import { ChatView } from "./ChatView";

const relay = (): RelayHandle => ({
  status: {
    role: "client",
    code: null,
    port: null,
    ips: [],
    addr: "relay",
    self_id: "me",
    name: "Me",
    visibility: null,
    public_ip: null,
    members: [
      { id: "me", name: "Me", joined_ms: 1, is_host: false, key: null, trust: "self" },
      { id: "ada", name: "Ada", joined_ms: 1, is_host: true, key: null, trust: "known" },
    ],
  },
  chat: [
    {
      id: "m1",
      from: "ada",
      from_name: "Ada",
      to: "me",
      text: "PR review request\ncanopy://pr?number=42&repo=https%3A%2F%2Fgithub.com%2Fo%2Fr.git\n#42 Fix the race",
      ts: Date.now(),
    },
  ],
  unread: {},
  inbox: [],
  transfers: [],
  collab: {} as RelayHandle["collab"],
  collabTick: 0,
  hostStart: vi.fn(),
  hostStop: vi.fn(),
  regenerateCode: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  sendChat: vi.fn(),
  sendCommand: vi.fn(),
  dismissInbox: vi.fn(),
  reportActiveChat: vi.fn(),
});

describe("Relay PR review cards", () => {
  it("dispatches the card's native PR deep link", () => {
    const follow = vi.fn();
    window.addEventListener("canopy:follow-deep-link", follow);
    render(<ChatView peer="ada" title="Ada" relay={relay()} onNotice={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /Review requested/i }));

    expect(follow).toHaveBeenCalledOnce();
    expect((follow.mock.calls[0][0] as CustomEvent).detail.url).toContain(
      "canopy://pr?number=42",
    );
    window.removeEventListener("canopy:follow-deep-link", follow);
  });
});

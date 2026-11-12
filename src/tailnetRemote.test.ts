import { afterEach, describe, expect, it } from "vitest";
import {
  applyRemoteStateForTests,
  clearNotice,
  forgetLink,
  holdsInput,
  linkFor,
  linkForPty,
  registerLink,
  remoteTabTitle,
  resetTailnetRemoteForTests,
} from "./tailnetRemote";

const state = (s: Parameters<typeof applyRemoteStateForTests>[0]["state"], attempt: number | null = null) =>
  applyRemoteStateForTests({ ptyId: 5, stableId: "nWORKMAC1CNTRL", state: s, attempt, exitCode: null });

describe("tailnet remote links", () => {
  afterEach(() => resetTailnetRemoteForTests());
  const open = () => registerLink({ ptyId: 5, stableId: "nWORKMAC1CNTRL", remoteId: 2, machine: "work-mac" });

  it("a registered link is connected and found by pty and by remote terminal", () => {
    open();
    expect(linkForPty(5)?.phase).toEqual({ kind: "connected" });
    expect(linkFor("nWORKMAC1CNTRL", 2)?.ptyId).toBe(5);
    expect(linkForPty(6)).toBeUndefined();
  });

  it("typing is held only while the link is down", () => {
    open();
    expect(holdsInput(5)).toBe(false);
    state("reconnecting", 2);
    expect(linkForPty(5)?.phase).toEqual({ kind: "reconnecting", attempt: 2 });
    expect(holdsInput(5)).toBe(true);
    state("lost");
    expect(holdsInput(5)).toBe(true);
    state("connected");
    expect(holdsInput(5)).toBe(false);
    expect(holdsInput(99)).toBe(false);
  });

  it("an event for a pty that is not a link is ignored", () => {
    applyRemoteStateForTests({ ptyId: 9, stableId: "x", state: "lost", attempt: null, exitCode: null });
    expect(linkForPty(9)).toBeUndefined();
  });

  it("forgetting drops the link", () => {
    open();
    forgetLink(5);
    expect(linkForPty(5)).toBeUndefined();
  });

  it("revoked leaves a notice that a new link clears", () => {
    open();
    state("revoked");
    clearNotice("nWORKMAC1CNTRL");
    open();
    expect(linkForPty(5)?.phase.kind).toBe("connected");
  });

  it("the tab title puts the machine first", () => {
    expect(remoteTabTitle("work-mac", "zsh")).toBe("work-mac: zsh");
  });
});

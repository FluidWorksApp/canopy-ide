import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  autoCheckpointObserved,
  forgetAutoCheckpointObserved,
  recordAutoCheckpointObserved,
} from "./vibeAutoCheckpoint";

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("the auto-checkpoint gate", () => {
  it("starts unarmed, which is what a machine that has never committed looks like", () => {
    expect(autoCheckpointObserved()).toBe(false);
  });

  it("stays armed across a reload once a commit has been observed", () => {
    recordAutoCheckpointObserved();
    expect(autoCheckpointObserved()).toBe(true);
    // Durable: a flag held in memory would re-ask on every launch, which is a
    // different (and worse) product than "the first one is yours".
    expect(localStorage.getItem("canopy.vibe.autoCheckpointObserved.v1")).toBe("1");
  });

  it("can be put back, so the next automatic save is proposed again", () => {
    recordAutoCheckpointObserved();
    forgetAutoCheckpointObserved();
    expect(autoCheckpointObserved()).toBe(false);
  });

  it("reads unarmed when storage cannot be reached", () => {
    vi.spyOn(globalThis.localStorage, "getItem").mockImplementation(() => {
      throw new Error("storage is blocked");
    });
    // Unknown fails closed. An unreadable flag is not permission to commit.
    expect(autoCheckpointObserved()).toBe(false);
  });

  it("does not claim to be armed when persisting failed", () => {
    vi.spyOn(globalThis.localStorage, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });
    recordAutoCheckpointObserved();
    expect(autoCheckpointObserved()).toBe(false);
  });
});

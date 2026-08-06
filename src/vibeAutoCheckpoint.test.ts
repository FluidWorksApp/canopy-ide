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

// Swap the whole Storage object rather than spying on its methods. jsdom backs
// `localStorage` with a Proxy, so a `vi.spyOn` of `setItem` is not guaranteed to
// intercept the call the module actually makes — it silently didn't in CI while
// it did locally, so the failure-path tests passed here and exercised nothing
// there. A test that only sometimes tests the thing is worse than an absent one
// when what it guards is an unattended `git commit`.
function withStorage(storage: Partial<Storage>, run: () => void): void {
  const real = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    value: storage,
    configurable: true,
  });
  try {
    run();
  } finally {
    // Restore, or remove the stub outright if `localStorage` was not an own
    // property to begin with. Leaving it behind would hand a throwing Storage
    // to whatever runs next, which is a failure that surfaces far from here.
    if (real) Object.defineProperty(globalThis, "localStorage", real);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  }
}

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
    withStorage(
      {
        getItem: () => {
          throw new Error("storage is blocked");
        },
      },
      () => {
        // Unknown fails closed. An unreadable flag is not permission to commit.
        expect(autoCheckpointObserved()).toBe(false);
      },
    );
  });

  it("does not claim to be armed when persisting failed", () => {
    // The write throws and the read is honest about what is actually stored,
    // so a quota failure leaves the machine unarmed rather than armed in
    // memory only — the next launch asks again, which is the safe direction.
    const stored = new Map<string, string>();
    withStorage(
      {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: () => {
          throw new Error("quota exceeded");
        },
      },
      () => {
        recordAutoCheckpointObserved();
        expect(autoCheckpointObserved()).toBe(false);
      },
    );
  });
});

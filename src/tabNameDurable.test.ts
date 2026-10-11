// The owner's rule for every remote workspace: a name the user sets never
// changes — not on reconnect, not when the container is recreated, not when the
// host or the app restarts — and an automatic name does not churn to each new
// message. Every case below is a route by which a rebuilt tab used to come back
// with an empty prompt slot, so the next message the user sent became its name.
import { beforeEach, describe, expect, it } from "vitest";
import {
  adoptDurableNames,
  adoptSnapshotNames,
  durableNames,
  namePatch,
  openingPrompt,
  snapshotNames,
  tabName,
  type NamedTab,
} from "./tabName";
import { rememberSessionNames, rememberedSessionNames } from "./sessionNames";

const REMOTE = "workspace:coraa";
const LATER = "pls see where you left the migration";

/** What the UserPromptSubmit writer does, in order. */
const submit = (tab: NamedTab, stored: ReturnType<typeof rememberedSessionNames>, prompt: string, digest?: Parameters<typeof openingPrompt>[0]) => {
  const restored = { ...tab, ...(adoptDurableNames(tab, stored) ?? {}) };
  return { ...restored, ...(namePatch(restored, "prompt", openingPrompt(digest, prompt)) ?? {}) };
};

beforeEach(() => localStorage.clear());

describe("a rebuilt tab keeps its names", () => {
  it("round-trips the prompt and agent names through a snapshot, so the next message cannot rename it", () => {
    const before = { promptName: "fix the ledger import", agentName: "Ledger import fix", nativeName: "Moss" };
    const back = adoptSnapshotNames(snapshotNames(before, { agent: true }));
    expect(tabName(back, { agent: true })).toBe("Ledger import fix");
    expect(namePatch(back, "prompt", LATER)).toBeNull();
  });

  it("a remote reattach keyed by the conversation brings back the user's name and the opening prompt", () => {
    rememberSessionNames(REMOTE, "sess-1", durableNames({ userName: "billing api", promptName: "fix the ledger import" }));
    // Container recreated: a new pty, a new instance, an empty tab.
    const fresh: NamedTab = { nativeName: "Juniper", launchTitle: "claude" };
    const back = { ...fresh, ...adoptDurableNames(fresh, rememberedSessionNames(REMOTE, "sess-1")) };
    expect(tabName(back, { agent: true })).toBe("billing api");
    const after = submit(back, rememberedSessionNames(REMOTE, "sess-1"), LATER);
    expect(tabName(after, { agent: true })).toBe("billing api");
  });

  it("a new message after reattach does not rename a tab the user never named", () => {
    rememberSessionNames(REMOTE, "sess-2", durableNames({ promptName: "fix the ledger import" }));
    const fresh: NamedTab = { nativeName: "Juniper", launchTitle: "fix the ledger import" };
    const after = submit(fresh, rememberedSessionNames(REMOTE, "sess-2"), LATER);
    expect(tabName(after, { agent: true })).toBe("fix the ledger import");
  });

  it("with nothing remembered, the digest's first prompt names it, never the latest", () => {
    const digest = {
      first_prompt: "fix the ledger import",
      prompts: ["fix the ledger import", "are you not keeping the tab name", LATER],
      working_on: LATER,
    };
    const after = submit({ nativeName: "Juniper" }, undefined, LATER, digest);
    expect(tabName(after, { agent: true })).toBe("fix the ledger import");
  });

  it("skips injected payloads when choosing the opening prompt", () => {
    expect(openingPrompt({ first_prompt: "<task-notification>x</task-notification>", prompts: ["<x/>", "real ask"] }, LATER)).toBe("real ask");
    expect(openingPrompt(undefined, LATER)).toBe(LATER);
  });

  it("working_on changing never renames", () => {
    let tab: NamedTab = submit({ nativeName: "Juniper" }, undefined, "fix the ledger import");
    for (const now of ["pls see where you", "are you not keepin it", LATER]) {
      const digest = { first_prompt: "fix the ledger import", working_on: now, prompts: [now] };
      tab = submit(tab, undefined, now, digest);
    }
    expect(tabName(tab, { agent: true })).toBe("fix the ledger import");
  });
});

describe("the user's name is never overwritten", () => {
  it("a remembered name cannot replace the one the tab already carries", () => {
    expect(adoptDurableNames({ userName: "mine" }, { userName: "older" })).toBeNull();
  });

  it("survives app restart: the store is read back fresh from storage", () => {
    rememberSessionNames(REMOTE, "sess-3", durableNames({ userName: "billing api" }));
    const raw = localStorage.getItem("canopy.sessionNames");
    localStorage.clear();
    localStorage.setItem("canopy.sessionNames", raw!);
    expect(adoptDurableNames({}, rememberedSessionNames(REMOTE, "sess-3"))).toEqual({ userName: "billing api" });
  });

  it("is scoped per workspace, so switching local and remote neither loses nor leaks it", () => {
    rememberSessionNames(REMOTE, "sess-4", durableNames({ userName: "remote one" }));
    rememberSessionNames("local", "sess-4", durableNames({ userName: "local one" }));
    expect(rememberedSessionNames(REMOTE, "sess-4")).toEqual({ userName: "remote one" });
    expect(rememberedSessionNames("local", "sess-4")).toEqual({ userName: "local one" });
  });

  it("clearing the name forgets it rather than resurrecting it", () => {
    rememberSessionNames(REMOTE, "sess-5", durableNames({ userName: "billing api" }));
    rememberSessionNames(REMOTE, "sess-5", durableNames({}));
    expect(rememberedSessionNames(REMOTE, "sess-5")).toBeUndefined();
  });
});

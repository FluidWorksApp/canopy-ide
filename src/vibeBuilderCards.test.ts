import { describe, expect, it } from "vitest";
import type { AttentionItem } from "./attention";
import {
  builderCardForManagedProcess,
  builderCardForRepairVerdict,
  builderCardFromAttention,
  builderCardFromQuestion,
} from "./vibeBuilderCards";

describe("Build chat cards", () => {
  it("narrates managed installation and compilation from observed states", () => {
    const observing = {
      state: "working" as const,
      exit: "observe" as const,
      deadlineAt: 42_000,
      prompt: null,
    };
    expect(
      builderCardForManagedProcess(observing, {
        id: "install",
        phase: "installing",
      }),
    ).toMatchObject({
      kind: "progress",
      title: "Installing dependencies",
      deadlineAt: 42_000,
    });
    expect(
      builderCardForManagedProcess(observing, {
        id: "compile",
        phase: "compiling",
      }),
    ).toMatchObject({
      kind: "progress",
      title: "Compiling — first run takes a few minutes",
    });
  });

  it("moves failed and hung processes into repair narration without terminal output", () => {
    const card = builderCardForManagedProcess(
      { state: "hung", exit: "repair", deadlineAt: null, prompt: null },
      { id: "server", phase: "starting" },
    );
    expect(card).toEqual({
      id: "server",
      kind: "progress",
      stage: "repairing",
      title: "I’m repairing the preview",
      detail: "I found a startup problem and I’m working through it.",
    });
    expect(JSON.stringify(card)).not.toMatch(/terminal|command|stack|exit code/i);
  });

  it("renders repair results as outcomes and only human work as a decision", () => {
    expect(
      builderCardForRepairVerdict("fixed", {
        diagnosis: "A dependency was missing.",
        actions: [{ did: "I installed the declared dependency and checked the app." }],
        fixed: true,
      }),
    ).toMatchObject({
      kind: "outcome",
      tone: "success",
      title: "Found it and fixed it",
    });

    expect(
      builderCardForRepairVerdict(
        "account",
        {
          diagnosis: "The preview needs its hosting account.",
          actions: [],
          fixed: false,
          blocker: "Link the account so I can continue.",
        },
        {
          reason: "account-link",
          actions: [{ label: "Link account", response: "opaque:link:host" }],
        },
      ),
    ).toEqual({
      id: "account",
      kind: "decision",
      reason: "account-link",
      title: "I need your help with one thing",
      detail:
        "The preview needs its hosting account. Link the account so I can continue.",
      actions: [{ label: "Link account", response: "opaque:link:host" }],
    });
  });

  it("drops legacy command diffs at the Build presentation boundary", () => {
    const card = builderCardFromQuestion({
      id: "publish",
      kind: "confirm",
      prompt: "Publish this version?",
      detail: "This makes the current version public.",
      diff: "vercel --prod --token super-secret",
      actions: [{ label: "Publish", response: "opaque:publish" }],
    });
    expect(card).toMatchObject({ kind: "decision", title: "Publish this version?" });
    expect(JSON.stringify(card)).not.toContain("vercel");
    expect(JSON.stringify(card)).not.toContain("super-secret");
  });

  it("turns only outstanding, routable attention into a card", () => {
    const item: AttentionItem = {
      id: "ask-1",
      kind: "question",
      tone: "warn",
      title: "Choose the account to link",
      body: "The repair can continue after this.",
      source: "agent",
      projectId: "p1",
      where: { kind: "terminal", ptyId: 9, projectId: "p1" },
      ts: 1,
    };
    expect(builderCardFromAttention(item)).toMatchObject({
      kind: "decision",
      title: "Choose the account to link",
      actions: [{ label: "Open request", response: "ask-1" }],
    });
    expect(builderCardFromAttention({ ...item, resolvedAt: 2 })).toBeNull();
    expect(builderCardFromAttention({ ...item, where: undefined })).toBeNull();
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import { ASH_STATES, ashGlyph, ashMayInterrupt } from "./ash";
import {
  ashStateFor,
  attentionItems,
  badgeFor,
  clearAttentionHistory,
  dismissToast,
  forProject,
  liveToasts,
  markAllRead,
  outstandingQuestions,
  osPayload,
  postAttention,
  resolveAttention,
  resolveAttentionByKey,
  shouldReachOS,
  toastMs,
  unreadCount,
  urgencyOf,
  type AttentionInput,
  type AttentionItem,
} from "./attention";

const post = (over: Partial<AttentionInput> = {}) =>
  postAttention({
    kind: "fyi",
    tone: "info",
    title: "Something happened",
    source: "app",
    ...over,
  });

const item = (over: Partial<AttentionItem> = {}): AttentionItem => ({
  id: "i1",
  kind: "fyi",
  tone: "info",
  title: "t",
  source: "app",
  ts: 1000,
  ...over,
});

beforeEach(() => {
  localStorage.clear();
});

describe("urgency", () => {
  it("derives from tone for an FYI", () => {
    expect(urgencyOf(item({ tone: "info" }))).toBe("low");
    expect(urgencyOf(item({ tone: "success" }))).toBe("low");
    expect(urgencyOf(item({ tone: "warn" }))).toBe("normal");
    expect(urgencyOf(item({ tone: "error" }))).toBe("high");
  });

  it("is high for a question regardless of tone", () => {
    // The whole point: no tone can talk a question down the scale.
    expect(urgencyOf(item({ kind: "question", tone: "info" }))).toBe("high");
    expect(urgencyOf(item({ kind: "question", tone: "success" }))).toBe("high");
  });
});

describe("toast lifetime", () => {
  it("fades low and normal urgency", () => {
    expect(toastMs(item({ tone: "info" }))).toBe(4500);
    expect(toastMs(item({ tone: "warn" }))).toBe(4500);
  });

  it("never puts a timer on an error or a question", () => {
    expect(toastMs(item({ tone: "error" }))).toBeNull();
    expect(toastMs(item({ kind: "question", tone: "info" }))).toBeNull();
  });

  it("retires a faded FYI but keeps a question up", () => {
    const fyi = item({ id: "a", ts: 0 });
    const q = item({ id: "b", kind: "question", ts: 0 });
    expect(liveToasts([fyi, q], 1000).map((x) => x.id)).toEqual(["a", "b"]);
    expect(liveToasts([fyi, q], 9000).map((x) => x.id)).toEqual(["b"]);
  });

  it("drops a question's toast once it is resolved", () => {
    const q = item({ id: "b", kind: "question", ts: 0, resolvedAt: 5 });
    expect(liveToasts([q], 9000)).toEqual([]);
  });

  it("drops a toast the user waved away", () => {
    const q = item({ id: "b", kind: "question", ts: 0, toastDismissedAt: 5 });
    expect(liveToasts([q], 1000)).toEqual([]);
  });
});

describe("routing to the OS", () => {
  it("never leaves the app while Canopy is focused", () => {
    expect(shouldReachOS(item({ kind: "question" }), true)).toBe(false);
    expect(shouldReachOS(item({ tone: "error" }), true)).toBe(false);
  });

  it("always routes a question", () => {
    expect(shouldReachOS(item({ kind: "question", tone: "info" }), false)).toBe(
      true,
    );
  });

  it("routes a reminder — being interrupted is what was asked for", () => {
    expect(shouldReachOS(item({ source: "reminder", tone: "warn" }), false)).toBe(
      true,
    );
  });

  it("stays out of the OS when something else already put it there", () => {
    // A note reminder fired by launchd: the banner is already on screen, from
    // a job that runs whether or not Canopy is open. Posting it again is the
    // one way this feature becomes two notifications for one reminder.
    expect(
      shouldReachOS(
        item({ source: "reminder", tone: "warn", osHandled: true }),
        false,
      ),
    ).toBe(false);
    // Even a question, which otherwise always routes.
    expect(
      shouldReachOS(item({ kind: "question", osHandled: true }), false),
    ).toBe(false);
  });

  it("routes low-tone items from sources that assume you are away", () => {
    // A teammate's file lands as "success", and a micro-task's whole promise is
    // that you tabbed away — the tone describes the event, not how much it
    // matters that you never saw it.
    expect(shouldReachOS(item({ source: "team", tone: "success" }), false)).toBe(
      true,
    );
    expect(shouldReachOS(item({ source: "task", tone: "success" }), false)).toBe(
      true,
    );
  });

  it("keeps an agent's routine chatter in the app", () => {
    expect(shouldReachOS(item({ source: "agent", tone: "info" }), false)).toBe(
      false,
    );
    expect(shouldReachOS(item({ source: "app", tone: "success" }), false)).toBe(
      false,
    );
  });

  it("routes anything above low", () => {
    expect(shouldReachOS(item({ source: "agent", tone: "warn" }), false)).toBe(
      true,
    );
    expect(shouldReachOS(item({ source: "agent", tone: "error" }), false)).toBe(
      true,
    );
  });

  // The state clause IS ashMayInterrupt — not a second predicate that happens
  // to agree with it today. For the sources with no say of their own, the two
  // must be the same function.
  it("is exactly ashMayInterrupt for a source that adds nothing", () => {
    for (const source of ["agent", "app", "project"] as const) {
      for (const kind of ["fyi", "question"] as const) {
        for (const tone of ["info", "success", "warn", "error"] as const) {
          const x = item({ source, kind, tone });
          expect(shouldReachOS(x, false), `${source}/${kind}/${tone}`).toBe(
            ashMayInterrupt(ashStateFor(x)),
          );
        }
      }
    }
  });
});

describe("the face an item wears", () => {
  it("gives an outstanding question `needs`, and an error one `blocked`", () => {
    expect(ashStateFor(item({ kind: "question" }))).toBe("needs");
    expect(ashStateFor(item({ kind: "question", tone: "error" }))).toBe(
      "blocked",
    );
  });

  it("separates a question you answered from one that withdrew itself", () => {
    // "You never answered this" and "it sorted itself out" read very
    // differently a day later — the distinction `resolution` exists to record.
    const q = { kind: "question" as const, resolvedAt: 5 };
    expect(ashStateFor(item({ ...q, resolution: "answered" }))).toBe("done");
    expect(ashStateFor(item({ ...q, resolution: "withdrawn" }))).toBe("sleeping");
  });

  it("maps FYI tones onto faces", () => {
    expect(ashStateFor(item({ tone: "info" }))).toBe("done");
    expect(ashStateFor(item({ tone: "success" }))).toBe("done");
    expect(ashStateFor(item({ tone: "error" }))).toBe("blocked");
  });

  // main maps canopy_notify's warn level to `needs`, and `needs` is one of the
  // two states allowed to interrupt. `explaining` reads better in the abstract
  // but would silently stop warns raising a banner.
  it("keeps a warn FYI on a face that may interrupt", () => {
    expect(ashStateFor(item({ tone: "warn" }))).toBe("needs");
    expect(ashMayInterrupt(ashStateFor(item({ tone: "warn" })))).toBe(true);
  });

  it("only ever asks Ash for a state Ash knows", () => {
    const every: AttentionItem[] = [
      item({ kind: "question" }),
      item({ kind: "question", tone: "error" }),
      item({ kind: "question", resolvedAt: 1, resolution: "answered" }),
      item({ kind: "question", resolvedAt: 1, resolution: "withdrawn" }),
      ...(["info", "success", "warn", "error"] as const).map((tone) =>
        item({ tone }),
      ),
    ];
    for (const x of every) expect(ASH_STATES).toContain(ashStateFor(x));
  });
});

describe("osPayload", () => {
  it("titles from the source, names the project, and wears the glyph", () => {
    expect(osPayload(item({ source: "task", projectName: "api" })).title).toBe(
      `Canopy — Task · api ${ashGlyph("done")}`,
    );
  });

  it("falls back to the bare source title with no project", () => {
    expect(osPayload(item({ source: "team" })).title).toBe(
      `Canopy — Team ${ashGlyph("done")}`,
    );
  });

  it("carries the glyph on every banner, not just the two that had it", () => {
    // Was hand-written at two call sites; a teammate's message and an agent's
    // question never got one.
    expect(osPayload(item({ source: "team", kind: "question" })).title).toContain(
      ashGlyph("needs"),
    );
    expect(osPayload(item({ source: "agent", tone: "error" })).title).toContain(
      ashGlyph("blocked"),
    );
  });

  it("folds the body in", () => {
    expect(osPayload(item({ title: "Blocked", body: "needs a token" })).body).toBe(
      "Blocked — needs a token",
    );
  });
});

describe("the queue", () => {
  it("queues rather than replaces", () => {
    // The single most-broken property of the toast this succeeds.
    post({ title: "first" });
    post({ title: "second" });
    expect(attentionItems().map((x) => x.title)).toEqual(["second", "first"]);
  });

  it("collapses a re-posted question onto one item", () => {
    const a = post({ kind: "question", title: "Switch branch?", dedupeKey: "s1" });
    const b = post({ kind: "question", title: "Switch branch?", dedupeKey: "s1" });
    expect(b).toBe(a);
    expect(attentionItems()).toHaveLength(1);
  });

  it("keeps the original arrival time when a question is re-derived", () => {
    // "Waiting since" is the useful timestamp, not "last recomputed".
    post({ kind: "question", title: "q", dedupeKey: "s1", ts: 100 });
    post({ kind: "question", title: "q updated", dedupeKey: "s1", ts: 900 });
    const [only] = attentionItems();
    expect(only.ts).toBe(100);
    expect(only.title).toBe("q updated");
  });

  it("does not collapse onto an already-resolved question", () => {
    const a = post({ kind: "question", title: "q", dedupeKey: "s1" });
    resolveAttention(a, "answered");
    const b = post({ kind: "question", title: "q again", dedupeKey: "s1" });
    expect(b).not.toBe(a);
    expect(attentionItems()).toHaveLength(2);
  });

  it("collapses a re-posted keyed FYI onto one refreshed item", () => {
    // Clicking the same dead deep link five times is one announcement, not
    // five rows — the spam this rule exists to stop.
    const a = post({ title: "one", dedupeKey: "k", ts: 100 });
    const b = post({ title: "two", dedupeKey: "k", ts: 900 });
    expect(b).toBe(a);
    expect(attentionItems()).toHaveLength(1);
    const [only] = attentionItems();
    expect(only.title).toBe("two");
    // "Announced again now", unlike a question's "waiting since".
    expect(only.ts).toBe(900);
  });

  it("re-announcing a keyed FYI clears read and dismissed state", () => {
    post({ title: "one", dedupeKey: "k", ts: 100 });
    markAllRead();
    dismissToast(attentionItems()[0].id);
    post({ title: "one", dedupeKey: "k", ts: 900 });
    const [only] = attentionItems();
    expect(only.readAt).toBeUndefined();
    expect(only.toastDismissedAt).toBeUndefined();
    expect(liveToasts(attentionItems(), 1000)).toHaveLength(1);
  });

  it("keeps a keyed FYI out of a question's identity", () => {
    const q = post({ kind: "question", title: "q", dedupeKey: "k" });
    resolveAttention(q, "answered");
    post({ title: "fyi", dedupeKey: "k" });
    // The resolved question is history, not the FYI's earlier self.
    expect(attentionItems()).toHaveLength(2);
  });
});

describe("resolving", () => {
  it("takes a question out of the outstanding set", () => {
    const id = post({ kind: "question", title: "q" });
    expect(outstandingQuestions(attentionItems())).toHaveLength(1);
    resolveAttention(id, "answered");
    expect(outstandingQuestions(attentionItems())).toHaveLength(0);
  });

  it("keeps the resolved question in history", () => {
    const id = post({ kind: "question", title: "q" });
    resolveAttention(id, "answered");
    expect(attentionItems()).toHaveLength(1);
    expect(attentionItems()[0].resolution).toBe("answered");
  });

  it("lets the first writer win when answer and withdraw race", () => {
    const id = post({ kind: "question", title: "q" });
    resolveAttention(id, "answered");
    resolveAttention(id, "withdrawn");
    expect(attentionItems()[0].resolution).toBe("answered");
  });

  it("withdraws every outstanding question for an asker", () => {
    post({ kind: "question", title: "a", dedupeKey: "sess" });
    post({ kind: "question", title: "b", dedupeKey: "other" });
    resolveAttentionByKey("sess", "withdrawn");
    expect(outstandingQuestions(attentionItems()).map((x) => x.title)).toEqual([
      "b",
    ]);
  });

  it("orders outstanding questions oldest first", () => {
    post({ kind: "question", title: "old", ts: 100 });
    post({ kind: "question", title: "new", ts: 900 });
    expect(outstandingQuestions(attentionItems()).map((x) => x.title)).toEqual([
      "old",
      "new",
    ]);
  });
});

describe("reading versus resolving", () => {
  it("marks everything read", () => {
    post({ title: "a" });
    post({ title: "b" });
    expect(unreadCount(attentionItems())).toBe(2);
    markAllRead();
    expect(unreadCount(attentionItems())).toBe(0);
  });

  it("leaves an outstanding question counted after it has been read", () => {
    // Looking at a question is not answering it.
    post({ kind: "question", title: "q" });
    markAllRead();
    expect(outstandingQuestions(attentionItems())).toHaveLength(1);
    expect(badgeFor(attentionItems()).count).toBe(1);
  });

  it("does not resolve a question by dismissing its toast", () => {
    const id = post({ kind: "question", title: "q" });
    dismissToast(id);
    expect(outstandingQuestions(attentionItems())).toHaveLength(1);
  });
});

describe("the badge", () => {
  it("counts waiting work ahead of unread arrivals", () => {
    post({ title: "fyi one" });
    post({ title: "fyi two" });
    post({ kind: "question", title: "q" });
    expect(badgeFor(attentionItems())).toEqual({ count: 1, urgency: "high" });
  });

  it("falls back to unread when nothing is waiting", () => {
    post({ title: "a", tone: "warn" });
    expect(badgeFor(attentionItems())).toEqual({ count: 1, urgency: "normal" });
  });

  it("takes the highest urgency among unread", () => {
    post({ title: "a", tone: "info" });
    post({ title: "b", tone: "error" });
    expect(badgeFor(attentionItems()).urgency).toBe("high");
  });

  it("is empty once everything is read and answered", () => {
    post({ title: "a" });
    markAllRead();
    expect(badgeFor(attentionItems()).count).toBe(0);
  });
});

describe("history", () => {
  it("scopes to a project", () => {
    post({ title: "a", projectId: "p1" });
    post({ title: "b", projectId: "p2" });
    expect(forProject(attentionItems(), "p1").map((x) => x.title)).toEqual(["a"]);
  });

  it("clears read history but keeps work still waiting", () => {
    post({ title: "fyi" });
    post({ kind: "question", title: "q" });
    clearAttentionHistory();
    expect(attentionItems().map((x) => x.title)).toEqual(["q"]);
  });

  it("survives a corrupt store", () => {
    localStorage.setItem("canopy.attention", "{not json");
    expect(attentionItems()).toEqual([]);
    post({ title: "a" });
    expect(attentionItems()).toHaveLength(1);
  });

  it("keeps an outstanding question past the cap", () => {
    // The cap exists for storage, not for correctness — a stall that ages out
    // of its own queue is exactly the failure this module prevents.
    post({ kind: "question", title: "waiting" });
    for (let i = 0; i < 320; i++) post({ title: `fyi ${i}` });
    const items = attentionItems();
    expect(items.length).toBeLessThanOrEqual(301);
    expect(items.some((x) => x.title === "waiting")).toBe(true);
  });
});

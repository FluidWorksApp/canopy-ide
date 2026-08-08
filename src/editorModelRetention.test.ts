import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { editor } from "monaco-editor";
import {
  acknowledgeEditorModelRestore,
  cancelInactiveEditorModel,
  closeEditorModelOwner,
  editorModelRetentionMetrics,
  forgetEditorModel,
  leaseEditorModel,
  refreshEditorModelInstance,
  removeEditorModelOwner,
  resetEditorModelRetentionForTest,
  retainedEditorModelText,
  retainedTextBytes,
  scheduleInactiveEditorModel,
  shedInactiveEditorModels,
  updateEditorModelOwner,
} from "./editorModelRetention";

function fakeModel(path: string, text: string, disposeError?: Error) {
  let disposed = false;
  const model = {
    uri: { path, toString: () => `file://${path}` },
    getValue: vi.fn(() => text),
    isDisposed: vi.fn(() => disposed),
    dispose: vi.fn(() => {
      if (disposeError) throw disposeError;
      disposed = true;
    }),
  } as unknown as editor.ITextModel;
  return { model, disposed: () => disposed };
}

describe("inactive editor model retention", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetEditorModelRetentionForTest();
  });

  afterEach(() => {
    resetEditorModelRetentionForTest();
    vi.useRealTimers();
  });

  it("compacts losslessly after the idle boundary and releases on restore", () => {
    const source = "const fruit = '🍌';\n";
    const fake = fakeModel("/repo/a.ts", source);
    expect(
      scheduleInactiveEditorModel(fake.model, { protected: false, delayMs: 50 }),
    ).toBe(true);
    vi.advanceTimersByTime(49);
    expect(fake.disposed()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(fake.disposed()).toBe(true);
    expect(retainedEditorModelText("file:///repo/a.ts")).toBe(source);
    expect(editorModelRetentionMetrics()).toMatchObject({
      pendingModels: 0,
      retainedModels: 1,
      compacted: 1,
    });

    acknowledgeEditorModelRestore("file:///repo/a.ts");
    expect(retainedEditorModelText("file:///repo/a.ts")).toBeUndefined();
    expect(editorModelRetentionMetrics()).toMatchObject({
      retainedModels: 0,
      retainedBytes: 0,
      restored: 1,
    });
  });

  it("never schedules a collaborating model", () => {
    const fake = fakeModel("/repo/shared.ts", "unsaved");
    expect(
      scheduleInactiveEditorModel(fake.model, { protected: true, delayMs: 0 }),
    ).toBe(false);
    vi.runAllTimers();
    expect(fake.disposed()).toBe(false);
    expect(editorModelRetentionMetrics().protectedSkipped).toBe(1);
  });

  it("cancels on reactivation and accelerates only existing candidates", () => {
    const cancelled = fakeModel("/repo/cancel.ts", "a");
    scheduleInactiveEditorModel(cancelled.model, {
      protected: false,
      delayMs: 60_000,
    });
    expect(cancelInactiveEditorModel("file:///repo/cancel.ts")).toBe(true);
    vi.runAllTimers();
    expect(cancelled.disposed()).toBe(false);

    const shed = fakeModel("/repo/shed.ts", "b");
    scheduleInactiveEditorModel(shed.model, {
      protected: false,
      delayMs: 60_000,
    });
    expect(shedInactiveEditorModels()).toBe(1);
    vi.runAllTimers();
    expect(shed.disposed()).toBe(true);
  });

  it("leaves the live model untouched when a backing would exceed its cap", () => {
    const fake = fakeModel("/repo/huge.ts", "x".repeat(8 * 1024 * 1024 + 1));
    scheduleInactiveEditorModel(fake.model, { protected: false, delayMs: 0 });
    vi.runAllTimers();
    expect(fake.disposed()).toBe(false);
    expect(retainedEditorModelText("file:///repo/huge.ts")).toBeUndefined();
    expect(editorModelRetentionMetrics().admissionRejected).toBe(1);
  });

  it("rolls back the backing if Monaco refuses disposal", () => {
    const fake = fakeModel("/repo/fail.ts", "keep live", new Error("busy"));
    scheduleInactiveEditorModel(fake.model, { protected: false, delayMs: 0 });
    vi.runAllTimers();
    expect(retainedEditorModelText("file:///repo/fail.ts")).toBeUndefined();
    expect(editorModelRetentionMetrics()).toMatchObject({
      failures: 1,
      retainedBytes: 0,
    });
  });

  it("forgets both a pending or compacted owner at tab close", () => {
    const pending = fakeModel("/repo/pending.ts", "pending");
    scheduleInactiveEditorModel(pending.model, {
      protected: false,
      delayMs: 60_000,
    });
    forgetEditorModel("file:///repo/pending.ts");
    vi.runAllTimers();
    expect(pending.disposed()).toBe(false);

    const compacted = fakeModel("/repo/closed.ts", "closed");
    scheduleInactiveEditorModel(compacted.model, { protected: false, delayMs: 0 });
    vi.runAllTimers();
    forgetEditorModel("file:///repo/closed.ts");
    expect(retainedEditorModelText("file:///repo/closed.ts")).toBeUndefined();
    expect(editorModelRetentionMetrics().forgotten).toBe(1);
  });

  it("charges the larger UTF-8 or JS code-unit representation", () => {
    expect(retainedTextBytes("abc")).toBe(6);
    expect(retainedTextBytes("🍌")).toBe(4);
    expect(retainedTextBytes("€")).toBe(3);
  });

  it("does not compact a shared model while any owner is active", () => {
    const fake = fakeModel("/repo/two-views.ts", "same model");
    updateEditorModelOwner("hidden", fake.model, {
      active: false,
      protected: false,
    });
    updateEditorModelOwner("visible", fake.model, {
      active: true,
      protected: false,
    });
    shedInactiveEditorModels();
    vi.runAllTimers();
    expect(fake.disposed()).toBe(false);

    removeEditorModelOwner("visible");
    shedInactiveEditorModels();
    vi.runAllTimers();
    expect(fake.disposed()).toBe(true);
  });

  it("leases a rehydrated model for an agent operation then reschedules it", () => {
    const key = "file:///repo/agent.ts";
    const original = fakeModel("/repo/agent.ts", "unsaved");
    updateEditorModelOwner("hidden", original.model, {
      active: false,
      protected: false,
    });
    shedInactiveEditorModels();
    vi.runAllTimers();
    expect(original.disposed()).toBe(true);

    const release = leaseEditorModel(key);
    const recreated = fakeModel("/repo/agent.ts", "unsaved");
    refreshEditorModelInstance(recreated.model);
    acknowledgeEditorModelRestore(key);
    shedInactiveEditorModels();
    vi.runAllTimers();
    expect(recreated.disposed()).toBe(false);

    release();
    shedInactiveEditorModels();
    vi.runAllTimers();
    expect(recreated.disposed()).toBe(true);
  });

  it("fails closed when owner tracking saturates", () => {
    const hidden = fakeModel("/repo/hidden.ts", "must stay live");
    updateEditorModelOwner("hidden", hidden.model, {
      active: false,
      protected: false,
    });
    for (let i = 0; i < 255; i += 1) {
      const active = fakeModel(`/repo/active-${i}.ts`, "active");
      expect(
        updateEditorModelOwner(`active-${i}`, active.model, {
          active: true,
          protected: false,
        }),
      ).toBe(true);
    }
    const overflow = fakeModel("/repo/hidden.ts", "same shared model");
    expect(
      updateEditorModelOwner("overflow", overflow.model, {
        active: true,
        protected: false,
      }),
    ).toBe(false);
    expect(shedInactiveEditorModels()).toBe(0);
    vi.runAllTimers();
    expect(hidden.disposed()).toBe(false);
    expect(editorModelRetentionMetrics().ownerRejected).toBe(1);
  });

  it("fails closed while lease tracking is saturated", () => {
    const hidden = fakeModel("/repo/lease-hidden.ts", "must stay live");
    updateEditorModelOwner("hidden", hidden.model, {
      active: false,
      protected: false,
    });
    const releases = Array.from({ length: 128 }, (_, i) =>
      leaseEditorModel(`file:///repo/lease-${i}.ts`),
    );
    const overflowRelease = leaseEditorModel("file:///repo/overflow.ts");
    expect(shedInactiveEditorModels()).toBe(0);
    vi.runAllTimers();
    expect(hidden.disposed()).toBe(false);
    overflowRelease();
    releases.forEach((release) => release());
    shedInactiveEditorModels();
    vi.runAllTimers();
    expect(hidden.disposed()).toBe(true);
  });

  it("disposes an agent model instead of retaining it after its tab closes", () => {
    const key = "file:///repo/closed-during-agent.ts";
    const model = fakeModel("/repo/closed-during-agent.ts", "unsaved");
    updateEditorModelOwner("tab", model.model, {
      active: true,
      protected: false,
    });
    const release = leaseEditorModel(key);
    refreshEditorModelInstance(model.model);
    forgetEditorModel(key);
    release();
    expect(model.disposed()).toBe(true);
    expect(retainedEditorModelText(key)).toBeUndefined();
  });

  it("closes only one owner of a model shared across projects", () => {
    const key = "file:///repo/shared-owner.ts";
    const model = fakeModel("/repo/shared-owner.ts", "shared unsaved text");
    updateEditorModelOwner("project-a:tab", model.model, {
      active: true,
      protected: false,
    });
    updateEditorModelOwner("project-b:tab", model.model, {
      active: true,
      protected: false,
    });

    closeEditorModelOwner("project-a:tab", key, model.model);
    expect(model.disposed()).toBe(false);
    shedInactiveEditorModels();
    vi.runAllTimers();
    expect(model.disposed()).toBe(false);

    closeEditorModelOwner("project-b:tab", key, model.model);
    expect(model.disposed()).toBe(true);
  });

  it("keeps a last-owner model alive only until its agent lease releases", () => {
    const key = "file:///repo/leased-owner.ts";
    const model = fakeModel("/repo/leased-owner.ts", "leased unsaved text");
    updateEditorModelOwner("project:tab", model.model, {
      active: true,
      protected: false,
    });
    const release = leaseEditorModel(key);

    closeEditorModelOwner("project:tab", key, model.model);
    expect(model.disposed()).toBe(false);
    expect(retainedEditorModelText(key)).toBeUndefined();

    release();
    expect(model.disposed()).toBe(true);
    expect(retainedEditorModelText(key)).toBeUndefined();
  });
});

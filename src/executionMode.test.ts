import { expect, it } from "vitest";
import { canSwitchExecutionMode, registerExecutionModeGuard } from "./executionMode";
it("protects unsaved buffers across every mounted project", () => {
  let dirty = true;
  const clean = registerExecutionModeGuard(() => true);
  const editing = registerExecutionModeGuard(() => !dirty);
  try {
    expect(canSwitchExecutionMode()).toBe(false);
    dirty = false;
    expect(canSwitchExecutionMode()).toBe(true);
  } finally { clean(); editing(); }
});
it("fails closed on an unhealthy owner and releases the guard on teardown", () => {
  const release = registerExecutionModeGuard(() => { throw new Error("unavailable"); });
  expect(canSwitchExecutionMode()).toBe(false);
  release();
  expect(canSwitchExecutionMode()).toBe(true);
});

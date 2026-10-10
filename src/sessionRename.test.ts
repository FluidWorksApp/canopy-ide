import { beforeEach, expect, it, vi } from "vitest";
const setName = vi.hoisted(() => vi.fn());
vi.mock("./ipc", () => ({ ptySetName: setName }));
beforeEach(() => {
  vi.resetModules();
  setName.mockReset();
});
const deferred = () => {
  let resolve!: (value: string) => void;
  const promise = new Promise<string>((r) => (resolve = r));
  return { promise, resolve };
};
it("publishes the user choice immediately before waiting for the host", async () => {
  const ipc = deferred();
  setName.mockReturnValue(ipc.promise);
  const { renameSession, onSessionRenamed } = await import("./sessionRename");
  const events = vi.fn();
  const stop = onSessionRenamed(events);
  const save = renameSession(7, "My permanent name");
  expect(events).toHaveBeenCalledWith(
    expect.objectContaining({
      accepted: "My permanent name",
      source: "intent",
    }),
  );
  await Promise.resolve();
  ipc.resolve("Host label");
  expect(await save).toBe("My permanent name");
  stop();
});
it("a late older rename cannot replace a newer explicit choice", async () => {
  const first = deferred();
  setName
    .mockReturnValueOnce(first.promise)
    .mockResolvedValueOnce("Latest name");
  const { renameSession, onSessionRenamed } = await import("./sessionRename");
  const events: unknown[] = [];
  const stop = onSessionRenamed((e) => events.push(e));
  const older = renameSession(7, "Old name");
  await Promise.resolve();
  await Promise.resolve();
  const newer = renameSession(7, "Latest name");
  first.resolve("Old name");
  await Promise.all([older, newer]);
  expect(setName.mock.calls).toEqual([
    [7, "Old name"],
    [7, "Latest name"],
  ]);
  expect(events).not.toContainEqual(
    expect.objectContaining({ source: "confirmed", accepted: "Old name" }),
  );
  stop();
});
it("an automatic restore cannot undo a name the user chose while it was pending", async () => {
  const restored = deferred();
  setName
    .mockReturnValueOnce(restored.promise)
    .mockResolvedValueOnce("User wins");
  const { renameSession, reassertSessionName, onSessionRenamed } =
    await import("./sessionRename");
  const events: unknown[] = [];
  const stop = onSessionRenamed((e) => events.push(e));
  const restore = reassertSessionName(7, "Saved old label");
  await Promise.resolve();
  await Promise.resolve();
  const user = renameSession(7, "User wins");
  restored.resolve("Saved old label");
  await Promise.all([restore, user]);
  expect(events).not.toContainEqual(
    expect.objectContaining({ source: "restore", accepted: "Saved old label" }),
  );
  expect(setName).toHaveBeenLastCalledWith(7, "User wins");
  stop();
});
it("reasserting a saved name does not publish another user edit", async () => {
  setName.mockResolvedValue("Saved name");
  const { reassertSessionName, onSessionRenamed } =
    await import("./sessionRename");
  const listener = vi.fn();
  const stop = onSessionRenamed(listener);
  await reassertSessionName(7, "Saved name");
  expect(listener).toHaveBeenCalledWith(
    expect.objectContaining({ source: "restore" }),
  );
  expect(listener).not.toHaveBeenCalledWith(
    expect.objectContaining({ source: "intent" }),
  );
  stop();
});

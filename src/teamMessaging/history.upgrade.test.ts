import { afterEach, describe, expect, it, vi } from "vitest";

// The chat history database went from v1 (keys, messages) to v2 (plus events)
// with reactions. Every existing install takes this path on its first launch
// after updating, so the upgrade must only add the events store and leave the
// stored keys and messages alone.

type Request = {
  result: unknown;
  error: unknown;
  onupgradeneeded?: (event: { oldVersion: number }) => void;
  onsuccess?: () => void;
  onerror?: () => void;
  onblocked?: () => void;
};

function fakeIndexedDb() {
  const calls: string[] = [];
  const store = { createIndex: (name: string) => calls.push(`index:${name}`) };
  const db = {
    createObjectStore: (name: string) => {
      calls.push(`create:${name}`);
      return store;
    },
    deleteObjectStore: (name: string) => calls.push(`delete:${name}`),
  };
  let request: Request | undefined;
  let version: number | undefined;
  vi.stubGlobal("indexedDB", {
    open: (_name: string, v: number) => {
      version = v;
      request = { result: db, error: Error("stop") };
      return request;
    },
  });
  return {
    calls,
    version: () => version,
    request: () => {
      if (!request) throw Error("history never opened the database");
      return request;
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("chat history database upgrade", () => {
  it("adds only the events store to an existing v1 database", async () => {
    const idb = fakeIndexedDb();
    const history = await import("./history");
    const load = history.loadChatHistory("account", "team").catch(() => "failed");
    await vi.waitFor(() => idb.request());
    expect(idb.version()).toBe(2);
    idb.request().onupgradeneeded?.({ oldVersion: 1 });
    expect(idb.calls).toEqual(["create:events", "index:scope"]);
    idb.request().onerror?.();
    expect(await load).toBe("failed");
  });

  it("creates every store on a fresh install", async () => {
    const idb = fakeIndexedDb();
    const history = await import("./history");
    const load = history.loadChatHistory("account", "team").catch(() => "failed");
    await vi.waitFor(() => idb.request());
    idb.request().onupgradeneeded?.({ oldVersion: 0 });
    expect(idb.calls).toEqual([
      "create:keys",
      "create:messages",
      "index:scope",
      "create:events",
      "index:scope",
    ]);
    idb.request().onerror?.();
    await load;
  });

  it("asks to close other windows when an older one holds the database", async () => {
    const idb = fakeIndexedDb();
    const history = await import("./history");
    const load = history.loadChatHistory("account", "team");
    await vi.waitFor(() => idb.request());
    idb.request().onblocked?.();
    await expect(load).rejects.toThrow("Close other Canopy windows to update chat history");
  });
});

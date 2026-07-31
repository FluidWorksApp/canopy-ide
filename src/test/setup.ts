// Global test setup, loaded by vitest.config.ts before every test file.
//
// Two jobs: bring in jest-dom's matchers (toBeInTheDocument, etc.) for the RTL
// component tests, and neutralise the Tauri IPC boundary so nothing tries to
// reach a real backend. Every command the frontend invokes goes through
// @tauri-apps/api's `invoke`; mockIPC intercepts it. Individual tests that need
// a specific response call mockIPC themselves (see mockCommands below); the
// default here just rejects unmocked commands loudly so an accidental IPC call
// in a "pure" test fails visibly instead of hanging.
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { cleanup } from "@testing-library/react";

// jsdom 29 no longer provides localStorage (node's own is behind
// --localstorage-file), and the app stores its small persistent state there:
// settings, remembered terminals, learned agent binaries. Without this every
// test touching those throws on the first `localStorage.clear()`.
if (typeof globalThis.localStorage === "undefined") {
  const store = new Map<string, string>();
  globalThis.localStorage = {
    get length() {
      return store.size;
    },
    key: (i: number) => [...store.keys()][i] ?? null,
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  } as Storage;
}

// jsdom has no layout, so it ships no scrollIntoView. Any list that keeps its
// selection in view (the palettes, the tab strip) would throw on the first
// arrow key — a no-op stands in, since there is nothing to scroll here.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

beforeEach(() => {
  mockIPC((cmd) => {
    throw new Error(
      `Unmocked Tauri command "${cmd}". Call mockCommands({ ${cmd}: ... }) in this test.`,
    );
  });
});

afterEach(() => {
  cleanup();
  clearMocks();
});

/**
 * Register handlers for specific Tauri commands in a test. Unlisted commands
 * still throw. A handler may be a plain value (returned as-is) or a function of
 * the command's args.
 *
 *   mockCommands({ list_projects: () => [{ id: "a" }] });
 */
export function mockCommands(
  handlers: Record<string, unknown | ((args: Record<string, unknown>) => unknown)>,
): void {
  mockIPC((cmd, args) => {
    if (!(cmd in handlers)) {
      throw new Error(`Unmocked Tauri command "${cmd}".`);
    }
    const h = handlers[cmd];
    return typeof h === "function"
      ? (h as (a: Record<string, unknown>) => unknown)((args ?? {}) as Record<string, unknown>)
      : h;
  });
}

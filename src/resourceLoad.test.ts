import { describe as suite, expect, it } from "vitest";
import {
  LOAD_THRESHOLDS,
  loadFlags,
  loadNote,
  withLoadNote,
} from "./resourceLoad";

const GB = 1024 ** 3;

suite("what counts as abnormal", () => {
  it("leaves an ordinary agent session alone", () => {
    expect(loadFlags("session", 6, 282 * 1024 ** 2).hot).toBe(false);
  });

  it("flags a session pinning a core, on CPU only", () => {
    const f = loadFlags("session", 100, 582 * 1024 ** 2);
    expect(f).toEqual({ cpu: true, mem: false, hot: true });
  });

  it("flags a session holding gigabytes, on memory only", () => {
    const f = loadFlags("session", 6, 1.5 * GB);
    expect(f).toEqual({ cpu: false, mem: true, hot: true });
  });

  it("is inclusive at the threshold", () => {
    expect(loadFlags("proc", LOAD_THRESHOLDS.proc.cpu, 0).cpu).toBe(true);
    expect(loadFlags("proc", LOAD_THRESHOLDS.proc.cpu - 0.1, 0).cpu).toBe(
      false,
    );
  });

  it("gives a process less rope than the session containing it", () => {
    // 1 GB is a runaway language server, and unremarkable as a whole tree.
    expect(loadFlags("proc", 0, 1 * GB).mem).toBe(true);
    expect(loadFlags("session", 0, 1 * GB).mem).toBe(false);
  });

  it("does not paint a project total red just for summing busy terminals", () => {
    // The screenshot case: seven sessions, 118% and 3.8 GB between them.
    expect(loadFlags("group", 118, 3.8 * GB).hot).toBe(false);
  });

  it("treats a missing reading as fine, not as hot", () => {
    expect(loadFlags("session", NaN, NaN).hot).toBe(false);
  });
});

suite("explaining the red", () => {
  it("says nothing when nothing is wrong", () => {
    expect(loadNote("session", loadFlags("session", 1, 1))).toBe("");
  });

  it("names both dimensions when both are over", () => {
    const note = loadNote("proc", loadFlags("proc", 300, 4 * GB));
    expect(note).toContain("CPU");
    expect(note).toContain("memory");
  });

  it("keeps the row's own tooltip and appends the reason", () => {
    const note = loadNote("session", loadFlags("session", 400, 0));
    expect(withLoadNote("/w/app", note)).toBe(`/w/app\n\n${note}`);
    expect(withLoadNote(undefined, note)).toBe(note);
    expect(withLoadNote("/w/app", "")).toBe("/w/app");
  });
});

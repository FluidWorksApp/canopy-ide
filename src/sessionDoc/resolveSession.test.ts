import { beforeEach, describe, expect, it } from "vitest";
import type { SessionDigest } from "../ipc";
import { notePtyStats, resetPtyBirthsForTests } from "../ptyBirth";
import { pickSession, resolveSessionId } from "./resolveSession";

const NOW = 1_760_000_000;
const d = (id: string, over: Partial<SessionDigest> = {}): SessionDigest => ({
  session_id: id,
  agent: "cli-a",
  cwd: "/repo",
  updated: NOW,
  ...over,
});

describe("pickSession", () => {
  it("takes a session bound to this terminal first", () => {
    const got = pickSession([d("newer", { updated: NOW + 50 }), d("bound", { surface: "7" })], {
      agent: "cli-a",
      cwd: "/repo",
      ptyId: 7,
    });
    expect(got?.session_id).toBe("bound");
  });

  it("finds the CLI's own newest session in the folder, either path style", () => {
    const got = pickSession(
      [
        d("old", { updated: NOW - 600 }),
        d("other-cli", { agent: "cli-b", updated: NOW + 10 }),
        d("elsewhere", { cwd: "/other", updated: NOW + 10 }),
        d("win", { cwd: "C:\\repo\\", updated: NOW }),
      ],
      { agent: "cli-a", cwd: "C:/repo" },
    );
    expect(got?.session_id).toBe("win");
  });

  it("only counts sessions written since the terminal started", () => {
    const older = [d("yesterday", { updated: NOW - 86_400 })];
    const birth = { at: NOW * 1000, precise: true };
    // Nothing written yet in this terminal: the old session is not it.
    expect(pickSession(older, { agent: "cli-a", cwd: "/repo", birth })).toBeNull();
    expect(
      pickSession([...older, d("today", { updated: NOW + 3 })], { agent: "cli-a", cwd: "/repo", birth })?.session_id,
    ).toBe("today");
    // A terminal that was already running when watching began: a hint only.
    expect(pickSession(older, { agent: "cli-a", cwd: "/repo", birth: { ...birth, precise: false } })?.session_id).toBe(
      "yesterday",
    );
  });

  it("skips sessions another terminal is running", () => {
    const got = pickSession([d("theirs", { updated: NOW + 9 }), d("mine")], {
      agent: "cli-a",
      cwd: "/repo",
      taken: new Set(["theirs"]),
    });
    expect(got?.session_id).toBe("mine");
  });
});

describe("resolveSessionId", () => {
  beforeEach(() => resetPtyBirthsForTests());

  it("reads the stores for the folder and uses the terminal's start", async () => {
    notePtyStats([], NOW * 1000 - 60_000);
    notePtyStats([{ id: 4 }], NOW * 1000);
    const roots: string[][] = [];
    const got = await resolveSessionId(
      { agent: "cli-a", cwd: "/repo", ptyId: 4 },
      {
        digests: async (r) => {
          roots.push(r);
          return [d("before", { updated: NOW - 100 }), d("after", { updated: NOW + 2 })];
        },
      },
    );
    expect(roots).toEqual([["/repo"]]);
    expect(got?.session_id).toBe("after");
  });

  it("never throws", async () => {
    expect(await resolveSessionId({ agent: "cli-a", cwd: "/repo" }, { digests: () => Promise.reject(new Error("x")) })).toBeNull();
  });
});

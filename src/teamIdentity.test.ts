import { afterEach, describe, expect, it } from "vitest";
import { mockCommands } from "./test/setup";
import { ptySpawnArgv } from "./ipc";
import { isMe, parseIdentity, peekTeamIdentity, setTeamIdentityFetchForTests, teamIdentity } from "./teamIdentity";

afterEach(() => setTeamIdentityFetchForTests(null));

describe("team identity", () => {
  it("reads /api/me, and nothing without an id is a signed-in person", () => {
    expect(parseIdentity({ user: { id: "u1", name: "Ana", email: "ana@example.test" } })).toEqual({
      id: "u1",
      name: "Ana",
      email: "ana@example.test",
    });
    expect(parseIdentity({ user: { id: "u1", email: "ana@example.test" } })?.name).toBe("ana");
    expect(parseIdentity({ user: { name: "Ana" } })).toBeNull();
    expect(parseIdentity(null)).toBeNull();
  });

  it("asks once, and forgets on an account change", async () => {
    let calls = 0;
    setTeamIdentityFetchForTests(async () => {
      calls++;
      return { user: { id: `u${calls}`, name: "Ana", email: "a@example.test" } };
    });
    expect((await teamIdentity())?.id).toBe("u1");
    expect((await teamIdentity())?.id).toBe("u1");
    expect(calls).toBe(1);
    window.dispatchEvent(new Event("canopy:account-changed"));
    expect(peekTeamIdentity()).toBeNull();
    expect((await teamIdentity())?.id).toBe("u2");
  });

  it("is null when signed out or offline", async () => {
    setTeamIdentityFetchForTests(async () => {
      throw new Error("unauthorized");
    });
    expect(await teamIdentity()).toBeNull();
  });

  it("matches by id, and by name only for records without one", () => {
    const me = { id: "u1", name: "Ana", email: "ana@example.test" };
    expect(isMe(me, { id: "u1", name: "Someone" })).toBe(true);
    expect(isMe(me, { id: "u2", name: "Ana" })).toBe(false);
    expect(isMe(me, { name: "ana" })).toBe(true);
    expect(isMe(null, { id: "u1" })).toBe(false);
  });

  it("stamps the signed-in member on the terminals it starts", async () => {
    const seen: Record<string, unknown>[] = [];
    mockCommands({ pty_spawn_argv: (args: Record<string, unknown>) => (seen.push(args), { id: 1 }) });
    await ptySpawnArgv({ argv: ["x"], env: [["A", "1"]] });
    expect(seen[0].env).toEqual([["A", "1"]]);
    setTeamIdentityFetchForTests(async () => ({ user: { id: "u9", name: "Ana", email: "a@example.test" } }));
    await teamIdentity();
    await ptySpawnArgv({ argv: ["x"], env: [["A", "1"]] });
    expect(seen[1].env).toEqual([["A", "1"], ["CANOPY_MEMBER", "u9"]]);
  });
});

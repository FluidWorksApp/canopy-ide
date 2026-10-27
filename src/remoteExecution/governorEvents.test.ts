import { describe, expect, it, vi } from "vitest";
import { pollGovernorEvents } from "./governorEvents";

describe("pollGovernorEvents", () => {
  it("replays the host's budget changes after the cursor and advances it", async () => {
    const native = vi.fn(async () => ({ cursor: 5, events: [{ kind: "state_changed", status: { id: 2, state: "awaiting_grant" } }] })) as never;
    const seen: unknown[] = [];
    expect(await pollGovernorEvents(native, 3, (e) => seen.push(e))).toBe(5);
    expect((native as unknown as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual(["terminal_governor_events", { cursor: 3 }]);
    expect(seen).toEqual([{ kind: "state_changed", status: { id: 2, state: "awaiting_grant" } }]);
  });

  it("stays quiet on an older host and reports other failures", async () => {
    const old = vi.fn(async () => { throw Error("The Linux workspace does not support terminal_governor_events yet"); }) as never;
    expect(await pollGovernorEvents(old, null, () => {})).toBeNull();
    const down = vi.fn(async () => { throw Error("network"); }) as never;
    await expect(pollGovernorEvents(down, 1, () => {})).rejects.toThrow("network");
  });
});

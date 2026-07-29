import { describe, expect, it } from "vitest";
import { runIngest } from "./spotIndex";
import { mockCommands } from "./test/setup";

describe("runIngest", () => {
  it("loops while the backend has more to read and returns the last report", async () => {
    let calls = 0;
    mockCommands({
      spot_ingest: () => {
        calls += 1;
        return {
          more: calls < 3,
          pending: calls < 3 ? 100 : 0,
          messages: 5,
          terminals: 0,
          research: 0,
          pruned: 0,
        };
      },
    });
    const report = await runIngest(["/repo"], 8);
    expect(calls).toBe(3);
    expect(report?.pending).toBe(0);
  });

  it("shares one run between concurrent callers", async () => {
    // The background job, the palette opening and the Settings button all mean
    // the same thing; two at once would split one read budget over two sets of
    // reads and leave both reporting half the picture.
    let calls = 0;
    mockCommands({
      spot_ingest: () => {
        calls += 1;
        return {
          more: false,
          pending: 42,
          messages: 0,
          terminals: 0,
          research: 0,
          pruned: 0,
        };
      },
    });
    const [a, b] = await Promise.all([
      runIngest(["/repo"], 8),
      runIngest(["/other"], 8),
    ]);
    expect(calls).toBe(1);
    expect(a?.pending).toBe(42);
    expect(b).toBe(a);
    // And the guard clears: a later call runs for real.
    await runIngest(["/repo"], 8);
    expect(calls).toBe(2);
  });
});

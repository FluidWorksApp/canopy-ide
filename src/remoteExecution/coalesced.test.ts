import { expect, it, vi } from "vitest";
import { coalesced } from "./coalesced";
it("coalesces a stalled resize storm to one latest geometry", async () => {
  let finish!: () => void;
  const send = vi.fn((_value: number) => new Promise<void>(resolve => { finish = resolve; }));
  const queue = coalesced(send);
  for (let i = 0; i < 10_000; i++) queue.push(i);
  expect(send).toHaveBeenCalledTimes(1);
  finish(); await Promise.resolve(); await Promise.resolve();
  expect(send.mock.calls).toEqual([[0], [9999]]);
  queue.stop(); finish(); await Promise.resolve();
  queue.push(10_000); expect(send).toHaveBeenCalledTimes(2);
});

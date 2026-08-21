import { expect, it, vi } from "vitest";
import { mockCommands } from "./test/setup";
import { onPtyExit, ptyRendererRegister, type PtyExit } from "./ipc";

it("pulls each native PTY exit once and replays it to a later subscriber", async () => {
  let pulls = 0;
  const exited: PtyExit = {
    id: 41,
    session_generation: 9,
    exit_code: 0,
    requested: false,
  };
  mockCommands({
    pty_renderer_register: () => ({ generation: 7, sessions: [] }),
    pty_renderer_exits: ({ after }) => {
      pulls += 1;
      return after === 0
        ? { cursor: 1, exits: [exited] }
        : { cursor: 1, exits: [] };
    },
  });
  await ptyRendererRegister();

  const first: PtyExit[] = [];
  const stopFirst = await onPtyExit((event) => first.push(event));
  await vi.waitFor(() => expect(first).toEqual([exited]));
  stopFirst();

  const replayed: PtyExit[] = [];
  const stopSecond = await onPtyExit((event) => replayed.push(event));
  expect(replayed).toEqual([exited]);
  stopSecond();
  expect(pulls).toBeGreaterThanOrEqual(1);
});

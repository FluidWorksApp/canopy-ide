import { expect, it, vi } from "vitest";
import { mockCommands } from "./test/setup";
import {
  onPtyExit,
  onPtySpawned,
  ptyRendererRegister,
  type PtyExit,
  type PtySpawned,
} from "./ipc";

it("pulls each native PTY exit once and replays it to a later subscriber", async () => {
  let pulls = 0;
  const exited: PtyExit = {
    id: 41,
    session_generation: 9,
    exit_code: 0,
    requested: false,
  };
  const spawned: PtySpawned = {
    id: 42,
    session_generation: 10,
    cwd: "/work",
    title: "remote",
    cols: 80,
    rows: 24,
  };
  mockCommands({
    pty_renderer_register: () => ({ generation: 7, sessions: [] }),
    pty_renderer_events: ({ exitAfter }: { exitAfter?: unknown }) => {
      pulls += 1;
      return exitAfter === 0
        ? { exit_cursor: 1, exits: [exited], spawn_cursor: 1, spawns: [spawned] }
        : { exit_cursor: 1, exits: [], spawn_cursor: 1, spawns: [] };
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

  const replayedSpawns: PtySpawned[] = [];
  const stopSpawns = await onPtySpawned((event) => replayedSpawns.push(event));
  expect(replayedSpawns).toEqual([spawned]);
  stopSpawns();
  expect(pulls).toBeGreaterThanOrEqual(1);
});

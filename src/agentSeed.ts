// How much of a brief can be typed at a shell prompt, and what to do with the
// rest of it.
//
// A new agent is started by typing its command into a freshly spawned shell —
// `claude '<the whole brief>'` followed by a carriage return (Term.tsx, and
// spawn_headless for the remote path). That works until the line gets long,
// and then it fails in the worst way available: silently, and only past a
// certain size.
//
// The terminal is still in canonical mode at that moment — the shell's line
// editor has not taken over yet — and a canonical-mode tty discards everything
// past MAX_CANON on a single line. MAX_CANON is 1024 on Darwin. So a brief that
// crosses 1024 BYTES arrives at the shell cut mid-word, which for a
// single-quoted command means the closing quote is gone: the shell sits at a
// `quote>` continuation prompt, the agent never starts, and nothing anywhere
// reports an error, because from our side the write succeeded.
//
// Four screenshots with their paths and notes is about 1200 bytes, so this is
// reachable by simply using the feature.
//
// The fix is not to type less — a brief that has been trimmed to fit is a brief
// that has lost the thing it was about. It is to stop putting long text on the
// command line at all: write it to a file and start the agent pointed at the
// file, which is what the screenshots themselves already do.

import * as ipc from "./ipc";
import { AGENT_CLIS, startCommand, type AgentCli } from "./projects";
import { getSettings } from "./settings";

/**
 * Which CLI a launch runs on.
 *
 * One answer for every launcher — a ticket, a PR, a diff surface, a micro-task
 * — because the question is the same one each time and a second copy of it is
 * where a preference quietly stops being honoured. The micro-task launcher used
 * to put `claude` ahead of the setting on the grounds that it was the only CLI
 * Canopy registered the MCP bridge with; that has not been true since the
 * bridge learned codex, opencode, aider, agy and amp, and the launcher already
 * decides detached-vs-tab from the CLI's actual `mcp === "ours"` health rather
 * than from its name. So the name-check bought nothing and cost the user the
 * setting they had just changed: Settings said OpenCode, every task and every
 * review still started Claude.
 *
 * `requested` is the CLI a caller was explicitly told to use — the agent picked
 * from a split-button's menu, the one recorded on a re-run. It wins outright,
 * including over the default, and is looked up in the whole registry rather
 * than in what's installed: a caller naming a CLI that isn't here should get
 * "Unknown agent", not a silent substitution.
 *
 * Otherwise: the user's default agent if it is installed on this machine, else
 * the first CLI that is. Falling through to the registry — the default again,
 * then its first entry — only when nothing at all is detected, so the choice
 * never silently endorses a vendor that isn't even present.
 */
export function pickLaunchCli(
  requested: string | undefined,
  installed: (bin: string) => boolean,
): AgentCli | undefined {
  if (requested) return AGENT_CLIS.find((c) => c.id === requested);
  const here = AGENT_CLIS.filter((c) => installed(c.bin));
  const preferred = getSettings().defaultAgent;
  return (
    here.find((c) => c.id === preferred) ??
    here[0] ??
    AGENT_CLIS.find((c) => c.id === preferred) ??
    AGENT_CLIS[0]
  );
}

/** Darwin's MAX_CANON: the most a canonical-mode tty will hold for one line
 *  before it starts dropping. Linux allows 4096; the smaller number is the one
 *  that has to hold. */
export const MAX_CANON = 1024;

/** What we allow ourselves of it. The shell echoes as it reads and the CR is
 *  written separately, so aiming at the exact ceiling would be betting on the
 *  boundary — and the cost of being under it is one file write. */
export const SAFE_LINE_BYTES = 900;

/** Bytes, not characters. The brief that first hit this was 1012 characters and
 *  1024 bytes: em-dashes and arrows are three bytes each, so a length check in
 *  characters would have called it safe. */
export const byteLength = (s: string): number => new TextEncoder().encode(s).length;

/** Can this command line be typed at a shell prompt and arrive whole? */
export function fitsOnOneLine(command: string): boolean {
  return byteLength(command) + 1 <= SAFE_LINE_BYTES;
}

/** The command line to use instead, when it can't. The brief is on disk; this
 *  is the sentence that sends the agent to it.
 *
 *  Deliberately imperative and self-contained: it is the entire prompt the
 *  agent receives, so it has to say what the file is as well as where. */
export function briefPointer(path: string): string {
  return (
    `Read ${path} — a brief written for you, in full — and do everything it asks. ` +
    `It names the files to look at and the change to make.`
  );
}

/** How to start `agentId` on `seed`, with a brief too long to type parked in a
 *  file first.
 *
 *  Every caller that starts an agent goes through here rather than through
 *  `startCommand` directly. There are four of them — a ticket, a PR, a diff
 *  surface, a micro-task — and each builds its brief from something with no
 *  length limit: a ticket body, a review, four screenshots and their notes. A
 *  guard at one of them is a guard at the one that happened to be reported.
 *
 *  `dir` is where the brief is parked. It only has to be somewhere the agent
 *  can read — the pointer is an absolute path — so a launch that ends up in a
 *  worktree can still park in the repo it came from.
 *
 *  Never fails: a brief that cannot be written falls back to the command that
 *  would have been typed anyway. That is the old behaviour, which is wrong in
 *  a way we now understand, rather than no agent at all. */
export async function startCommandParked(
  agentId: string,
  seed: string,
  dir: string,
): Promise<{ command: string; typePrompt: boolean } | null> {
  const start = startCommand(agentId, seed);
  // typePrompt means the CLI takes no prompt argument: it launches bare and the
  // text is typed into its TUI once it is up, which is raw mode and has no such
  // limit. Only a prompt that has to survive the SHELL is at risk here.
  if (!start || start.typePrompt || fitsOnOneLine(start.command)) return start;
  try {
    const path = await ipc.spotSaveContextText(dir, seed);
    return startCommand(agentId, briefPointer(path)) ?? start;
  } catch (err) {
    void ipc.jsLog("warn", `agent: could not park a ${byteLength(seed)}-byte brief: ${String(err)}`);
    return start;
  }
}

// What SpotSearch's persistent index is allowed to hold, and where each part
// of it comes from.
//
// One list, read by two places that must never disagree: Settings → SpotSearch
// renders it, and the palette turns the user's choices into the ingest call.
// The backend (stores.rs) is the authority on what it can actually parse; this
// is the same set spelled for a human, and a mismatch shows up as an entry that
// never reports any messages.
import { getSettings } from "./settings";
import * as ipc from "./ipc";

export interface IndexableAgent {
  /** Registry id, as used by projects.ts and by stores.rs. */
  id: string;
  label: string;
  /** Where it keeps its conversations, in the shortest form that is still
   *  checkable by hand — this is the answer to "what exactly are you reading". */
  store: string;
  /** Anything surprising about reading it. */
  note?: string;
}

/** Every CLI whose own on-disk store Canopy can read. Amp is deliberately
 *  absent: its threads live on Sourcegraph's servers, so there is nothing on
 *  this machine to index. */
export const INDEXABLE_AGENTS: IndexableAgent[] = [
  {
    id: "claude",
    label: "Claude Code",
    store: "~/.claude/projects/**/*.jsonl",
  },
  {
    id: "codex",
    label: "Codex CLI",
    store: "~/.codex/sessions/**/rollout-*.jsonl",
  },
  {
    id: "omp",
    label: "oh-my-pi",
    store: "~/.omp/agent/sessions/**/*.jsonl",
    note: "Sub-agent transcripts are indexed under the conversation that spawned them.",
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    store: "~/.gemini/tmp/<project>/chats/*.json",
    note: "Filed under a hash of the project path, so only projects open in Canopy can be found.",
  },
  {
    id: "agy",
    label: "Antigravity CLI",
    store: "~/.gemini/antigravity-cli/conversations/*.db",
    note: "Stored as protobuf; the text is recovered from the blobs, so snippets can read roughly.",
  },
  {
    id: "opencode",
    label: "OpenCode",
    store: "~/.local/share/opencode/opencode.db",
  },
  {
    id: "aider",
    label: "Aider",
    store: "<project>/.aider.chat.history.md",
    note: "No session ids: a hit opens the history file itself.",
  },
];

/** The ingest call for the user's current choices. Kept here so the palette and
 *  the Settings screen's "Reindex now" build exactly the same request. */
export function ingestOptions(roots: string[]): ipc.SpotIngestOptions {
  const s = getSettings();
  return {
    agents: INDEXABLE_AGENTS.filter((a) => !s.spotDisabledAgents.includes(a.id)).map(
      (a) => a.id,
    ),
    terminals: s.spotIndexTerminals,
    roots,
    retentionDays: s.spotRetentionDays,
  };
}

/** Bring the index up to date, looping while the backend reports more to read.
 *  Bounded so a cold index can't hold its caller hostage.
 *
 *  Returns the last report, whose `pending` is how much transcript is still
 *  unread — a machine with years of history needs many of these before the
 *  index stops growing, and a caller that shows a message count without that
 *  number is showing a number that climbs for no visible reason. */
export async function runIngest(
  roots: string[],
  passes = 8,
): Promise<ipc.SpotIngestReport | null> {
  // One run at a time, shared by whoever asks while it is going: the
  // background job (spotIndexJob.ts), the palette opening, and the Settings
  // button all mean the same thing by "bring the index up to date", and two of
  // them at once would just split one budget over two sets of reads. A joiner
  // gets the running call's roots, which is only ever a difference in the
  // per-project stores, and the next pass is along shortly.
  if (inFlight) return inFlight;
  inFlight = ingestPasses(roots, passes).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

let inFlight: Promise<ipc.SpotIngestReport | null> | null = null;

async function ingestPasses(
  roots: string[],
  passes: number,
): Promise<ipc.SpotIngestReport | null> {
  const opts = ingestOptions(roots);
  let last: ipc.SpotIngestReport | null = null;
  for (let i = 0; i < passes; i++) {
    last = await ipc.spotIngest(opts).catch(() => null);
    if (!last?.more) return last;
  }
  return last;
}

/** "1.2 MB" — the index's size is the one number that makes it real. */
export function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

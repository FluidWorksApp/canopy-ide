// Fetch everything a session document is assembled from. Every source is
// optional and every failure is swallowed into "not available": a hookless CLI
// has no journal, a cloud workspace has no turn timeline, a past session's
// checkout may have been deleted. The document says what it could not see
// (`missing`) instead of failing to open.

import * as ipc from "../ipc";
import { queryLedger, type LedgerEntry } from "../ledger";
import { aboutSession, assembleSessionDoc, type SessionDocument, type TranscriptMessage } from "./assemble";

export interface SessionDocSource {
  sessionId: string;
  agent: string;
  cwd: string;
  repo?: string | null;
  digest?: ipc.SessionDigest;
  live?: boolean;
}

export interface LoadedSessionDoc {
  doc: SessionDocument;
  digest?: ipc.SessionDigest;
  /** Which sources could not be read, in plain words. */
  missing: string[];
}

/** The injectable lookups — real IPC by default, fixtures in tests. */
export interface SessionDocDeps {
  digests(roots: string[]): Promise<ipc.SessionDigest[]>;
  turns(cwd: string, sessionId: string): Promise<ipc.TurnList>;
  edits(repo: string | null, sessionId: string): Promise<ipc.AgentEdit[]>;
  ledger(root: string, q: Parameters<typeof queryLedger>[1]): Promise<LedgerEntry[]>;
  provenance(sessionId: string): Promise<ipc.ProvenanceEdge[]>;
  transcript(args: Parameters<typeof ipc.sessionTranscriptTail>[0]): Promise<TranscriptMessage[]>;
}

export const ipcSessionDocDeps: SessionDocDeps = {
  digests: (roots) => ipc.sessionDigests(roots),
  turns: (cwd, sid) => ipc.turnList(cwd, sid),
  edits: (repo, sid) => ipc.agentEdits(repo, sid),
  ledger: (root, q) => queryLedger(root, q),
  provenance: (sid) => ipc.provenanceForSession(sid),
  transcript: (args) => ipc.sessionTranscriptTail(args),
};

/** How much of the transcript's end to read: enough for the last several
 *  turns of conversation, bounded so a huge session stays cheap to open. */
const TRANSCRIPT_BYTES = 512 * 1024;

export async function loadSessionDoc(
  src: SessionDocSource,
  deps: SessionDocDeps = ipcSessionDocDeps,
): Promise<LoadedSessionDoc> {
  const missing: string[] = [];
  const soft = <T,>(what: string, p: Promise<T>, empty: T): Promise<T> =>
    p.catch(() => {
      missing.push(what);
      return empty;
    });

  const digest =
    src.digest ??
    (await soft("session record", deps.digests([src.cwd]), [] as ipc.SessionDigest[])).find(
      (d) => d.session_id === src.sessionId,
    );
  const cwd = src.cwd || digest?.resume_cwd || digest?.cwd || "";
  const repo = src.repo ?? null;

  // The ledger is queried twice: what was filed against the session itself,
  // and the recent receipts/plans/notes that point at one of its turns or
  // were written by it (siblings choose their own `ref`).
  const [turns, edits, bySession, recent, provenance, transcript] = await Promise.all([
    soft("turn timeline", deps.turns(cwd, src.sessionId), null as ipc.TurnList | null),
    soft("edit journal", deps.edits(repo ?? cwd, src.sessionId), [] as ipc.AgentEdit[]),
    soft("ledger", deps.ledger(cwd, { refKind: "session", refId: src.sessionId, limit: 500 }), [] as LedgerEntry[]),
    soft(
      "ledger",
      deps.ledger(cwd, { kinds: ["receipt", "plan", "memory", "awareness", "handoff"], limit: 1000 }),
      [] as LedgerEntry[],
    ),
    soft("pull request links", deps.provenance(src.sessionId), [] as ipc.ProvenanceEdge[]),
    soft(
      "transcript",
      deps.transcript({
        sessionId: src.sessionId,
        agent: src.agent,
        roots: [cwd, ...(repo && repo !== cwd ? [repo] : [])].filter(Boolean),
        profile: digest?.profile ?? null,
        maxBytes: TRANSCRIPT_BYTES,
      }),
      [] as TranscriptMessage[],
    ),
  ]);

  const seen = new Set<string>();
  const ledger = [...bySession, ...recent].filter((e) => {
    if (seen.has(e.id) || !aboutSession(e, src.sessionId)) return false;
    seen.add(e.id);
    return true;
  });

  const doc = assembleSessionDoc({
    sessionId: src.sessionId,
    agent: src.agent,
    cwd,
    digest,
    turns,
    edits,
    ledger,
    provenance,
    transcript,
    live: src.live,
  });
  return { doc, digest, missing: [...new Set(missing)] };
}

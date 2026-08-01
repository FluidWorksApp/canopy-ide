// What this project's agent sessions are, for every surface that shows them.
//
// The side panel and the agents page answer the same four questions — what is
// running, which conversation is in which terminal, what can be brought back,
// and what other agents have claimed — and they used to answer them from two
// copies of the same effects. One copy is enough: a page that disagreed with
// the panel beside it about which sessions exist would be worse than either.
//
// Deliberately not here: auto-hibernation. That acts on the machine rather than
// describing it, and two mounted surfaces running it would pick victims twice.
// It stays in AgentsPanel, which is always mounted.
import { useCallback, useEffect, useMemo, useState } from "react";
import * as ipc from "./ipc";
import { identifyAgent, observeForLearning, type AgentIdentity } from "./agentIdentity";
import { POLICY, agentLife } from "../shared/agentLife";
import type { Life } from "../shared/agentLife";
import { ptyEvidenceFor, useFirstSeen } from "./agentLifeStore";
import { DIGEST_FALLBACK_MS, subscribeSessionDigests } from "./sessionDigests";
import { forgetSessions, restorableFrom } from "./restorable";

/** Last thing the *human* typed. Hooks also record injected payloads
    (`<task-notification>…`, shared-context blocks) as prompts; an XML-ish
    blob identifies nothing, so skip anything that opens with a tag. */
export const lastHumanPrompt = (prompts?: string[]) =>
  [...(prompts ?? [])]
    .reverse()
    .find((p) => p.trim().length > 0 && !p.trimStart().startsWith("<"));

/** Pair each terminal (by the PTY `surface` id the hook recorded from our spawn
 *  env) with the newest digest tagged for this app launch — an exact identity,
 *  not a cwd/title guess. */
export function digestBySurface(
  digests: ipc.SessionDigest[],
  thisInstance: string | null,
): Map<string, ipc.SessionDigest> {
  const bySurface = new Map<string, ipc.SessionDigest>();
  for (const d of digests) {
    if (!d.surface) continue;
    // A PTY id is only unique within one app launch, but the sessions dir is
    // shared across instances and restarts — so a digest tagged with another
    // `instance` reused this id and must be skipped. Untagged digests are
    // pre-upgrade and fall back to surface-only.
    if (thisInstance && d.instance && d.instance !== thisInstance) continue;
    const prev = bySurface.get(d.surface);
    if (!prev || (d.updated ?? 0) > (prev.updated ?? 0)) bySurface.set(d.surface, d);
  }
  return bySurface;
}

/** One live terminal, and the agent conversation running in it. */
export interface SessionRow {
  session: ipc.SessionStats;
  /** What the pty has in the foreground, or null for a plain shell. */
  agent: AgentIdentity | null;
  digest?: ipc.SessionDigest;
  /** Last path segment of the cwd — what tells two `claude` rows apart. */
  dir: string;
}

export interface AgentSessions {
  /** Every digest on disk under these roots. Also the crash-restore record, so
   *  it is never filtered by the sharing toggle. */
  digests: ipc.SessionDigest[];
  /** One row per live terminal. */
  sessions: SessionRow[];
  /** Terminals with an agent in the foreground. */
  agentSessions: SessionRow[];
  /** Plain shells — a different question ("what's running in it?"). */
  termSessions: SessionRow[];
  /** Sessions with no live terminal, newest first: what a crash or a hibernate
   *  left behind, and what reopening resumes. */
  restorable: ReturnType<typeof restorableFrom>;
  /** Exactly what the hook would inject into other agents right now. */
  shared: ipc.SessionDigest[];
  /** Files agents have claimed in this checkout (canopy_claim). */
  claims: ipc.AgentClaim[];
  /** Drop a restorable row and everything it stands for: tombstone, backend
   *  delete, and the local list. */
  forget: (rows: ipc.SessionDigest[]) => void;
  /** The lifecycle verdict for one row, with the full evidence set — digest,
   *  pty stats, and the first-seen grace. One assembly here, so a panel and a
   *  page cannot feed the ladder different halves of the same evidence (the
   *  page used to omit `firstSeen`, which made `starting` unreachable there:
   *  a booting CLI read as `unknown` instead). */
  lifeOf: (row: SessionRow) => Life;
}

/**
 * Everything about this project's sessions, polled while `visible`.
 *
 * `visible` is what stops a surface nobody is looking at from polling digests
 * every four seconds — the panel passes "my tab is in front", the page passes
 * "this tab is active".
 */
export function useAgentSessions(opts: {
  visible: boolean;
  roots: string[];
  stats: ipc.SessionStats[];
  liveSessionIds: string[];
}): AgentSessions {
  const { visible, roots, stats, liveSessionIds } = opts;
  const [digests, setDigests] = useState<ipc.SessionDigest[]>([]);
  // This app launch's tag, so a digest from another instance/run (same reset-to-1
  // PTY id, same shared sessions dir) can't be paired with our terminals.
  const [thisInstance, setThisInstance] = useState<string | null>(null);
  useEffect(() => {
    void ipc.instanceId().then(setThisInstance).catch(() => {});
  }, []);

  const rootsKey = roots.join("\n");
  useEffect(() => {
    if (!visible) return;
    // Every directory a session names, not just the one it last reported from.
    // `cwd` drifts — an agent that cds, a session relocated into a worktree, a
    // resume that already ran somewhere else and whose hooks wrote that
    // directory back onto the digest — and filtering on it alone made the
    // session disappear from the panel it would have been resumed from.
    const inProject = (x: ipc.SessionDigest) =>
      [x.resume_cwd, x.launch_cwd, x.cwd].some(
        (dir) => !!dir && roots.some((r) => dir === r || dir.startsWith(r + "/")),
      );
    const load = () =>
      void ipc
        .sessionDigests(roots)
        .then((d) => setDigests(d.filter(inProject)))
        .catch(() => setDigests([]));
    load();
    // Event-driven, not polled: the change channel says when a digest moved.
    // The slow interval only covers store-only CLIs, whose digests change
    // with no hook event for the bridge to pulse on.
    const un = subscribeSessionDigests(load);
    const t = setInterval(load, DIGEST_FALLBACK_MS);
    return () => {
      un();
      clearInterval(t);
    };
  }, [rootsKey, visible]);

  // Claims other agents hold in this checkout, refreshed when one changes.
  const [claims, setClaims] = useState<ipc.AgentClaim[]>([]);
  useEffect(() => {
    if (!visible) return;
    const load = () => void ipc.contextClaims().then(setClaims).catch(() => {});
    load();
    let un: (() => void) | undefined;
    void ipc.onAgentClaims(load).then((u) => {
      un = u;
    });
    return () => un?.();
  }, [visible]);

  // What the hook would actually inject — mirrors peer_context in
  // canopy_hook.rs: no "ended" sessions, and none quiet for longer than
  // POLICY.peerMaxAgeSecs. A surface must apply the same rules or it claims
  // long-dead sessions are shared: a digest outlives its terminal (that's what
  // makes restore work), and one whose terminal died without a Stop event even
  // stays "active" on disk — the age cutoff is what ages those out.
  const shared = useMemo(
    () =>
      digests.filter(
        (d) =>
          d.state !== "ended" &&
          Date.now() / 1000 - (d.updated ?? 0) <= POLICY.peerMaxAgeSecs,
      ),
    [digests],
  );

  // Sessions that exist on disk but have no live terminal — what you lost when
  // the IDE or the machine died. One definition of "restorable", so no two
  // surfaces can disagree about what is offered.
  const restorable = useMemo(
    () => restorableFrom(digests, stats, liveSessionIds),
    [digests, stats, liveSessionIds.join(",")],
  );

  // Bumped when the hook stream teaches us a binary (see observeForLearning),
  // which is the one thing that can change an identity without stats moving.
  const [learnedTick, setLearnedTick] = useState(0);

  const sessions = useMemo(() => {
    // Terminal -> the agent conversation running in it, by the surface id the
    // hook recorded from our spawn env. An exact identity, not a guess: two
    // claudes in the same directory are indistinguishable by cwd, and matching
    // on titles or newest-file-by-mtime attaches to the wrong one silently.
    const bySurface = digestBySurface(digests, thisInstance);
    return stats.map((s) => {
      const digest = bySurface.get(String(s.id));
      return {
        session: s,
        agent: identifyAgent(s.agent_hint, digest),
        digest,
        dir: (s.cwd || "").split("/").filter(Boolean).pop() ?? "",
      };
    });
  }, [stats, digests, thisInstance, learnedTick]);

  // The hook stream names binaries nothing else can identify, so a CLI Canopy
  // has never heard of is recognised from its second launch onward. Derived,
  // never asked.
  useEffect(() => {
    if (observeForLearning(sessions.map((s) => ({ hint: s.session.agent_hint, digest: s.digest }))))
      setLearnedTick((n) => n + 1);
  }, [sessions]);

  const firstSeen = useFirstSeen(stats.map((s) => s.id));
  const lifeOf = useCallback(
    (row: SessionRow): Life =>
      agentLife({
        digest: (row.digest ?? null) as never,
        pty: ptyEvidenceFor(row.session, firstSeen.get(row.session.id)),
        now: Date.now() / 1000,
      }),
    [firstSeen],
  );

  const forget = (rows: ipc.SessionDigest[]) => {
    // Tombstone first: sessions read from a CLI's own on-disk store (omp)
    // aren't in ~/.canopy/sessions, so deleting that file can't stop them — the
    // next poll re-reads them from omp's dir and they come straight back. The
    // persistent forget is what restorableFrom actually filters on.
    forgetSessions(rows);
    for (const g of rows) void ipc.sessionForget(g.session_id).catch(() => {});
    const ids = new Set(rows.map((g) => g.session_id));
    setDigests((prev) => prev.filter((x) => !ids.has(x.session_id)));
  };

  return {
    digests,
    sessions,
    agentSessions: sessions.filter((x) => x.agent),
    termSessions: sessions.filter((x) => !x.agent),
    restorable,
    shared,
    claims,
    forget,
    lifeOf,
  };
}

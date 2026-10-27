// The compaction state machine behind ContextControls.tsx: ask → confirm →
// typed at an idle prompt, queued until the turn ends, or run headlessly —
// then proven by the transcript's own compaction record, not assumed.
import { useCallback, useEffect, useRef, useState } from "react";
import type * as ipc from "./ipc";
import { compactCommand, compactHeadless, compactPlan, type CompactPlan, type CompactScope } from "./contextCompaction";

/** How long a typed compaction may take to show up in the transcript. */
const SENT_TIMEOUT_MS = 3 * 60 * 1000;

export type CompactionPhase =
  | { phase: "idle" }
  | { phase: "confirming"; scope: CompactScope }
  | { phase: "queued"; command: string }
  | { phase: "sent"; baseline: number }
  | { phase: "running" }
  | { phase: "done"; pre: number | null; post: number | null }
  | { phase: "failed"; message: string };

export interface CompactionDeps {
  /** Type `text` at the session's terminal prompt and submit it. */
  type(text: string): void;
  headless: typeof compactHeadless;
}

export interface Compaction {
  supported: boolean;
  plan: CompactPlan;
  state: CompactionPhase;
  /** Ask to compact; shows the confirmation first. */
  ask(scope: CompactScope): void;
  confirm(note: string): void;
  cancel(): void;
}

/** The compaction state machine for one session. */
export function useCompaction(o: {
  agent: string;
  sessionId: string | undefined;
  cwd: string;
  /** A terminal here is running the session. */
  live: boolean;
  lifeState: string;
  remote: boolean;
  activity: ipc.SessionActivity | null;
  deps: CompactionDeps;
  /** Read the activity again (after sending). */
  refresh(): void;
}): Compaction {
  const [state, setState] = useState<CompactionPhase>({ phase: "idle" });
  const plan = compactPlan({ agent: o.agent, live: o.live, lifeState: o.lifeState, remote: o.remote });
  const supported = !!o.sessionId && compactCommand(o.agent, { kind: "all" }) !== null;
  const compactions = o.activity?.compactions.length ?? 0;
  const latest = useRef(o);
  latest.current = o;

  const deliver = useCallback((command: string) => {
    latest.current.deps.type(command);
    setState({ phase: "sent", baseline: latest.current.activity?.compactions.length ?? 0 });
    latest.current.refresh();
  }, []);

  const stateRef = useRef(state);
  stateRef.current = state;
  const confirm = useCallback(
    (note: string) => {
      const cur = stateRef.current;
      if (cur.phase !== "confirming") return;
      const o = latest.current;
      const scope = { ...cur.scope, note } as CompactScope;
      const command = compactCommand(o.agent, scope);
      const p = compactPlan({ agent: o.agent, live: o.live, lifeState: o.lifeState, remote: o.remote });
      if (!command || p.route === "unavailable") {
        setState({ phase: "failed", message: p.route === "unavailable" ? p.why : "Nothing to send." });
        return;
      }
      if (p.route === "terminal") return deliver(command);
      if (p.route === "wait") return setState({ phase: "queued", command });
      setState({ phase: "running" });
      void o.deps.headless({ agent: o.agent, sessionId: o.sessionId!, cwd: o.cwd, command }).then((r) => {
        setState(
          r.ok
            ? { phase: "done", pre: r.preTokens ?? null, post: r.postTokens ?? null }
            : { phase: "failed", message: r.message ?? "The compaction failed." },
        );
        latest.current.refresh();
      });
    },
    [deliver],
  );

  // A queued request goes out the moment the turn ends — and only then.
  useEffect(() => {
    if (state.phase !== "queued") return;
    if (o.live && o.lifeState === "idle") deliver(state.command);
    else if (!o.live || o.lifeState === "ended" || o.lifeState === "waiting") {
      setState({ phase: "failed", message: "Not sent: the agent stopped or is waiting for you. Try again." });
    }
  }, [state, o.live, o.lifeState, deliver]);

  // Typed, but the transcript never shows it happening (the agent didn't take
  // the command): say so rather than spin forever.
  useEffect(() => {
    if (state.phase !== "sent") return;
    const t = setTimeout(
      () => setState({ phase: "failed", message: "Nothing happened yet — the agent may not have taken the command. Try again." }),
      SENT_TIMEOUT_MS,
    );
    return () => clearTimeout(t);
  }, [state]);

  // Sent to a terminal: done when the transcript shows a new compaction.
  useEffect(() => {
    if (state.phase !== "sent" || compactions <= state.baseline) return;
    const c = o.activity!.compactions[compactions - 1];
    setState({ phase: "done", pre: c.pre_tokens, post: c.post_tokens });
  }, [state, compactions, o.activity]);

  return {
    supported,
    plan,
    state,
    ask: (scope) => setState({ phase: "confirming", scope }),
    confirm,
    cancel: () => setState({ phase: "idle" }),
  };
}
